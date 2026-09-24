package agent

import (
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// Native self-regulation - the CORE half. The pure rule (and the whole safety
// argument) lives in guards/nativemode.go; this file only gathers the facts and
// carries the verdict into the published setpoint, the snapshot and the
// heartbeat.
//
// THE SPLIT INSIDE THE EDGE, restated because it is what makes this file small:
// the core knows the plan duty, the measurements, the reserve floor and the peak
// budget, but ONLY Layer 1 knows the register map - and therefore whether this
// exact model+firmware has a bench-certified native capability at all
// (edge-app/nodered/unplanned-load-native.js). So the core publishes an INTENT
// and Layer 1 answers with EVIDENCE on the control readback. An intent that is
// never confirmed is withdrawn after a bounded grace and the proven 10-second
// follower carries the slot - see guards.NativeUnproven.

// batteryModeSetpoint / batteryModeNative are the two values of the additive
// `battery_mode` field on edge/setpoint. ABSENT means "setpoint", so a Layer 1
// that predates the field behaves byte-for-byte as before.
const (
	batteryModeSetpoint = "setpoint"
	batteryModeNative   = "native"
)

// nativeProofGrace derives the proof window from the setpoint cadence: a handful
// of ticks, so ONE lost readback cycle can never end a native slot, and at the
// default 10 s cadence it lands on the documented minute.
func (a *Agent) nativeProofGrace() time.Duration {
	g := 6 * a.Cfg.SetpointInterval
	if g < 60*time.Second {
		g = 60 * time.Second
	}
	return g
}

// nativeDutyFor names which cloud duty (if any) authorises a native slot at now.
// It reuses the EXACT accessors the 10-second follower keys on, so the two
// executions can never disagree about whether this slot is a covering slot.
//
// The two duties are mutually exclusive in the optimizer; a hand-crafted payload
// carrying both is treated as no duty at all - the same refusal the follower
// makes ("conflicting grants are not a reason to guess which contract was
// meant").
func nativeDutyFor(p *plan.Plan, now time.Time) string {
	cover := p.ActiveCoverLoadFromBattery(now)
	unplanned := p.ActiveUnplannedLoadDischarge(now)
	switch {
	case cover && unplanned:
		return ""
	case cover:
		return guards.NativeDutyCoverLoad
	case unplanned:
		return guards.NativeDutyUnplanned
	default:
		return ""
	}
}

// nativeEvidence reads Layer 1's answer out of the newest control readback:
// whether it really executed the native primitive, and what the device said
// about its own grid-charging configuration.
//
// It demands the SAME freshness window the idle-slot authorization uses plus a
// held readback - a native mode nobody can currently observe is not one.
//
// The grid-charge answer has two sources and the MODE picks one, never both:
// a cycle that ran the native primitive counts only the answer read back in
// the device's own mode; any other cycle may carry the executor's read from
// BEFORE the hand-over (native_precondition). That second source is what lets
// the intent stand on an EEG site until the device can be handed over at all -
// guards/nativemode.go step 8 says what it may and may not open.
func nativeEvidence(control *state.ControlInfo, now time.Time, window time.Duration) (proven bool, gridChargeBlocked *bool) {
	if !idleReadbackHealthy(control, now, window) {
		return false, nil
	}
	answer := control.NativePreconditionGridChargeBlocked
	if control.Mode == batteryModeNative {
		proven, answer = true, control.NativeGridChargeBlocked
	}
	if answer != nil {
		v := *answer
		gridChargeBlocked = &v
	}
	return proven, gridChargeBlocked
}

// nativeDecide runs the supervision for this tick and returns the decision plus
// the snapshot block the surfaces render.
//
// in.Enabled folds the operator's own switch with the two write gates: without
// ControlEnabled+certified Layer 1 writes nothing at all, so it can neither
// enter a native mode nor leave one - handing over a battery we could not take
// back would be the one asymmetry that makes the whole design unsafe.
func (a *Agent) nativeDecide(
	now time.Time,
	p *plan.Plan,
	r guards.Reading,
	referenceKw float64,
	marketCorrectionsAllowed bool,
	authorized bool,
	measurementFresh bool,
	freshWindow time.Duration,
	effectiveFloor *float64,
	peakTarget *float64,
	solarOnly bool,
) (guards.NativeDecision, *state.NativeInfo) {
	control := a.State.Get().Control
	proven, gridChargeBlocked := nativeEvidence(control, now, freshWindow)

	_, slotStart, _ := p.ActiveSetpoint(now)
	dec := a.native.Decide(now, guards.NativeInput{
		Enabled:           a.Cfg.NativeSelfRegulationEnabled,
		Duty:              nativeDutyFor(p, now),
		SlotStart:         slotStart,
		PlanFresh:         p.Fresh(now),
		HolderExempt:      marketCorrectionsAllowed,
		Authorized:        authorized,
		MeasurementsFresh: measurementFresh,
		ReadbackHealthy:   idleReadbackHealthy(control, now, freshWindow),
		SocPct:            r.SocPct,
		FloorPct:          effectiveFloor,
		PeakThreatened:    guards.NativePeakThreat(a.peak, now, peakTarget),
		SolarOnlyCharge:   solarOnly,
		GridChargeBlocked: gridChargeBlocked,
		Proven:            proven,
	})
	if !dec.Native {
		return dec, nil
	}
	kw := referenceKw
	if math.IsNaN(kw) || math.IsInf(kw, 0) {
		kw = 0
	}
	return dec, &state.NativeInfo{
		Active:      true,
		Proven:      dec.Proven,
		Duty:        dec.Duty,
		ReferenceKw: kw,
		Reason:      dec.Reason,
		Text:        dec.Text,
	}
}
