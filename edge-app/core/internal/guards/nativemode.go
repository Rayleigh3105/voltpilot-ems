// Native self-regulation (Selbstregel-Modus): in a slot the CLOUD marked as
// "covering the house from the battery is economic" (cover_load_from_battery /
// unplanned_load_discharge), hand the SETPOINT itself back to the inverter and
// let its own self-consumption loop decide how many watts to pull, instead of
// recomputing a watt value every 10 s and writing it into a register.
//
// WHY. Today a covering slot is a 10-second closed loop on the box
// (guards.LoadFollower): the core computes -max(load - pv, 0), publishes it and
// Layer 1 writes it into the inverter. That is three register writes and ~six
// readbacks every 10 s on a logger that serves ONE TCP client, and it answers a
// load step with the cadence of that loop while the inverter's own loop answers
// it in well under a second. Every capable hybrid already HAS that loop - it is
// the product's normal mode. So in exactly those slots the cheaper and faster
// execution is: stop writing, and let the device do what it does.
//
// ⚠ THE ONE SENTENCE THIS FILE EXISTS FOR: "selbst regeln" heisst SOLLWERT
// WEGLASSEN, NICHT AUFSICHT WEGLASSEN. The guard chain protects a value we
// command; in native mode there is no commanded value left to clamp, so every
// guard that used to bite through the setpoint becomes an OBSERVATION with a
// TAKE-BACK. This type is that supervision, and it is deliberately pure: no
// I/O, no clock of its own, every fact passed in (the Tagesprotokoll/FleetPflege
// pattern), so all of it is provable without a device.
//
// THE SPLIT, identical to the three in-slot duties next door (slottrim.go,
// loadfollow.go, surpluscharge.go): the CLOUD decides WHETHER covering is
// economic in this slot (one price truth - services/optimization slot_trim.py),
// the EDGE decides HOW it is executed. Nothing here knows a price, ever, and no
// contract field was added: a native slot IS a cover slot.
//
// THE SECOND SPLIT, inside the edge, and it is why this file cannot answer
// everything: the CORE knows the plan duty, the measurements, the reserve floor
// and the peak budget; only LAYER 1 knows the register map and therefore whether
// THIS exact model+firmware has a bench-certified native capability at all
// (edge-app/nodered/unplanned-load-native.js). So the core publishes an INTENT
// (battery_mode: "native" on edge/setpoint) and Layer 1 answers with EVIDENCE
// (a readback carrying mode "native" plus the device's own state registers).
// An intent that is never confirmed is not a native mode: it is withdrawn after
// a bounded grace, and the proven 10-second follower carries the slot. That
// asymmetry is deliberate - a fabricated "the inverter regulates itself" would
// be exactly the failure mode the whole design has to rule out (the scout's
// risk 5: without device-side evidence "we stopped writing" and "we died" look
// identical).
//
// SAFE STATE IS UNCHANGED. Native is a WANTED, PROVEN mode, never a failsafe:
// on any doubt this type returns to the setpoint path, whose safe value is the
// guard-clamped 0 kW / self-consumption computation that shipped long before it.
package guards

import (
	"math"
	"sync"
	"time"
)

// The duty word that authorised a native slot - which of the two cloud-published
// slot duties opened it. Reported only; both are equally authorised.
const (
	// NativeDutyCoverLoad = the plan discharges and plans grid ~ 0
	// (cover_load_from_battery): covering the house is cheaper than importing.
	NativeDutyCoverLoad = "cover_load"
	// NativeDutyUnplanned = the plan rests and the cloud additionally authorised
	// STARTING a discharge (unplanned_load_discharge).
	NativeDutyUnplanned = "unplanned_load"
)

