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

	// --- K4b (Absicht + Fenster, concept vp-wechselrichter-eigenregelung-k1) ---

	// NativeNoLever: the slot opens a window, but Layer 1 reported no CERTIFIED
	// lever for exactly this intent (or none that honours its window) - the box
	// keeps regulating, damped (guards.FollowDamper, E2 A). Not a take-back.
	NativeNoLever = "kein_hebel"
	// NativeWindowClosed: after the guards the window is a point - nothing left
	// to regulate, the setpoint path holds it.
	NativeWindowClosed = "fenster_geschlossen"
	// NativeWindowForcesFlow: the window excludes 0 (a charge floor / discharge
	// floor): that is a command, not a regulation - the box keeps it.
	NativeWindowForcesFlow = "fenster_erzwingt_fluss"
	// NativeChargeFromGrid: the battery charged while the grid point imported,
	// both above NativeChargeSideLimitKw for longer than NativeChargeSideHold.
	NativeChargeFromGrid = "laden_bei_bezug"
	// NativeDischargeAgainstIntent: in E↑ (charge only) the battery discharged
	// above NativeChargeSideLimitKw for longer than NativeChargeSideHold.
	NativeDischargeAgainstIntent = "entladen_gegen_absicht"
	// NativeStorageFull: E↑ reached the upper SoC bound - nothing left to store.
	NativeStorageFull = "speicher_voll"
	// NativeWriteBudget: the device's lever writes persistent memory and today's
	// budget of mode changes is spent (§6.6, F12).
	NativeWriteBudget = "schreibbudget"
	// NativeOwnPvCurtailed (K5, concept §6.3): the proven primitive throttles the
	// device's OWN PV once the storage cannot take more (Deye "netzseitig Ziel
	// 0"), and the plan does not ask for curtailment in this slot - so at the SoC
	// ceiling (minus NativeCeilingMarginPct), or charging at the window's limit
	// while exporting for longer than NativeChargeSideHold, the battery goes back
	// to the setpoint path (battery side), where the PV feeds in freely.
	NativeOwnPvCurtailed = "pv_abgeregelt"
	// NativeStorageExport (vp-wr-deye-tou-schreibbudget): while the device
	// regulates an intent that may discharge (E↓, E, E~), the storage fed into
	// the grid - battery discharging AND the grid point exporting, the smaller of
	// the two above NativeChargeSideLimitKw - for longer than
	// NativeChargeSideHold. None of these intents may sell storage energy (E↓:
	// "kein Verkauf"); a device configuration that does (Deye "Selling First"
	// with ToU) is refused by Layer 1 before the hand-over, this is the watch on
	// the effect.
	NativeStorageExport = "speicher_einspeisung"

	// NativeHintExportWithHeadroom is a HINT, never a take-back: the grid point
	// exports while the battery could still take more. The device's own meter
	// most likely does not see a second PV system (Herzogau: the Fronius) - which
	// the device cannot fix by itself and a take-back would not fix either.
	NativeHintExportWithHeadroom = "einspeisung_trotz_ladeleistung"

	// --- K6 (Führungsgerät je Netzpunkt, guards/leader.go) - refusals, never
	// take-backs of their own: a standing configuration fact. A verdict that
	// turns bad while the device regulates takes the lever back (latched for
	// the slot like every other take-back).

	// NativeMeterLocationMissing: the operator has not declared where the
	// device's meter sits - "Gerät regelt" needs "am Netzpunkt".
	NativeMeterLocationMissing = "zaehlerort_fehlt"
	// NativeMeterElsewhere: the device's meter sits somewhere else and does not
	// see the whole connection point.
	NativeMeterElsewhere = "zaehler_nicht_am_netzpunkt"
	// NativeMeterImplausible: the box's own Netz meter disagrees with the
	// device's meter (guards.MeterCheck).
	NativeMeterImplausible = "zaehler_unplausibel"
	// NativeSecondRegulator: a further storage at the same connection point
	// regulates itself on the same meter - two regulators swing up.
	NativeSecondRegulator = "zweiter_regler"
)

