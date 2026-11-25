package agent

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// The direct-marketing DELIVERY on the agent (vp-direktvermarktung-konzept d2
// §5.7 "Zustellung", contract docs/contracts/v2/direktvermarktung-zustellung.md):
//
//   - the retained profile on .../v2/direktvermarktung is consumed here and
//     persisted (controlcert pattern: a box that boots offline keeps the
//     connection it legitimately had);
//   - the access is asked for with the fingerprint the box does NOT hold yet,
//     stored 0600 by internal/direktvermarkter.Ablage, and acknowledged;
//   - the heartbeat carries the additive block "direktvermarktung".
//
// OpenVPN, the firewall zone and the feed-in limit are Stage 2 (Mango) /
// Stage 4 (PFC200); they attach through Anschluss.SetzeTunnel / Server /
// SetValues. NOTHING in this file ever logs key material - the only loggable
// identifier is the fingerprint.

// dvAnfrageAbstand bounds how often the box re-asks for a missing access
// while the link stays up (the retained redelivery already re-asks on every
// reconnect; this covers a cloud that missed the request).
const dvAnfrageAbstand = 10 * time.Minute

// direktvermarkterDir is the per-box-kind access store (§5.7 "Zustellung"):
// Mango in /etc (root-only flash, the tunnel must start with the system),
// PFC200 in the voltpilot home (Stage 4's root helper vp-vermarkter makes the
// root copy the firmware OpenVPN needs), Docker box under its data dir.
func (a *Agent) direktvermarkterDir() string {
	if a.dvDir != "" {
		return a.dvDir
	}
	switch a.Cfg.BoxArt {
	case geraetesuche.BoxArtEdgeLight:
		return "/etc/vp-edge-light/vermarkter"
	case geraetesuche.BoxArtEdgeIndustrie:
		return "/home/voltpilot/vermarkter"
	default:
		return filepath.Join(a.Cfg.DataDir, "vermarkter")
	}
}

// direktvermarktung returns the connection state, building it on first use.
// Every recorded event asks for an early heartbeat, so the cloud sees a
// watchdog expiry or a new set-point within seconds, not at the next tick.
func (a *Agent) direktvermarktung() *direktvermarkter.Anschluss {
	a.dvMu.Lock()
	defer a.dvMu.Unlock()
	if a.dv == nil {
		a.dv = direktvermarkter.NewAnschluss(direktvermarkter.Ablage{Dir: a.direktvermarkterDir()},
			func(direktvermarkter.Event) { a.requestStatusHeartbeat() })
	}
	return a.dv
}

// loadDirektvermarktung restores the persisted profile at boot.
func (a *Agent) loadDirektvermarktung() {
	a.direktvermarktung().Boot()
}

// onDirektvermarktung consumes the retained profile document - on every
// (re)connect and on every change. An EMPTY payload is the retained-clear:
// the box deletes access and profile and acknowledges "geloescht" (the box
// swap waits for exactly that acknowledgement before the new box receives).
func (a *Agent) onDirektvermarktung(payload []byte) {
	doc, err := direktvermarkter.ParseProfilDokument(payload)
	if err != nil {
		slog.Warn("direktvermarktung: Profil verworfen", "err", err)
		return
	}
	dv := a.direktvermarktung()
	if doc == nil {
		geloescht, err := dv.Zuruecknehmen()
		if err != nil {
			// The deletion did not happen - do NOT acknowledge it. The
			// retained clear stays on the broker and is redelivered on the
			// next reconnect, so the deletion is tried again.
			slog.Warn("direktvermarktung: Ruecknahme fehlgeschlagen", "err", err)
			return
		}
		slog.Info("direktvermarktung: Profil zurueckgezogen (retained clear)")
		if geloescht != "" {
			a.sendeDvQuittung(geloescht, direktvermarkter.QuittungGeloescht)
		}
		a.requestStatusHeartbeat()
		return
	}
	// Topic identity == payload identity, the rule of every v2 downlink. The
	// link only subscribes its OWN topic, so a mismatch is a misaddressed
	// publish - never something to act on.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID != "" && !doc.BelongsTo(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("direktvermarktung: fremde Identitaet im Profil - verworfen", "device_id", doc.DeviceID)
		return
	}
	zugangNoetig, geloescht, err := dv.UebernimmProfil(doc, payload)
	if err != nil {
		slog.Warn("direktvermarktung: Profil nicht uebernommen", "err", err)
		return
	}
	slog.Info("direktvermarktung: Profil uebernommen", "partner", doc.Partner, "revision", doc.Revision)
	if geloescht != "" {
		// The profile names a DIFFERENT access: the old one is gone, say so.
		a.sendeDvQuittung(geloescht, direktvermarkter.QuittungGeloescht)
	}
	if zugangNoetig {
		a.sendeDvAnfrage(doc.ZugangFingerabdruck)
	} else {
		// Redelivery with the access already stored: confirm idempotently, so
		// the cloud's zugestellt_am survives a lost first acknowledgement.
		a.sendeDvQuittung(doc.ZugangFingerabdruck, direktvermarkter.QuittungZugestellt)
	}
	a.requestStatusHeartbeat()
}