// The CLOSED reason vocabulary. Every non-native outcome names its cause -
// a limitation nobody names reads as a defect (the Canary-Soak lesson of the OTA
// path, applied to the setpoint path). Machine-readable so no surface has to
// search a German sentence; the sentence itself comes from NativeReasonText.
const (
	// NativeEngaged: the device regulates itself, and Layer 1 proved it.
	NativeEngaged = "geraet_regelt_selbst"
	// NativePending: the intent is published, the device-side proof has not
	// arrived yet and the grace window is still open.
	NativePending = "nachweis_ausstehend"
	// NativeOff: the operator switched the mode off (VP_NATIVE_SELF_REGULATION).
	NativeOff = "abgeschaltet"
	// NativeNoDuty: this slot is not a covering slot - the normal setpoint path.
	NativeNoDuty = "keine_deckungs_pflicht"
	// NativePlanStale: no fresh plan. (A stale plan already clears both duties,
	// so this is defence in depth, stated because "the plan is old" is one of the
	// supervision conditions the design owes an answer for.)
	NativePlanStale = "plan_veraltet"
	// NativeForeignHolder: plant rest, a non-plan arbitration holder or an owner
	// claim owns the battery. Market economics may never rewrite those.
	NativeForeignHolder = "fremder_halter"
	// NativeNotAuthorized: the kill-switch is off or this model is not certified
	// for control at all - then nothing may be written, and nothing may be
	// handed over either.
	NativeNotAuthorized = "nicht_freigegeben"
	// NativeStaleMeasurement: load/PV/SoC are not fresh enough to supervise.
	NativeStaleMeasurement = "messung_nicht_frisch"
	// NativeNoReadback: Layer 1's control readback is unhealthy - we would be
	// handing the battery to a device we cannot currently observe.
	NativeNoReadback = "keine_rueckmeldung"
	// NativeNoFloor: the cloud did not publish effective_floor_soc_pct, so the
	// reserve stack this mode must supervise is unknown.
	NativeNoFloor = "kein_reserve_boden"
	// NativeFloorReached: SoC is at/near the full reserve floor. The device's own
	// floor is NOT ours (a Deye stops at its ToU target SoC, a Fronius at
	// MinRsvPct), so the take-back is the only thing that enforces the platform
	// floor in this mode.
	NativeFloorReached = "reserve_boden"
	// NativePeakThreatened: the running quarter hour's measured import is above
	// what its remaining budget allows. In native mode we have no lever, so the
	// only correct answer is to take the lever back.
	NativePeakThreatened = "lastspitze_bedroht"
	// NativeGridChargeUnproven: the site is EEG-funded (solar-only charging), and
	// the device did not PROVE that its own configuration blocks grid charging.
	// Unknown counts as not proven - a compliance rule may not rest on silence.
	NativeGridChargeUnproven = "netzladen_am_geraet"
	// NativeUnproven: the grace window closed without device-side evidence.
	NativeUnproven = "nachweis_fehlt"
)

var nativeReasonText = map[string]string{
	NativeEngaged:            "Der Wechselrichter regelt den Verbrauch gerade selbst.",
	NativePending:            "Der Wechselrichter soll selbst regeln - die Rückmeldung des Geräts steht noch aus.",
	NativeOff:                "Die Wechselrichter-Automatik ist abgeschaltet.",
	NativeNoDuty:             "In diesem Zeitabschnitt gibt der Fahrplan den Sollwert vor.",
	NativePlanStale:          "Es liegt kein aktueller Fahrplan vor.",
	NativeForeignHolder:      "Eine Regel, ein Handeingriff oder die Anlagen-Pause hat gerade Vorrang.",
	NativeNotAuthorized:      "Die Steuerung dieses Wechselrichters ist nicht freigegeben.",
	NativeStaleMeasurement:   "Es fehlen aktuelle Messwerte, um die Anlage dabei zu beaufsichtigen.",
	NativeNoReadback:         "Der Wechselrichter meldet gerade nichts zurück.",
	NativeNoFloor:            "Die Reserve-Untergrenze der Anlage ist nicht bekannt.",
	NativeFloorReached:       "Der Ladestand hat die Reserve erreicht - VoltPilot übernimmt wieder.",
	NativePeakThreatened:     "Die Lastspitze dieser Viertelstunde ist bedroht - VoltPilot übernimmt wieder.",
	NativeGridChargeUnproven: "Der Wechselrichter hat nicht belegt, dass er nicht aus dem Netz lädt.",
	NativeUnproven:           "Der Wechselrichter hat die Selbstregelung nicht bestätigt - VoltPilot übernimmt wieder.",
}