// The charge-side supervision thresholds of §6.1 step 5: a sustained 0.5 kW for
// longer than a minute - above measurement noise, far below a meaningful cost,
// and long enough that one slow device cycle (Deye: 5-25 s) cannot trip it.
const (
	NativeChargeSideLimitKw = 0.5
	NativeChargeSideHold    = 60 * time.Second
)

// NativeCeilingMarginPct is how far below the upper SoC bound a primitive that
// throttles its own PV (NativeOwnPvCurtailed) is taken back: the same headroom
// as the reserve floor, for the same reason (the take-back is not instant).
const NativeCeilingMarginPct = 3.0

// NativeWriteBudgetPerDay bounds the mode changes of a lever that writes
// PERSISTENT memory (§6.6, F12). A RAM lever is counted, never bounded. It is
// the Vorgabe: the device's control profile may state a tighter day budget
// (NativeInput.PersistentWriteBudget), never a looser one.
const NativeWriteBudgetPerDay = 20

// persistentWriteBudget is the day budget in force: the profile's statement
// when it has one inside (0, NativeWriteBudgetPerDay], else the Vorgabe.
func persistentWriteBudget(stated int) int {
	if stated <= 0 || stated > NativeWriteBudgetPerDay {
		return NativeWriteBudgetPerDay
	}
	return stated
}

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

	NativeNoLever:                "Für diese Absicht hat der Wechselrichter keinen freigegebenen Eigenmodus - VoltPilot regelt gedämpft nach.",
	NativeWindowClosed:           "In diesem Zeitabschnitt bleibt nichts zu regeln - VoltPilot gibt den Sollwert vor.",
	NativeWindowForcesFlow:       "Der Fahrplan verlangt hier eine feste Mindestleistung - VoltPilot regelt selbst nach.",
	NativeChargeFromGrid:         "Der Speicher hat über eine Minute aus dem Netz geladen - VoltPilot übernimmt wieder.",
	NativeDischargeAgainstIntent: "Der Speicher hat über eine Minute entladen, obwohl er nur Überschuss laden sollte - VoltPilot übernimmt wieder.",
	NativeStorageFull:            "Der Speicher ist voll - VoltPilot übernimmt für den Rest des Zeitabschnitts.",
	NativeWriteBudget:            "Die Umschaltungen dieses Wechselrichters für heute sind aufgebraucht - VoltPilot regelt selbst nach.",
	NativeOwnPvCurtailed:         "Der Speicher nimmt nichts mehr auf und der Wechselrichter würde seine eigene PV abregeln, obwohl Einspeisen sich lohnt - VoltPilot übernimmt wieder.",
	NativeStorageExport:          "Der Speicher hat über eine Minute ins Netz eingespeist, obwohl er nur den Verbrauch decken sollte - VoltPilot übernimmt wieder.",
	NativeHintExportWithHeadroom: "Die Anlage speist ein, obwohl der Speicher noch laden könnte - der Zähler des Wechselrichters sieht vermutlich die zweite PV-Anlage nicht.",

	NativeMeterLocationMissing: "Der Zählerort des Wechselrichters ist nicht angegeben - selbst regeln darf er nur mit einem Zähler am Netzpunkt. VoltPilot regelt nach.",
	NativeMeterElsewhere:       "Der Zähler des Wechselrichters sitzt nicht am Netzpunkt - er sieht nicht die ganze Anlage. VoltPilot regelt nach.",
	NativeMeterImplausible:     "Der Zähler des Wechselrichters passt nicht zum Netz-Zähler der Box - VoltPilot regelt nach, bis der Zählerort geklärt ist.",
	NativeSecondRegulator:      "Am selben Netzpunkt regelt ein weiterer Speicher selbst - zwei Regler auf einem Zähler schaukeln sich auf. VoltPilot regelt nach.",
}

// NativeReasonText is the German sentence for a reason code ("" for an unknown
// code - a word we do not understand must not become a sentence).
func NativeReasonText(code string) string { return nativeReasonText[code] }

// nativeEngagedText names WHAT the device does by itself - "regelt den
// Verbrauch" would be a false sentence while it stores a surplus.
func nativeEngagedText(intent string) string {
	switch intent {
	case NativeIntentSurplusCharge:
		return "Der Wechselrichter lädt den Überschuss gerade selbst in den Speicher."
	case NativeIntentSelfConsumption:
		return "Der Wechselrichter regelt Laden und Entladen gerade selbst."
	default:
		return NativeReasonText(NativeEngaged)
	}
}

