package agent

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

// Der Herzschlag folgt einem Ladepunkt sofort, wenn sich an ihm etwas
// SICHTBARES ändert (Anstecken, Ladebeginn, erste Leistung, Abstecken), statt
// bis zu 15 s auf den nächsten Takt zu warten.
//
// Der Takt selbst bleibt, und ein laufender Ladevorgang, dessen Messwert sich
// nur bewegt, löst NICHTS aus: der Wächter vergleicht einen Fingerabdruck aus
// Wörtern (Status, Sitzung, gemessen ja/nein, zieht ja/nein), keine Zahlen.
// Zwischen zwei Herzschlägen liegen mindestens statusKickMinGap; ein Wechsel
// in dieser Zeit wird gesammelt und am Ende der Frist gesendet. Mehr als ein
// zusätzlicher Herzschlag je statusKickMinGap ist damit ausgeschlossen, auch
// wenn eine Säule flattert.
//
// Reine Sichtbarkeit: der Wächter spricht mit keiner Säule und ändert keine
// Zuteilung.

const (
	// statusHeartbeatEvery is the regular status cadence (unchanged).
	statusHeartbeatEvery = 15 * time.Second
	// statusKickMinGap is the least time between two status heartbeats when a
	// charge point change asks for an early one.
	statusKickMinGap = 5 * time.Second
	// ocppDrawingKw is the draw from which a connector counts as drawing - the
	// portal's own threshold (`ladepunkte.ts`, `power > 0.05`).
	ocppDrawingKw = 0.05
)

// statusKick is the coalescing request for an early status heartbeat.
func (a *Agent) statusKick() chan struct{} {
	a.statusKickOnce.Do(func() { a.statusKickCh = make(chan struct{}, 1) })
	return a.statusKickCh
}

func (a *Agent) requestStatusHeartbeat() {
	select {
	case a.statusKick() <- struct{}{}:
	default:
	}
}

// ocppStatusFingerprint is what a surface shows about the charge points, in
// words: a change here is one a customer can see. Power VALUES are left out on
// purpose - a running charge reports a new one every few seconds, and the
// regular cadence carries those.
func ocppStatusFingerprint(snap csms.Snapshot) string {
	parts := make([]string, 0, len(snap.Chargers))
	for _, c := range snap.Chargers {
		var b strings.Builder
		fmt.Fprintf(&b, "%s|%t", c.ID, c.Connected)
		cons := append([]csms.Connector(nil), c.Connectors...)
		sort.Slice(cons, func(i, j int) bool { return cons[i].ID < cons[j].ID })
		for _, con := range cons {
			measured := con.PowerKw != nil
			drawing := measured && *con.PowerKw > ocppDrawingKw
			fmt.Fprintf(&b, "|%d:%s:%t:%t:%t", con.ID, con.Status, con.Session != nil, measured, drawing)
		}
		parts = append(parts, b.String())
	}
	sort.Strings(parts)
	return strings.Join(parts, "\n")
}

// ocppStatusWatch asks for an early heartbeat whenever the fingerprint moves.
// The first look only sets the baseline: a box that starts asks for nothing.
func (a *Agent) ocppStatusWatch(ctx context.Context, srv *csms.Server) {
	defer a.done.Done()
	last := ocppStatusFingerprint(srv.Snapshot())
	for {
		select {
		case <-ctx.Done():
			return
		case <-srv.Observed():
		}
		if fp := ocppStatusFingerprint(srv.Snapshot()); fp != last {
			last = fp
			a.requestStatusHeartbeat()
		}
	}
}

// statusHeartbeatLoop publishes on the regular cadence and, between ticks, on
// request - never two heartbeats closer than minGap. An early heartbeat
// restarts the cadence, so it adds to the traffic only when something changed.
func statusHeartbeatLoop(ctx context.Context, every, minGap time.Duration, kick <-chan struct{}, publish func() bool) {
	t := time.NewTicker(every)
	defer t.Stop()
	var last time.Time
	var pending *time.Timer
	var due <-chan time.Time
	defer func() {
		if pending != nil {
			pending.Stop()
		}
	}()
	send := func() {
		if publish() {
			last = time.Now()
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			send()
		case <-kick:
			if due != nil {
				continue // already collected, goes out when the gap ends
			}
			if wait := minGap - time.Since(last); !last.IsZero() && wait > 0 {
				pending = time.NewTimer(wait)
				due = pending.C
				continue
			}
			send()
			t.Reset(every)
		case <-due:
			pending, due = nil, nil
			send()
			t.Reset(every)
		}
	}
}