// NativeReasonText is the German sentence for a reason code ("" for an unknown
// code - a word we do not understand must not become a sentence).
func NativeReasonText(code string) string { return nativeReasonText[code] }

// NativeFloorMarginPct is the headroom above the full reserve floor at which the
// supervision takes the battery back. It exists because the take-back is not
// instant: the intent has to reach Layer 1, the adapter has to write the return
// sequence and the inverter has to adopt it. Three percentage points of a real
// storage are minutes of ordinary house load at any plausible discharge rate -
// far more than that chain needs - while being small enough that a native slot
// still uses the battery down to essentially the platform floor.
const NativeFloorMarginPct = 3.0

// NativePeakMarginKw is how far the MEASURED quarter-hour import may run above
// the remaining budget before the peak target counts as threatened. Same order
// as the other economic guards' margins: above measurement noise, far below a
// meaningful billing effect.
const NativePeakMarginKw = 0.2

// NativeInput is every fact the decision needs. It is passed in whole so the
// rule is provable without a device, a clock or a broker.
type NativeInput struct {
	// Enabled is the operator's own switch for this execution mode
	// (VP_NATIVE_SELF_REGULATION_ENABLED). It is NOT the safety gate - the
	// certified-capability catalog in Layer 1 is - it is the lever that lets an
	// operator fall back to the proven follower without touching the image or
	// the plan.
	Enabled bool
	// Duty is NativeDutyCoverLoad / NativeDutyUnplanned, "" when this slot
	// carries no covering duty.
	Duty string
	// SlotStart identifies the active slot. A CHANGE re-arms the mode: every
	// take-back below is latched for the REST OF ITS SLOT (see Decide).
	SlotStart time.Time
	// PlanFresh is the plan's own freshness. Both duties already require it, so
	// this is defence in depth - and it makes "der Plan veraltet" a stated
	// supervision condition rather than an implicit one.
	PlanFresh bool
	// HolderExempt is the arbitration boundary the three in-slot duties share
	// (marketCorrectionsAllowed): no plant rest, no non-plan holder, no owner
	// claim. Native is a market-economic execution choice and obeys the same
	// boundary.
	HolderExempt bool
	// Authorized is the core's control gate: kill-switch AND certification
	// verdict. Without it Layer 1 writes nothing at all, so it can neither enter
	// nor leave a native mode.
	Authorized bool
	// MeasurementsFresh / ReadbackHealthy are the two observation channels the
	// supervision runs on. Without either we would be handing the battery to a
	// device we cannot watch.
	MeasurementsFresh bool
	ReadbackHealthy   bool
	// SocPct is the measured state of charge (NaN = unknown).
	SocPct float64
	// FloorPct is the cloud-computed full reserve stack
	// (max(technical, backup, peak reserve)). nil = unknown = no native mode:
	// this is the ONE bound the device does not enforce for us.
	FloorPct *float64
	// PeakThreatened is the peak tracker's verdict (see NativePeakThreat).
	PeakThreatened bool
	// SolarOnlyCharge is the site's EEG posture from the plan
	// (grid_charge_allowed == false / absent). When true the device must PROVE
	// it cannot charge from the grid in its own configuration.
	SolarOnlyCharge bool
	// GridChargeBlocked is that proof, from Layer 1's readback. nil = the device
	// did not say - which counts as NOT proven, never as "fine".
	GridChargeBlocked *bool
	// Proven is Layer 1's evidence that the device really is in its own
	// regulation right now (a fresh readback whose mode is "native" and whose
	// state registers held).
	Proven bool
}

