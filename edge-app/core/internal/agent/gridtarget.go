package agent

import (
	"log/slog"
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Netzseitiger Drossel-Slot - the CORE half (concept vp-deye-netzseitig-drossel-k2,
// package P3). The pure rule and the whole safety argument live in
// guards/gridtarget.go; this file only gathers the facts and carries the
// verdict into the published setpoint, the snapshot and the heartbeat - the
// build of agent/native.go.
//
// ⚠ THIS IS NOT THE TEST PATH. agent/gridtest.go (P1) is armed by hand, bounded
// by a TTL and steps through a proof; it is untouched. This path is entered by
// the PLAN (a slot that curtails and does not discharge the battery), needs
// Layer 1's released lever for the exact model and both write gates, and is
// supervised for as long as it stands. Without the lever or without a gate the
// published setpoint is byte-for-byte what it was.

// batteryModeGridTarget is the third value of `battery_mode` on edge/setpoint
// (see batteryModeSetpoint / batteryModeNative): do NOT write
// battery_setpoint_kw - regulate the grid connection point on grid_target_kw.
// A Layer 1 that does not know the word runs the ordinary setpoint plan and
// never confirms, so the core withdraws the intent after its grace - and it
// never reports the lever in the first place.
const batteryModeGridTarget = guards.GridTargetLever

// execModeGridTarget is the `execution.mode` word of a PROVEN grid-side slot
// (cloud.ExecutionSummary). Shared with the api listener and the portal.
const execModeGridTarget = "grid_target"

// primarySourceID is the reported source id of the primary inverter (the
// `sources` heartbeat block, sourcesSummary) - the join key of its entry in
// curtailment.per_unit.
const primarySourceID = "inverter"

// The two register roles a grid-side cycle reads back (edge-app/nodered/
// deye-grid-target.js): the side selector and the grid target itself.
const (
	roleGridPower        = "grid_power"
	rolePowerControlMode = "power_control_mode"
	// deyeGridSideValue is register 1104 = 2 (grid side).
	deyeGridSideValue = 2
)

// gridTargetLever reports whether Layer 1 named the released grid-side lever
// for the current selection on its newest readback. Not reported = no lever.
func gridTargetLever(control *state.ControlInfo) bool {
	if control == nil || control.NativeCapabilities == nil {
		return false
	}
	for _, w := range control.NativeCapabilities.Intents {
		if w == guards.GridTargetLever {
			return true
		}
	}
	return false
}

// gridTargetEvidence reads Layer 1's answer out of the newest control
// readback: the device is on the GRID side and holds our target.
//
// It is read from the REGISTERS, not from a mode word: the readback is healthy
// (fresh, held - the idle-slot rule), the side selector actually READ 2, and
// the grid target register held what this cycle commanded. A cycle that could
// not read the selector proves nothing (unread is not held).
func gridTargetEvidence(control *state.ControlInfo, now time.Time, window time.Duration) bool {
	if !idleReadbackHealthy(control, now, window) {
		return false
	}
	side, target := false, false
	for _, r := range control.Registers {
		switch r.Role {
		case rolePowerControlMode:
			side = r.Match && r.ActualRaw != nil && *r.ActualRaw == deyeGridSideValue
		case roleGridPower:
			target = r.Match
		}
	}
	return side && target
}

// gridTargetOwnPv is the primary device's OWN measured PV, NaN when its last
// reading is not fresh. state.LastReading is the primary's reading BEFORE the
// multi-source aggregation - exactly "site PV minus every other producer".
func gridTargetOwnPv(snap state.Snapshot, now time.Time, window time.Duration) float64 {
	if snap.LastTelemetry.IsZero() || now.Sub(snap.LastTelemetry) > window {
		return math.NaN()
	}
	if v, ok := snap.LastReading["pv_power_kw"]; ok {
		return v
	}
	return math.NaN()
}

// gridTargetDecide runs the supervision for this tick and returns the decision
// plus the two snapshot blocks the surfaces render.
func (a *Agent) gridTargetDecide(
	now time.Time,
	p *plan.Plan,
	r guards.Reading,
	marketCorrectionsAllowed bool,
	authorized bool,
	measurementFresh bool,
	freshWindow time.Duration,
	effectiveFloor *float64,
	leaderRefusal string,
) (guards.GridTargetDecision, *state.GridTargetInfo, *state.GridTargetWithheldInfo) {
	snap := a.State.Get()
	control := snap.Control

	plannedKw, slotStart, planActive := p.ActiveSetpoint(now)
	if !planActive {
		plannedKw = math.NaN()
	}
	lim := p.ActivePvLimit(now)

	a.mu.Lock()
	gridKw, battKw := math.NaN(), math.NaN()
	if a.lastGridKw != nil {
		gridKw = *a.lastGridKw
	}
	if a.lastBattKw != nil {
		battKw = *a.lastBattKw
	}
	a.mu.Unlock()

	in := guards.GridTargetInput{
		Enabled:           a.Cfg.NativeSelfRegulationEnabled,
		SlotStart:         slotStart,
		PlanFresh:         p.Fresh(now),
		CurtailmentWanted: lim != nil && *lim >= 0,
		PlannedKw:         plannedKw,
		Lever:             gridTargetLever(control),
		OtherModeActive:   a.native.Engaged(),
		SharedControl:     a.heldAnteile() != nil,
		HolderExempt:      marketCorrectionsAllowed,
		Authorized:        authorized,
		MeasurementsFresh: measurementFresh,
		ReadbackHealthy:   idleReadbackHealthy(control, now, freshWindow),
		SocPct:            r.SocPct,
		FloorPct:          effectiveFloor,
		SocMinPct:         a.Cfg.SocMinPct,
		Proven:            gridTargetEvidence(control, now, freshWindow),
		GridKw:            gridKw,
		BatteryKw:         battKw,
		OwnPvKw:           gridTargetOwnPv(snap, now, freshWindow),
		LeaderRefusal:     leaderRefusal,
	}
	dec := a.gridTarget.Decide(now, in)
	a.noteGridTarget(dec)

	if !dec.Engage {
		return dec, nil, a.gridTargetWithheld(dec, in)
	}
	info := &state.GridTargetInfo{
		Active:    true,
		Proven:    dec.Proven,
		TargetKw:  dec.TargetKw,
		Following: dec.Following,
		Reason:    dec.Reason,
		Text:      dec.Text,
		Hint:      dec.Hint,
		HintText:  dec.HintText,
	}
	if dec.Proven && !math.IsNaN(gridKw) {
		v := math.Round(gridKw*1000) / 1000
		info.GridKw = &v
	}
	return dec, info, nil
}

// gridTargetWithheld is the snapshot block for a CURTAILING slot this device
// could regulate grid side but does not: a take-back must name its cause where
// the operator looks, not only in a log. Silent for a slot that asks for
// nothing (no curtailment, switched off) and for a device without the lever.
func (a *Agent) gridTargetWithheld(dec guards.GridTargetDecision, in guards.GridTargetInput) *state.GridTargetWithheldInfo {
	a.mu.Lock()
	if dec.Ended != "" {
		a.gridTargetEndedSlot = in.SlotStart
	}
	ended := !a.gridTargetEndedSlot.IsZero() && a.gridTargetEndedSlot.Equal(in.SlotStart)
	a.mu.Unlock()
	if !in.Lever || !in.Enabled || !in.PlanFresh || !in.CurtailmentWanted || dec.Reason == "" {
		return nil
	}
	return &state.GridTargetWithheldInfo{Reason: dec.Reason, Text: dec.Text, Ended: ended}
}

// noteGridTarget logs every END of the mode with its reason (once, on the
// transition tick) and every entry - "jede Rücknahme trägt ihren Grund".
func (a *Agent) noteGridTarget(dec guards.GridTargetDecision) {
	a.mu.Lock()
	was := a.gridTargetLastReason
	a.gridTargetLastReason = dec.Reason
	a.mu.Unlock()
	if dec.Ended != "" {
		slog.Warn("netzseitiger drossel-slot beendet", "reason", dec.Ended, "text", dec.EndedText)
		return
	}
	if was == dec.Reason || !dec.Engage {
		return
	}
	slog.Info("netzseitiger drossel-slot", "reason", dec.Reason, "target_kw", dec.TargetKw, "text", dec.Text)
}

// gridTargetInner is the grid-side slot as the feed-in cascade sees it (K6,
// guards/exportcascade.go): a PROVEN grid-side device IS an inner loop with an
// open charge side - it takes the surplus into the storage first and throttles
// its own PV for the rest, so the watchdog of the AC-coupled units must not
// fight it. A pending mode is not an inner loop yet.
//
// The ceiling is the battery's rated charge power; the upper SoC bound is
// GridTargetChargeCeilingPct, not the configured 95 % - in this slot the
// device charges to its own maximum (Captain decision E4), and a storage the
// watchdog believed full at 95 % would have it throttle the Fronius units
// while the battery still takes their energy.
func (a *Agent) gridTargetInner(dec guards.GridTargetDecision, r guards.Reading, limits guards.Limits, slot time.Time) guards.InnerLoop {
	if !dec.Engage || !dec.Proven {
		return guards.InnerLoop{}
	}
	batt := math.NaN()
	a.mu.Lock()
	if a.lastBattKw != nil {
		batt = *a.lastBattKw
	}
	a.mu.Unlock()
	return guards.InnerLoop{
		Active:    true,
		CeilingKw: limits.MaxChargeKw,
		BatteryKw: batt,
		SocPct:    r.SocPct,
		SocMaxPct: guards.GridTargetChargeCeilingPct,
		Slot:      slot,
	}
}

// gridTargetTrackKw is the battery term the live curtailment tracker counts
// while the intent stands: the MEASURED battery power. The tracker's law is
// cap = house + max(battery, 0) with the COMMANDED setpoint - a number the
// device does not follow on the grid side. Unknown falls back to the reference.
func (a *Agent) gridTargetTrackKw(referenceKw float64) float64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.lastBattKw != nil && !math.IsNaN(*a.lastBattKw) {
		return *a.lastBattKw
	}
	return referenceKw
}

// gridTargetUnit is the primary inverter's entry in the heartbeat's
// curtailment.per_unit list, nil when this device carries no grid-side lever.
//
// It is the entry that lets the cloud say WHICH device throttles and HOW:
//
//	source_id  the primary's reported source id - the join key to a device name
//	certified  the core's control gate, never a readback stamp
//	mode       "grid_target", STANDING: this unit does not cap its own output,
//	           it regulates the grid connection point. It says how the unit
//	           curtails, not that it does so right now.
//	target_kw  the commanded grid target, only while the intent stands (pending
//	           or proven). Absent = no target active - never a fabricated 0.
//	match      the MEASURED effect (grid point inside the band around the
//	           target), only once the device confirmed the grid side. Absent
//	           while pending = "not judged yet", never "disagreed".
func gridTargetUnit(snap state.Snapshot) *cloud.CurtailmentUnit {
	if !gridTargetLever(snap.Control) {
		return nil
	}
	u := &cloud.CurtailmentUnit{SourceID: primarySourceID, Certified: snap.ControlCertified, Mode: execModeGridTarget}
	if g := snap.GridTarget; g != nil && g.Active {
		t := g.TargetKw
		u.TargetKw = &t
		if g.Proven && g.Following != nil {
			m := *g.Following
			u.Match = &m
		}
	}
	return u
}

// gridTargetRegulating reports whether the primary provably regulates the grid
// point right now - the condition under which its entry folds into the
// curtailment aggregates (active / all_match).
func gridTargetRegulating(snap state.Snapshot) bool {
	g := snap.GridTarget
	return g != nil && g.Active && g.Proven
}

// releaseGridTarget drops the supervision and its snapshot blocks - the
// setpoint path's early exits (a bounded test owns the inverter).
func (a *Agent) releaseGridTarget() {
	a.gridTarget.Release()
	a.State.Update(func(s *state.Snapshot) {
		s.GridTarget = nil
		s.GridTargetWithheld = nil
	})
}