// IntentOpensCharge reports whether an intent lets the device CHARGE by itself
// (E↑, E, E~) - the leader is then the inner loop of the feed-in cascade (K6).
func IntentOpensCharge(intent string) bool { return opensCharge(intent) }

// NativeModeFor is the battery_mode word on edge/setpoint for an intent:
// "native" for the pre-existing E↓ primitive (byte-identical for every Layer 1
// that predates K4b), "native_window" for the window intents. A Layer 1 that
// does not know "native_window" treats it as the ordinary setpoint path - it
// writes the reference setpoint and never confirms, so the core withdraws the
// intent after its grace. That is the additive contract's safety argument.
func NativeModeFor(intent string) string {
	if intent == NativeIntentCoverLoad {
		return "native"
	}
	return "native_window"
}

// opensDischarge / opensCharge: which sides an executable intent opens.
func opensDischarge(intent string) bool {
	return intent == NativeIntentCoverLoad || intent == NativeIntentSelfConsumption
}
func opensCharge(intent string) bool {
	return intent == NativeIntentSurplusCharge || intent == NativeIntentSelfConsumption
}

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
	// GridChargeBlocked is that proof, from Layer 1's readback: read back in the
	// device's own mode once Proven, or - before the hand-over - from the
	// executor's pre-hand-over read of the same register. nil = the device did
	// not say - which counts as NOT proven, never as "fine" (see step 8 of
	// Decide for WHEN it is owed).
	GridChargeBlocked *bool
	// Proven is Layer 1's evidence that the device really is in its own
	// regulation right now (a fresh readback whose mode is "native" and whose
	// state registers held).
	Proven bool

	// --- K4b: Absicht + Fenster ---

	// Intent is the plan intent's wire word (IntentFor) for an OPEN plan window,
	// "" for a point. NeedsWindow is Intent.NeedsWindow.
	Intent      string
	NeedsWindow bool
	// Window is the plan window after ClipWindow.
	Window Window
	// Levers is Layer 1's report of its certified levers; nil = not reported.
	// Without a report only the pre-existing E↓ path exists (Duty), exactly as
	// before K4b - a window intent needs a lever Layer 1 NAMED.
	Levers *NativeLevers
	// PersistentWriteBudget is the day budget of a persistent lever the
	// device's control profile states (catalog/control-profiles
	// schreibbudget.dauerspeicher_je_tag); 0 = no statement, the Vorgabe
	// NativeWriteBudgetPerDay applies. Whether the lever IS persistent stays
	// Layer 1's report (Levers.Persistent) - the profile never releases a lever.
	PersistentWriteBudget int
	// ProvenIntent is the intent the proving readback says the primitive
	// realises (native.intent). A window intent is only proven by its own word;
	// E↓ also by silence (a pre-K4b Layer 1 never says it).
	ProvenIntent string
	// GridKw (+ import) / BatteryKw (+ charge) are the measured grid point and
	// battery; SocMaxPct the configured upper SoC bound. NaN = unknown.
	GridKw, BatteryKw float64
	SocMaxPct         float64

	// --- K5: Deye Überschuss-Übergabe ---

	// ProvenCurtailsOwnPv is Layer 1's statement on the proving readback that the
	// executed primitive throttles the device's own PV when the storage cannot
	// take more (native.curtails_own_pv).
	ProvenCurtailsOwnPv bool
	// CurtailmentWanted: the plan caps the PV in this slot (negative price,
	// §51) - then that side effect is exactly what the slot asks for.
	CurtailmentWanted bool

	// --- K6: Führungsgerät ---

	// LeaderRefusal is guards.LeaderFor's refusal code ("" = the selection is
	// the connection point's leader and may regulate itself). It gates EVERY
	// device-regulated intent, the pre-existing E↓ path included: a device that
	// cannot see the whole connection point regulates the wrong quantity no
	// matter which side of the window it covers.
	LeaderRefusal string
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

	// Intent is the executable intent word while Native (cover_load for the
	// pre-existing mode), Mode its battery_mode word (NativeModeFor).
	Intent string
	Mode   string
	// Window is the window published with the intent: the clipped window,
	// narrowed only within a slot (never re-widened before the next slot, so a
	// SoC hovering at a bound cannot toggle the device's limits).
	Window Window
	// Hint is an observation without take-back (NativeHintExportWithHeadroom),
	// HintText its sentence; both "" when nothing is to be said.
	Hint     string
	HintText string
	// WritesToday counts the mode changes (enter, change, leave) of this day.
	WritesToday int
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

	// K4b per-slot state: the narrowed window, and the first-seen times of the
	// charge-side conditions (zero = not currently seen).
	win                         Window
	winSet                      bool
	gridChargeSince, dischSince time.Time
	exportSince                 time.Time
	// K5: first-seen time of "charging at the limit while exporting" on a
	// primitive that throttles its own PV.
	atLimitSince time.Time
	// First-seen time of "the storage feeds into the grid" (NativeStorageExport).
	storageExportSince time.Time
	// The day's write counter (§6.6): published = the battery_mode/intent the
	// last tick published ("" = setpoint), day = the counter's day.
	published string
	day       time.Time
	writes    int
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
	d := n.decide(now, in)
	// The day's write counter (§6.6): every change of what the setpoint topic
	// asks of the device - enter, change, leave - is one write on the device.
	pub := ""
	if d.Native {
		pub = d.Mode + "/" + d.Intent
	}
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if !day.Equal(n.day) {
		n.day, n.writes = day, 0
	}
	if pub != n.published {
		n.writes++
		n.published = pub
	}
	d.WritesToday = n.writes
	return d
}