// NativeDecision is one evaluation.
type NativeDecision struct {
	// Native is the intent published on edge/setpoint as battery_mode "native".
	// It is true while the mode is PENDING as well as while it is PROVEN - the
	// executor has to be told to keep its hands off in both states.
	Native bool
	// Proven repeats NativeInput.Proven for the surfaces: only a proven mode may
	// be reported to the cloud as autonomous_discharge, so "wanted" and
	// "achieved" can never be confused.
	Proven bool
	// Duty is the authorising duty word while Native, "" otherwise.
	Duty string
	// Reason is the closed-vocabulary code, Text its German sentence. Both are
	// always filled - including for the two native states.
	Reason string
	Text   string
}

// NativeMode carries the per-slot supervision state across setpoint ticks.
//
// ANTI-FLAP, and it is asymmetric on purpose: entering is immediate (the slot's
// duty is the cloud's decision, there is nothing to debounce), while every
// TAKE-BACK is LATCHED FOR THE REST OF THAT SLOT. A native transition costs a
// write in each direction and a device-side mode change; toggling it with the
// 10-second setpoint cadence because a measurement blinked would be worse for
// the plant than simply finishing the slot on the proven follower. The latch
// clears on the next slot, so at most one quarter hour is ever spent that way.
//
// Concurrency-safe by construction: like its three siblings it is only reached
// from the setpoint path, but that path is callable from the tick loop, the
// schedule handler and the web API, so it takes the same lock discipline.
type NativeMode struct {
	mu sync.Mutex
	// grace is how long an intent may stay unproven before it is withdrawn.
	grace time.Duration
	// slot is the slot the current arming belongs to; a different one re-arms.
	slot time.Time
	// since is when the intent was first published in this slot (proof clock).
	since time.Time
	// latched is the take-back reason for this slot ("" = not taken back).
	latched string
	// engaged mirrors the last decision, for Engaged().
	engaged bool
}

// NewNativeMode returns a released supervision with the given proof grace.
// A non-positive grace falls back to nativeDefaultGrace so a mis-wired caller
// cannot create an intent that is never withdrawn.
func NewNativeMode(grace time.Duration) *NativeMode {
	if grace <= 0 {
		grace = nativeDefaultGrace
	}
	return &NativeMode{grace: grace}
}

// nativeDefaultGrace is the fallback proof window: enough for a handful of
// setpoint ticks at the default 10 s cadence, so one lost readback cycle cannot
// end a native slot.
const nativeDefaultGrace = 60 * time.Second

