package agent

import (
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// AP-15 IP-19: the Bezugswaechter - the import-side twin of the feed-in
// watchdog with a share (V3). It holds the box's own import share over
// everything the box controls on the import side: the charge park of the
// Ladepark-Rahmen (lastmgmt/bezuganteil.go) and the battery charging from the
// grid (guards/bezuganteil.go). Without a share document every function here
// answers "none" and the box is byte for byte today's.

// bezugAnteil is the own import share the guard holds; nil without a share
// document. Only fuehrt regulates the whole limit while it measures -
// steuert_mit AND a document without a role (the field is optional) hold the
// share, always.
func (a *Agent) bezugAnteil() *lastmgmt.BezugAnteil {
	h := a.heldAnteile()
	if h == nil {
		return nil
	}
	an := &lastmgmt.BezugAnteil{Fuehrt: h.Rolle == "fuehrt"}
	// An accepted document names this box in both directions with a valid
	// number (anteile.DokumentPruefen); should the text still not read, the
	// share is 0 - a held document never falls back to "no share".
	if v, err := h.AnteilKw["bezug"].Float64(); err == nil {
		an.AnteilKw = v
	}
	// AP-15 Folge: the share holds for ALL the box controls on the import
	// side - the charge park gets it minus the reserve of the other
	// controllable consumers. Absent (older document or cloud): no reserve.
	if v, err := h.ReserveBezugKw.Float64(); err == nil && v > 0 {
		an.ReserveKw = v
	}
	// AP-15 Folge (B3): the declared maximum of the uncontrolled load behind
	// the own feeder - the co-controlling box's blind figure subtracts it.
	// Absent: none declared, the blind figure is today's.
	if v, err := h.UngeregeltBezugKw.Float64(); err == nil && v > 0 {
		an.UngeregeltKw = v
	}
	return an
}

// netzladenDeckel is the ceiling on the battery's charge for a box holding a
// share document, nil without one. Every input is the box's own (G1): its PV
// reading and, wherever a charge park runs, the sample of its charging budget
// - at the leading box the connection point and its limit, at a
// co-controlling one its own meter and its share. A leading box without a
// charge park knows no connection limit and so never charges from the grid
// while it holds a share.
func (a *Agent) netzladenDeckel(now time.Time, r guards.Reading) *guards.NetzladenDeckel {
	an := a.bezugAnteil()
	if an == nil {
		return nil
	}
	in := guards.Netzladen{Fuehrt: an.Fuehrt, PvKw: r.PvKw}
	if rt := a.ocpp; rt != nil {
		n, hasLimit := rt.budget.Netzpunkt(now, rt.currentSettings())
		// B2 (AP-15 IP-20): a frozen value is not fresh, however new its
		// timestamp - blind, the box charges only from its own PV
		in.Fresh = n.Seen && n.Age <= lastmgmt.BudgetFreshWindow && a.eingefrorenSeit(now).IsZero()
		in.Limit = hasLimit
		in.PlanableKw, in.GridKw, in.BattChargeKw = n.PlanableKw, n.GridKw, n.BattChargeKw
		if !an.Fuehrt {
			// AP-15 Folge (PV counted once): the co-controlling box holds its
			// share at its own meter - the battery like the charge park
			// (lastmgmt.BudgetAnteil, PR 1059)
			in.PlanableKw = math.Max(round3(an.AnteilKw), 0)
		}
		p, stichprobe := rt.planUndStichprobe()
		if p != nil && p.AllocatedKw > n.ChargingKw {
			in.ReservedKw = p.AllocatedKw - n.ChargingKw
		}
		// AP-15 Folge: one headroom is given out once. When the loop starts
		// regulating again (after blind, a frozen value, the start), both
		// loops were lowered and the first fresh sample shows ONE headroom -
		// it is the park's first, whichever tick runs first: the battery
		// releases nothing until the park has decided on a sample at least
		// as new (guards.Netzladen.ParkOffen). Afterwards ReservedKw carries
		// what the park took.
		regelt := in.Fresh && (in.Limit || !an.Fuehrt)
		a.bezugMu.Lock()
		switch {
		case !regelt:
			a.bezugFrischAb = time.Time{}
		case a.bezugFrischAb.IsZero():
			a.bezugFrischAb = n.At
		}
		frischAb := a.bezugFrischAb
		a.bezugMu.Unlock()
		in.ParkOffen = regelt && (p == nil || stichprobe.Before(frischAb))
		// AP-15 Folge: PV is counted once - the park's loop already counted
		// a PV surplus at the meter as headroom, so the battery's PV comes
		// after the park (guards.Netzladen.Vorrang). Blind, the loop keeps
		// the last sample, with the park's current grant.
		in.Vorrang, in.Nachlauf = true, n.Seen && !in.Fresh
		if p != nil && p.AllocatedKw < n.ChargingKw {
			in.ParkUnterKw = n.ChargingKw - p.AllocatedKw
		}
	}
	// IP-27 A7: a standing import value asks for ONE probing adjustment
	e := &a.einfrier
	richtung, neu := a.einfrierPruefen(now)
	e.mu.Lock()
	if richtung > 0 {
		in.Pruefen, in.PruefenNeu, in.PruefKw = true, neu, e.pruefBattKw
	} else {
		e.pruefBattKw = nil
	}
	e.mu.Unlock()
	d := guards.NetzladenDeckelFuer(in)
	e.mu.Lock()
	if d.PruefKw != nil {
		v := *d.PruefKw
		e.pruefBattKw = &v
	}
	e.mu.Unlock()
	a.einfrierGeprueft(now, d.Pruefung)
	return &d
}

// The heartbeat stage of the guard (waechter.bezug, the export_guard.state
// words) is the most severe of its two parts: the charging budget and the
// battery ceiling.
var bezugStufeRang = map[guards.ExportState]int{
	guards.ExportWatching: 1, guards.ExportLimiting: 2, guards.ExportHolding: 3,
	guards.ExportContracting: 4, guards.ExportSafeCap: 5,
}

// ladeStufe maps a charging-budget verdict of a share-holding box.
func ladeStufe(v lastmgmt.BudgetVerdict, an lastmgmt.BezugAnteil) guards.ExportState {
	switch {
	case an.Fuehrt && v.Mode == lastmgmt.BudgetMeasured:
		return guards.ExportLimiting
	case !v.AnteilBinds:
		return guards.ExportWatching
	case v.Mode == lastmgmt.BudgetContracting:
		return guards.ExportContracting
	case an.Fuehrt:
		return guards.ExportSafeCap
	default:
		return guards.ExportLimiting
	}
}

// battStufe maps the battery ceiling for a charge the path asked for
// (requestedKw > 0) and whether it lowered it. The loop "regelt" only while it
// cuts; the solar-only rule is the safe cap whether the charge fits or not.
// Without a charge there is nothing to guard: "" (no contribution).
func battStufe(d guards.NetzladenDeckel, requestedKw float64, lowered bool) guards.ExportState {
	switch {
	case !(requestedKw > 0):
		return ""
	case d.Regelt && lowered:
		return guards.ExportLimiting
	case d.Regelt:
		return guards.ExportWatching
	default:
		return guards.ExportSafeCap
	}
}

func (a *Agent) setBezugStufe(lade, batt *guards.ExportState) {
	a.bezugMu.Lock()
	if lade != nil {
		a.bezugLade = *lade
	}
	if batt != nil {
		a.bezugBatt = *batt
	}
	a.bezugMu.Unlock()
}

// bezugStufe is the stage for the heartbeat: "" without a share document and
// before either part has decided anything (a stage is never invented - like
// the feed-in stage, it appears with the first evaluation).
func (a *Agent) bezugStufe() string {
	if a.heldAnteile() == nil {
		return ""
	}
	a.bezugMu.Lock()
	defer a.bezugMu.Unlock()
	var s guards.ExportState
	for _, t := range []guards.ExportState{a.bezugLade, a.bezugBatt} {
		if bezugStufeRang[t] > bezugStufeRang[s] {
			s = t
		}
	}
	return string(s)
}

// A published battery rise also evaluates the park's blind ramp. No document:
// no extra state and no wake-up, preserving the single-box path.
func (a *Agent) bezugSpeicherSoll(kw float64, enabled bool) {
	if a.ocpp == nil || !enabled {
		return
	}
	an := a.bezugAnteil()
	if an == nil || !an.Fuehrt {
		return
	}
	if a.ocpp.budget.BezugSpeicherSoll(kw) {
		a.ocpp.nudge()
	}
}