// executable is Box ② (concept §6.1 step 3): which intent the DEVICE is asked
// to regulate. Without a Layer-1 report only the pre-existing E↓ path exists,
// keyed on the cloud duty exactly as before K4b - a Layer 1 that predates the
// report behaves byte-for-byte as it did. With a report, the plan intent needs
// a lever Layer 1 NAMED for exactly that intent (and a window lever for a
// policy bound narrower than the intent's natural window).
func executable(in NativeInput) (intent, reason string) {
	legacy := in.Duty == NativeDutyCoverLoad || in.Duty == NativeDutyUnplanned
	if in.Levers == nil {
		switch {
		case legacy:
			return NativeIntentCoverLoad, ""
		case in.Intent != "":
			return "", NativeNoLever
		default:
			return "", NativeNoDuty
		}
	}
	want := in.Intent
	if want == "" && legacy {
		want = NativeIntentCoverLoad
	}
	switch {
	case want == "":
		return "", NativeNoDuty
	case !in.Levers.Has(want):
		return "", NativeNoLever
	case in.NeedsWindow && (want == NativeIntentCoverLoad || !in.Levers.Window):
		// E↓'s certified primitive has no window; a narrower one is the box's.
		return "", NativeNoLever
	}
	return want, ""
}

func (n *NativeMode) decide(now time.Time, in NativeInput) NativeDecision {
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
	// 2. No open window in this slot (or no lever for it) -> the ordinary
	//    setpoint path, and the slot latch is cleared (a new slot may be native
	//    again). Box ②: see executable.
	intent, why := executable(in)
	if intent == "" {
		n.reset()
		return refuse(why)
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
		n.clearSlotState()
	}
	// 3b. K6: only the connection point's leader may regulate itself. A
	//     refusal while nothing is handed over; a take-back (latched for the
	//     slot) when the verdict turns while the device regulates - e.g. the
	//     meter comparison flips to "passt nicht" mid-slot.
	if in.LeaderRefusal != "" {
		if n.engaged {
			return takeBack(in.LeaderRefusal)
		}
		n.since = time.Time{}
		return refuse(in.LeaderRefusal)
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
	// The proof is the intent's OWN: a readback that proves some other primitive
	// is not a proof of this one. E↓ is also proven by silence, because a Layer 1
	// that predates K4b never names it.
	proven := in.Proven && (in.ProvenIntent == intent ||
		(intent == NativeIntentCoverLoad && in.ProvenIntent == ""))
	// 7. The reserve floor. The device's own floor is not ours, so an unknown
	//    platform floor means no native mode at all - never a guessed one. The
	//    take-back only concerns an intent that may discharge.
	if in.FloorPct == nil {
		n.since = time.Time{}
		return refuse(NativeNoFloor)
	}
	if opensDischarge(intent) &&
		(math.IsNaN(in.SocPct) || in.SocPct <= *in.FloorPct+NativeFloorMarginPct) {
		return takeBack(NativeFloorReached)
	}
	// 8. EEG: the ONE compliance rule that moves into the device's own
	//    configuration when we stop commanding. Unknown is not proven.
	//
	//    ⚠ WHEN the proof is owed decides whether the mode can exist at all. The
	//    proof is a READ of the device, and the executor only reads it once our
	//    intent stands - so demanding it before the intent was ever published
	//    made the mode unreachable on every EEG site (the first tick latched
	//    this take-back, no intent reached the wire, the device never went
	//    native, the proof never came). The order is therefore:
	//      - the device SAID it may charge from the grid (before or after the
	//        hand-over): take back at once;
	//      - the device regulates itself (Proven) without saying it cannot:
	//        take back at once - the hand-over is only as good as this answer;
	//      - not handed over yet and not answered yet: the intent may stand
	//        PENDING, because it is a request, not a hand-over. Layer 1 hands an
	//        EEG site over only after its own pre-hand-over read found the
	//        device's grid charging disabled (deyeNativePrecondition, 0x00AC),
	//        and a tier that cannot read such a register refuses EEG sites
	//        outright. The grace below bounds the wait, and names THIS reason
	//        if it closes without an answer.
	if in.SolarOnlyCharge {
		if in.GridChargeBlocked != nil && !*in.GridChargeBlocked {
			return takeBack(NativeGridChargeUnproven)
		}
		if in.GridChargeBlocked == nil && proven {
			return takeBack(NativeGridChargeUnproven)
		}
	}
	// 9. The billing peak. In native mode there is no lever left, so a threatened
	//    quarter hour is answered by taking the lever back.
	if in.PeakThreatened {
		return takeBack(NativePeakThreatened)
	}
	// 10. E↑ has nothing left to store at the upper SoC bound.
	if intent == NativeIntentSurplusCharge && !math.IsNaN(in.SocPct) && in.SocMaxPct > 0 &&
		in.SocPct >= in.SocMaxPct {
		return takeBack(NativeStorageFull)
	}
	// 11. The window (only where Layer 1 reports levers: a pre-K4b Layer 1 never
	//     sees one). It is narrowed within the slot, never re-widened, so a
	//     bound that toggles (SoC at its edge, a BMS limit) costs at most one
	//     device write per side and slot.
	win := in.Window
	if in.Levers != nil {
		if n.winSet {
			win.MinKw = math.Max(win.MinKw, n.win.MinKw)
			win.MaxKw = math.Min(win.MaxKw, n.win.MaxKw)
			if win.MinKw > win.MaxKw {
				win.MinKw = win.MaxKw
			}
		}
		if win.Point() {
			n.since = time.Time{}
			return refuse(NativeWindowClosed)
		}
		if !win.ContainsZero() {
			n.since = time.Time{}
			return refuse(NativeWindowForcesFlow)
		}
	}
	// 12. The write budget of a persistent lever (§6.6, F12): a hand-over costs
	//     the entry AND its exit, so it needs room for both.
	if in.Levers != nil && in.Levers.Persistent && !n.engaged &&
		n.writes+2 > persistentWriteBudget(in.PersistentWriteBudget) {
		n.since = time.Time{}
		return refuse(NativeWriteBudget)
	}
	// 13. The charge side (only while the device regulates, and only for an
	//     intent that may charge): what the device does with the surplus is now
	//     ITS decision, so the supervision watches the effect.
	// 13a. The discharge side (vp-wr-deye-tou-schreibbudget): no intent the
	//      device regulates may sell storage energy. Storage export is the part
	//      of the export the battery supplies - min(discharge, export) - so PV
	//      feeding in beside a covering battery never counts.
	if proven && opensDischarge(intent) {
		grid, batt := in.GridKw, in.BatteryKw
		exporting := !math.IsNaN(grid) && !math.IsNaN(batt) && math.Max(batt, grid) < -NativeChargeSideLimitKw
		if !exporting {
			n.storageExportSince = time.Time{}
		} else {
			if n.storageExportSince.IsZero() {
				n.storageExportSince = now
			}
			if now.Sub(n.storageExportSince) > NativeChargeSideHold {
				return takeBack(NativeStorageExport)
			}
		}
	} else {
		n.storageExportSince = time.Time{}
	}
	var hint string
	if proven && opensCharge(intent) {
		held := func(cond bool, since *time.Time) bool {
			if !cond {
				*since = time.Time{}
				return false
			}
			if since.IsZero() {
				*since = now
			}
			return now.Sub(*since) > NativeChargeSideHold
		}
		grid, batt := in.GridKw, in.BatteryKw
		known := !math.IsNaN(grid) && !math.IsNaN(batt)
		if held(known && math.Min(batt, grid) > NativeChargeSideLimitKw, &n.gridChargeSince) {
			return takeBack(NativeChargeFromGrid)
		}
		if held(known && intent == NativeIntentSurplusCharge && batt < -NativeChargeSideLimitKw,
			&n.dischSince) {
			return takeBack(NativeDischargeAgainstIntent)
		}
		// K5 (§6.3): a primitive that regulates the grid to 0 throttles its OWN
		// PV once the storage cannot take more - at a positive price that is
		// feed-in given away, so the battery goes back to the setpoint path.
		if in.ProvenCurtailsOwnPv && !in.CurtailmentWanted {
			if !math.IsNaN(in.SocPct) && in.SocMaxPct > 0 && in.SocPct >= in.SocMaxPct-NativeCeilingMarginPct {
				return takeBack(NativeOwnPvCurtailed)
			}
			if held(known && grid < -NativeChargeSideLimitKw && batt >= win.MaxKw-NativeChargeSideLimitKw,
				&n.atLimitSince) {
				return takeBack(NativeOwnPvCurtailed)
			}
		} else {
			n.atLimitSince = time.Time{}
		}
		headroom := !math.IsNaN(in.SocPct) && (in.SocMaxPct <= 0 || in.SocPct < in.SocMaxPct)
		if held(known && headroom && grid < -NativeChargeSideLimitKw &&
			batt < win.MaxKw-NativeChargeSideLimitKw, &n.exportSince) {
			hint = NativeHintExportWithHeadroom
		}
	} else {
		n.gridChargeSince, n.dischSince, n.exportSince = time.Time{}, time.Time{}, time.Time{}
		n.atLimitSince = time.Time{}
	}
	if in.Levers != nil {
		n.win, n.winSet = win, true
	}

	// 14. Native. Proven by Layer 1, or pending inside the grace window.
	d := NativeDecision{Native: true, Duty: in.Duty, Intent: intent, Mode: NativeModeFor(intent),
		Window: win, Hint: hint, HintText: NativeReasonText(hint)}
	if proven {
		n.since = now
		n.engaged = true
		d.Proven, d.Reason, d.Text = true, NativeEngaged, nativeEngagedText(intent)
		return d
	}
	if n.since.IsZero() {
		n.since = now
	}
	if now.Sub(n.since) > n.grace {
		// The intent stood, the device never confirmed it. That is not a native
		// mode, it is an unanswered request - and "we stopped writing" must never
		// be allowed to look like "the inverter took over". On an EEG site that
		// never even answered the grid-charge question, THAT is the cause to name.
		if in.SolarOnlyCharge && in.GridChargeBlocked == nil {
			return takeBack(NativeGridChargeUnproven)
		}
		return takeBack(NativeUnproven)
	}
	n.engaged = true
	d.Reason, d.Text = NativePending, NativeReasonText(NativePending)
	return d
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
	n.clearSlotState()
}

func (n *NativeMode) clearSlotState() {
	n.win, n.winSet = Window{}, false
	n.gridChargeSince, n.dischSince, n.exportSince = time.Time{}, time.Time{}, time.Time{}
	n.atLimitSince = time.Time{}
	n.storageExportSince = time.Time{}
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