// Decide evaluates the supervision for this tick.
//
// The order is the safety argument, and it is fail-closed at every step: the
// mode is only entered when EVERY fact is present and good, and it is left as
// soon as ONE of them is not. Reading it top to bottom is reading the answer to
// "under which circumstances does VoltPilot let go of the battery".
func (n *NativeMode) Decide(now time.Time, in NativeInput) NativeDecision {
	n.mu.Lock()
	defer n.mu.Unlock()

	refuse := func(code string) NativeDecision {
		n.engaged = false
		return NativeDecision{Reason: code, Text: NativeReasonText(code)}
	}
	// A take-back is remembered for the rest of the slot (see the type doc).
	takeBack := func(code string) NativeDecision {
		n.latched = code
		n.since = time.Time{}
		n.engaged = false
		return NativeDecision{Reason: code, Text: NativeReasonText(code)}
	}

	// 1. The operator's own switch. Checked first so an emergency stop needs no
	//    reasoning about anything else.
	if !in.Enabled {
		n.reset()
		return refuse(NativeOff)
	}
	// 2. No covering duty in this slot -> the ordinary setpoint path, and the
	//    slot latch is cleared (a new slot may be native again).
	if in.Duty != NativeDutyCoverLoad && in.Duty != NativeDutyUnplanned {
		n.reset()
		return refuse(NativeNoDuty)
	}
	if !in.PlanFresh {
		n.reset()
		return refuse(NativePlanStale)
	}
	// 3. A new slot re-arms: the previous slot's take-back does not bind here.
	if !in.SlotStart.Equal(n.slot) {
		n.slot = in.SlotStart
		n.latched = ""
		n.since = time.Time{}
	}
	// 4. Somebody else owns the battery (plant rest, a rule, a handhold, an
	//    owner claim). Not a take-back - there is nothing of ours to take back.
	if !in.HolderExempt {
		n.since = time.Time{}
		return refuse(NativeForeignHolder)
	}
	if !in.Authorized {
		n.since = time.Time{}
		return refuse(NativeNotAuthorized)
	}
	// 5. This slot already handed the battery back once - finish it on the
	//    proven follower rather than toggling the device's mode.
	if n.latched != "" {
		n.engaged = false
		return NativeDecision{Reason: n.latched, Text: NativeReasonText(n.latched)}
	}
	// 6. The two observation channels. Without them the supervision below is
	//    blind, and a blind supervision is not one.
	if !in.MeasurementsFresh {
		return takeBack(NativeStaleMeasurement)
	}
	if !in.ReadbackHealthy {
		return takeBack(NativeNoReadback)
	}
	// 7. The reserve floor. The device's own floor is not ours, so an unknown
	//    platform floor means no native mode at all - never a guessed one.
	if in.FloorPct == nil {
		n.since = time.Time{}
		return refuse(NativeNoFloor)
	}
	if math.IsNaN(in.SocPct) || in.SocPct <= *in.FloorPct+NativeFloorMarginPct {
		return takeBack(NativeFloorReached)
	}
	// 8. EEG: the ONE compliance rule that moves into the device's own
	//    configuration when we stop commanding. Unknown is not proven.
	if in.SolarOnlyCharge && (in.GridChargeBlocked == nil || !*in.GridChargeBlocked) {
		return takeBack(NativeGridChargeUnproven)
	}
	// 9. The billing peak. In native mode there is no lever left, so a threatened
	//    quarter hour is answered by taking the lever back.
	if in.PeakThreatened {
		return takeBack(NativePeakThreatened)
	}

	// 10. Native. Proven by Layer 1, or pending inside the grace window.
	if in.Proven {
		n.since = now
		n.engaged = true
		return NativeDecision{
			Native: true, Proven: true, Duty: in.Duty,
			Reason: NativeEngaged, Text: NativeReasonText(NativeEngaged),
		}
	}
	if n.since.IsZero() {
		n.since = now
	}
	if now.Sub(n.since) > n.grace {
		// The intent stood, the device never confirmed it. That is not a native
		// mode, it is an unanswered request - and "we stopped writing" must never
		// be allowed to look like "the inverter took over".
		return takeBack(NativeUnproven)
	}
	n.engaged = true
	return NativeDecision{
		Native: true, Duty: in.Duty,
		Reason: NativePending, Text: NativeReasonText(NativePending),
	}
}

// Engaged reports whether the last decision published a native intent.
func (n *NativeMode) Engaged() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.engaged
}

// Release drops the supervision state (used by the setpoint path's early exits -
// without a reading or during a bounded calibration write it cannot supervise at
// all, so it must not carry an armed state across).
func (n *NativeMode) Release() {
	n.mu.Lock()
	n.reset()
	n.engaged = false
	n.mu.Unlock()
}

func (n *NativeMode) reset() {
	n.slot = time.Time{}
	n.since = time.Time{}
	n.latched = ""
}

// NativePeakThreat answers "is the running quarter hour's billing peak threatened
// right now" from the MEASURED import alone - the question native mode has to ask
// because it holds no lever to answer it with.
//
// It is deliberately NOT "would PeakShave lower the reference value": in a
// covering slot the reference already drives the predicted grid to zero, so that
// test could never fire and the supervision would be decorative. What matters is
// what the METER is doing: if the import held right now is above what the rest of
// the quarter may average, the quarter's mean will overshoot unless something
// changes - and in native mode the only thing that can change is us.
//
// ok=false (tracker inactive / no target) means NOT threatened: an economic guard
// never regulates blind, and the freshness of the measurement is supervised
// separately.
func NativePeakThreat(t *PeakTracker, now time.Time, targetKw *float64) bool {
	if t == nil || targetKw == nil {
		return false
	}
	allowed, ok := t.AllowedImport(now, *targetKw)
	if !ok {
		return false
	}
	held, ok := t.HeldImport(now)
	if !ok {
		return false
	}
	return held > allowed+NativePeakMarginKw
}
