package agent

// MiSpeL MP-39: the box's discharge command with protection limits.
//
// The cloud's plan carries, per bidirectional charge-point entity, a vehicle
// block (driver's consent, reserve, departure) and the feed-back wish as a
// negative setpoint_kw. This file runs the guard (internal/entladeschutz) on
// its own Takt next to the load management: it reads the station snapshot,
// the plan, the grid meter, the export limit and the § 14a envelope, decides
// per connector and sends the OCPP 2.1 V2X setpoint. A connector it feeds
// back from is reserved - ocppApply leaves it alone.
//
// MP-39b (captain's decision 04.10.2026: Aus, Schnell and a scene hold the
// feed-back): a Handeingriff on the charge - Lademodus „Aus“ (pause) or
// „Schnell“ (voll), from the portal or the :8484 button, both the same
// boostStore entry bound to the session - and the operator's „Automatik
// pausieren“ hold the feed-back in the very next Takt, not with the next
// plan (v2xHalt). A scene is cloud-only; it reaches the box with the plan
// (the optimizer drops the vehicle block = Freigabe aus).
//
// The loop runs only while Config.V2XEntladen is set (default off, no
// environment variable): a live release needs the hardware test bench MP-42
// and the captain's box release.

import (
	"context"
	"fmt"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entladeschutz"
)

// v2xLoop re-decides every bidirectional connector each entladeschutz.Takt.
func (a *Agent) v2xLoop(ctx context.Context) {
	defer a.done.Done()
	tick := time.NewTicker(entladeschutz.Takt)
	defer tick.Stop()
	for {
		a.v2xStep(ctx, time.Now().UTC())
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// v2xStep is one pass of the guard over every connector that is reserved or
// belongs to a plan entity with a vehicle block.
func (a *Agent) v2xStep(ctx context.Context, now time.Time) {
	rt := a.ocpp
	w := a.v2x
	if rt == nil || rt.srv == nil || w == nil {
		return
	}
	snap := rt.srv.Snapshot()
	a.arbMu.Lock()
	v2 := a.curPlan2
	a.arbMu.Unlock()
	entityOf := a.chargePointEntities()

	st := a.State.Get()
	basis := entladeschutz.Lage{Jetzt: now, Schalter: a.Cfg.V2XEntladen, CloudVerbunden: st.CloudConnected}
	if a.automationPausedAt(now) {
		basis.Halt = entladeschutz.GrundAutomatikPausiert
	}
	// The observed § 14a envelope as the last load-management pass published
	// it (read-only: the budget tracker itself belongs to ocppStep).
	if st.Ocpp != nil && st.Ocpp.Grid14aKw != nil {
		v := *st.Ocpp.Grid14aKw
		basis.Paragraph14aKw = &v
	}
	a.mu.Lock()
	if a.lastGridKw != nil {
		v := *a.lastGridKw
		basis.NetzKw, basis.NetzZeit = &v, a.lastReadingAt
	}
	if p := a.currentPlan; p != nil {
		basis.ExportgrenzeKw = p.ExportLimit()
	}
	a.mu.Unlock()

	done := map[entladeschutz.Steckplatz]bool{}
	for i := range snap.Chargers {
		c := &snap.Chargers[i]
		entityID := entityOf[c.ID]
		hatFahrzeug := false
		if v2 != nil {
			if pe := v2.Entity(entityID); pe != nil && pe.Fahrzeug != nil {
				hatFahrzeug = true
			}
		}
		vergeben := false
		for j := range c.Connectors {
			con := &c.Connectors[j]
			sp := entladeschutz.Steckplatz{ChargerID: c.ID, Connector: con.ID}
			if !hatFahrzeug && !w.Reserviert(sp.ChargerID, sp.Connector) {
				continue
			}
			l := basis
			entladeschutz.SaeuleEintragen(&l, c, con)
			if l.Halt == "" {
				l.Halt = v2xHalt(rt, c.ID, con, now)
			}
			if hatFahrzeug {
				entladeschutz.PlanEintragen(&l, v2, entityID)
			}
			if vergeben {
				l.WunschKw = 0 // one wish per entity: the first plugged connector takes it
			}
			if e := w.Schritt(ctx, rt.srv, sp, l); e.EntladenKw > 0 || l.Angesteckt && l.WunschKw > 0 {
				vergeben = true
			}
			done[sp] = true
		}
	}
	// A reserved connector that vanished from the snapshot (station removed):
	// decide it as gone - releases without sending.
	for _, sp := range w.Reservierte() {
		if !done[sp] {
			w.Schritt(ctx, rt.srv, sp, basis)
		}
	}
}

// v2xHalt names the Handeingriff that runs on the connector's session now:
// Lademodus „Aus“ (pause) or „Schnell“ (voll) - exactly the override the load
// management applies (ocppApplyBoosts), so the guard and the executor never
// disagree about which charge is held. "" = none, or no session.
func v2xHalt(rt *ocppRuntime, chargerID string, con *csms.Connector, now time.Time) string {
	if rt == nil || rt.boosts == nil || con == nil || con.Session == nil {
		return ""
	}
	aktiv, pause := rt.boosts.haelt(chargerID+"#"+fmt.Sprint(con.ID), con.Session.TransactionID, now)
	switch {
	case !aktiv:
		return ""
	case pause:
		return entladeschutz.GrundLademodusAus
	default:
		return entladeschutz.GrundLademodusSchnell
	}
}

// v2xReserviert reports whether the discharge guard owns the connector's
// profile right now (ocppApply must not overwrite it).
func (a *Agent) v2xReserviert(chargerID string, connector int) bool {
	return a.v2x != nil && a.v2x.Reserviert(chargerID, connector)
}

// v2xWake asks the load management for an immediate pass after the guard
// released a connector: the vehicle gets its charging profile back at once.
func (rt *ocppRuntime) v2xWake() {
	select {
	case rt.wake <- struct{}{}:
	default:
	}
}

var _ entladeschutz.Sender = (*csms.Server)(nil)