// onDirektvermarktungZugang consumes the one-time access answer.
func (a *Agent) onDirektvermarktungZugang(payload []byte) {
	z, err := direktvermarkter.ParseZugangAntwort(payload)
	if err != nil {
		// The error never carries content, only which part was missing.
		slog.Warn("direktvermarktung: Zugang verworfen", "err", err)
		return
	}
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID != "" && !z.BelongsTo(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("direktvermarktung: fremde Identitaet im Zugang - verworfen", "device_id", z.DeviceID)
		return
	}
	if err := a.direktvermarktung().UebernimmZugang(z); err != nil {
		slog.Warn("direktvermarktung: Zugang nicht gespeichert", "err", err)
		return
	}
	slog.Info("direktvermarktung: Zugang gespeichert", "partner", z.Partner,
		"fingerabdruck", z.ZugangFingerabdruck)
	a.sendeDvQuittung(z.ZugangFingerabdruck, direktvermarkter.QuittungZugestellt)
	a.requestStatusHeartbeat()
}

func (a *Agent) sendeDvAnfrage(fingerabdruck string) {
	a.dvMu.Lock()
	a.dvLetzteAnfrage = time.Now()
	a.dvMu.Unlock()
	if err := a.publishDv(func(link *cloud.Link) error {
		return link.PublishDirektvermarktungAnfrage(direktvermarkter.NeueAnfrage(fingerabdruck, time.Now()))
	}); err != nil {
		slog.Warn("direktvermarktung: Zugangs-Anfrage nicht gesendet", "err", err)
	}
}

func (a *Agent) sendeDvQuittung(fingerabdruck, ereignis string) {
	if err := a.publishDv(func(link *cloud.Link) error {
		return link.PublishDirektvermarktungQuittung(direktvermarkter.NeueQuittung(fingerabdruck, ereignis, time.Now()))
	}); err != nil {
		slog.Warn("direktvermarktung: Quittung nicht gesendet", "ereignis", ereignis, "err", err)
	}
}

func (a *Agent) publishDv(send func(*cloud.Link) error) error {
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return fmt.Errorf("no cloud link")
	}
	return send(link)
}

// dvNachfassen re-asks for a still-missing access at most every
// dvAnfrageAbstand. Called from the heartbeat tick - the one place that
// already runs exactly while the link is up.
func (a *Agent) dvNachfassen() {
	a.dvMu.Lock()
	dv := a.dv
	letzte := a.dvLetzteAnfrage
	a.dvMu.Unlock()
	if dv == nil {
		return
	}
	fingerabdruck, vorhanden := dv.ErwarteterZugang()
	if fingerabdruck == "" || vorhanden {
		return
	}
	if !letzte.IsZero() && time.Since(letzte) < dvAnfrageAbstand {
		return
	}
	a.sendeDvAnfrage(fingerabdruck)
}

// dvSummary is the heartbeat block (nil = no connection delivered). It also
// derives the queries-per-minute rate between two heartbeats.
func (a *Agent) dvSummary() *cloud.DirektvermarktungSummary {
	a.dvMu.Lock()
	dv := a.dv
	a.dvMu.Unlock()
	if dv == nil {
		return nil
	}
	st := dv.Stand()
	if st == nil {
		return nil
	}
	now := time.Now()
	out := &cloud.DirektvermarktungSummary{
		Partner:             st.Partner,
		Lage:                st.Lage,
		Revision:            st.Revision,
		ZugangFingerabdruck: st.ZugangFingerabdruck,
	}
	if t := st.Tunnel; t != nil {
		tunnel := &cloud.DirektvermarktungTunnel{Gegenstelle: t.Gegenstelle}
		if !t.ObenSeit.IsZero() {
			ts := t.ObenSeit.UTC()
			tunnel.ObenSeit = &ts
		}
		if !t.HandshakeAm.IsZero() {
			ts := t.HandshakeAm.UTC()
			tunnel.HandshakeAm = &ts
		}
		out.Tunnel = tunnel
	}
	s := st.Server
	if s == nil {
		return out
	}
	pct := s.EffektivPct
	out.VorgabePct = &pct
	if kw, ok := st.GrenzeKw(now); ok {
		out.GrenzeKw = &kw
	}
	if !s.Lebenszeichen.IsZero() {
		ts := s.Lebenszeichen.UTC()
		out.LebenszeichenAm = &ts
	}
	if !s.LetzteAbfrage.IsZero() {
		ts := s.LetzteAbfrage.UTC()
		out.LetzteAbfrageAm = &ts
	}
	if !s.LetzteSchreibung.IsZero() {
		ts := s.LetzteSchreibung.UTC()
		out.LetzteSchreibungAm = &ts
	}
	a.dvMu.Lock()
	if !a.dvRateAt.IsZero() && now.After(a.dvRateAt) && s.Abfragen >= a.dvRateCount {
		minutes := now.Sub(a.dvRateAt).Minutes()
		if minutes > 0 {
			rate := float64(s.Abfragen-a.dvRateCount) / minutes
			out.AbfragenJeMinute = &rate
		}
	}
	a.dvRateAt = now
	a.dvRateCount = s.Abfragen
	a.dvMu.Unlock()
	if werte, ok := st.WerteAktuell(now); ok {
		w := &cloud.DirektvermarktungWerte{}
		if v, ok := werte["nvp_einspeisung_w"]; ok {
			n := int(v)
			w.EinspeisungW = &n
		}
		if v, ok := werte["erzeugung_w"]; ok {
			n := int(v)
			w.ErzeugungW = &n
		}
		if v, ok := werte["netzbetreiber_vorgabe_pct"]; ok {
			n := int(v)
			w.NetzbetreiberPct = &n
		}
		if v, ok := werte["referenz_w"]; ok {
			n := int(v)
			w.ReferenzW = &n
		}
		out.Werte = w
	}
	return out
}
