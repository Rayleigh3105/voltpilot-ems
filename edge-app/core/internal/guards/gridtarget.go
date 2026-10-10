// Netzseitiger Drossel-Slot (concept vp-deye-netzseitig-drossel-k2, package P3):
// in a slot whose plan CURTAILS the plant (negative price / zero export) hand
// the GRID CONNECTION POINT to the hybrid inverter's own grid-side regulator
// (Deye remote block, 1104 = 2) with the target "0 W at the meter", instead of
// commanding a battery watt value and leaving the device's own PV to export.
//
// WHY. The curtailment chain reaches the AC-coupled PV inverters only (Fronius
// WMaxLimPct). The hybrid's own PV is "nicht regelbare Erzeugung": once the
// Fronius units stand at 0 and the storage is full, that share leaves the site
// at a negative price - and the portal says "Sonne wird gedrosselt" while it
// does. The grid-side remote mode closes exactly that gap: the device charges
// the storage FIRST and throttles its OWN PV for the rest, the AC-coupled units
// keep their caps (Netz-Sollwert-Test Herzogau 08.10.2026: the grid point
// followed the target, the Fronius units were untouched).
//
// ⚠ THE ONE SENTENCE OF nativemode.go APPLIES HERE WORD FOR WORD: SOLLWERT
// WEGLASSEN HEISST NICHT AUFSICHT WEGLASSEN. In grid mode there is no battery
// setpoint left for guards.Clamp to clamp - the device leads the battery
// (Captain decision E4) and, per field report, ignores its own SoC limits in
// remote mode: it discharges to 0 % to hold the target. So every guard that bit
// through the setpoint becomes an OBSERVATION with a NAMED TAKE-BACK, and this
// type is that supervision. It is pure: no I/O, no clock of its own, every fact
// passed in, so all of it is provable without a device.
//
// WHEN (concept §2.6, the entry rule in one sentence): grid side only when the
// slot carries a curtailment (pv_limit_kw) AND the plan does not discharge the
// battery AND the SoC is inside its window. Never for the registered feed-in
// limit - the AC-coupled units hold that one, and the feed-in watchdog stays
// theirs (E3).
//
// THE SPLIT is the house's: the CORE knows the plan, the measurements and the
// reserve floor; only LAYER 1 knows the register map and therefore whether THIS
// exact model has the released grid-side lever. So the core publishes an INTENT
// (battery_mode "grid_target" + grid_target_kw on edge/setpoint) and Layer 1
// answers with EVIDENCE (a readback whose registers show the grid side and the
// target). An intent that is never confirmed is withdrawn after a bounded
// grace. And registers alone prove nothing about the EFFECT: the proof of the
// effect is the measured grid point, watched for as long as the mode stands.
//
// SAFE STATE IS UNCHANGED: on any doubt this type returns to the battery-side
// setpoint path - the ordinary remote plan, which is also the way back on the
// wire (no second return sequence).
package guards

import (
	"math"
	"sync"
	"time"
)

// The CLOSED reason vocabulary of the grid-side throttling slot. Every outcome
// names its cause - the two engaged states, every refusal and every take-back.
// Machine-readable; the German sentence comes from GridTargetReasonText.
const (
	// GridTargetEngaged: the device regulates the connection point, and Layer 1
	// proved the grid side on the readback.
	GridTargetEngaged = "netzseitig_geregelt"
	// GridTargetPending: the intent is published, the device-side proof has not
	// arrived yet and the grace window is still open.
	GridTargetPending = "nachweis_ausstehend"

	// --- refusals of the entry rule (nothing is handed over) ---

	// GridTargetOff: the operator switched the inverter's own regulation off
	// (VP_NATIVE_SELF_REGULATION_ENABLED - one switch for "Gerät regelt").
	GridTargetOff = "abgeschaltet"
	// GridTargetNoCurtailment: this slot carries no pv_limit_kw - the ordinary
	// battery-side setpoint path.
	GridTargetNoCurtailment = "keine_abregelung"
	// GridTargetPlanStale: no fresh plan (a stale plan curtails nothing).
	GridTargetPlanStale = "plan_veraltet"
	// GridTargetPlanDischarges: the plan discharges the battery in this slot. In
	// grid mode the DEVICE would lead the battery by its own logic - a conflict
	// the plan wins.
	GridTargetPlanDischarges = "plan_entlaedt"
	// GridTargetNoLever: Layer 1 reported no released grid-side lever for this
	// exact model - the certificate is its own, never the core's guess.
	GridTargetNoLever = "kein_hebel"
	// GridTargetOtherMode: the device already regulates itself in this slot
	// (native self-regulation). The two modes exclude each other.
	GridTargetOtherMode = "anderer_modus"
	// GridTargetSharedControl: the box holds a share document (GEMEINSAME
	// STEUERUNG, AP-15) - several boxes hold ONE connection point by shares,
	// each through the levers the box itself commands (the battery value, the
	// PV caps). On the grid side the DEVICE would hold that meter and take up
	// every adjustment of the box, so the share watchdogs, the frozen-value
	// probe and the step probe would read a meter that no longer answers them.
	// The two are not composed: with a document the slot stays on the battery
	// side, exactly as without this package.
	GridTargetSharedControl = "gemeinsame_steuerung"
	// GridTargetForeignHolder: plant rest, a non-plan arbitration holder or an
	// owner claim owns the battery.
	GridTargetForeignHolder = "fremder_halter"
	// GridTargetNotAuthorized: the kill-switch is off or this model is not
	// certified for control - then nothing may be written, in either direction.
	GridTargetNotAuthorized = "nicht_freigegeben"
	// GridTargetNoFloor: the cloud did not publish effective_floor_soc_pct. In
	// grid mode the device does not honour its own SoC limits, so an unknown
	// platform floor means no grid mode at all - never a guessed one.
	GridTargetNoFloor = "kein_reserve_boden"
	// GridTargetSocOutside: the SoC is unknown or outside the entry window
	// (at/near the reserve floor).
	GridTargetSocOutside = "ladestand_ausserhalb"

	// --- take-backs (latched for the rest of the slot) ---

	// GridTargetFloorReached: SoC at the reserve floor + GridTargetFloorMarginPct.
	// The device would discharge to 0 % to hold the target.
	GridTargetFloorReached = "reserve_boden"
	// GridTargetStaleMeasurement: grid point / SoC are not fresh - a blind
	// supervision is not one.
	GridTargetStaleMeasurement = "messung_nicht_frisch"
	// GridTargetNoReadback: Layer 1's control readback is lost or does not hold.
	GridTargetNoReadback = "keine_rueckmeldung"
	// GridTargetUnproven: the grace window closed without device-side evidence.
	GridTargetUnproven = "nachweis_fehlt"
	// GridTargetNotFollowing: the measured grid point stayed outside the band
	// around the target for longer than GridTargetFollowHold although the device
	// could have answered - it did not adopt the mode, or it does not regulate.
	GridTargetNotFollowing = "netz_folgt_nicht"
	// GridTargetSlotEnd: the slot that carried the curtailment ended and the
	// next one does not qualify - the ordinary end of the mode. Reported on the
	// transition tick only (GridTargetDecision.Ended).
	GridTargetSlotEnd = "slot_ende"

	// GridTargetHintExhausted is a HINT, never a take-back: the plant still
	// exports although the device feeds nothing in any more (own PV throttled
	// away, the storage takes what it takes). What is left comes from the other
	// producers - theirs to cap (the feed-in cascade), and a take-back would
	// only release the device's own PV on top (live test 08.10.2026, step
	// "Ziel 0": the device sets its OWN share, never the Fronius feed-in).
	GridTargetHintExhausted = "eigener_anteil_ausgeschoepft"
)

const (
	// GridTargetNullExportKw is THE target of the throttling slot (E3): 0 W at
	// the connection point. Our contract is + = import / - = feed-in.
	GridTargetNullExportKw = 0.0
	// GridTargetMaxKw is the highest target ever commanded: +50 W, the HV
	// factory value of the device's own zero-export regulation. A positive grid
	// target is an IMPORT target - the device would charge the storage from the
	// grid. EEG safety by construction (concept §1.9 (4)), enforced by
	// ClampGridTarget here and again by Layer 1.
	GridTargetMaxKw = 0.05
	// GridTargetFloorMarginPct is the headroom above the reserve floor at which
	// the battery is taken back - the native mode's margin, for its reason: the
	// take-back is not instant (intent -> Layer 1 -> return sequence -> device).
	GridTargetFloorMarginPct = NativeFloorMarginPct
	// GridTargetChargeCeilingPct documents Captain decision E4 (01.09.2026): in
	// the throttling slot the DEVICE leads the battery, and its charge up to
	// 100 % is ACCEPTED - the LFP BMS ends the charge. There is deliberately NO
	// take-back at the configured upper bound (95 %): a full storage is exactly
	// the state in which this mode does its job (the device throttles its own
	// PV), and taking the battery back there would return the device to battery
	// side, where its PV feeds in freely - at a negative price. The constant is
	// the upper edge of the entry window; a higher reading is not a state of
	// charge.
	GridTargetChargeCeilingPct = 100.0
	// GridTargetFollowBandKw is the band around the target inside which the
	// measured grid point counts as "following" (package acceptance: export ->
	// 0 +/- 0,5 kW; the live test held 0,4 kW at a 28 kW target).
	GridTargetFollowBandKw = 0.5
	// GridTargetFollowHold is how long the grid point may stay outside the band
	// before the mode counts as not following (concept §4 P3: "binnen 60 s").
	// The device answers in seconds (live: ~7 s for a 2 kW step); a minute is
	// far beyond its loop and beyond one slow logger cycle (5-25 s).
	GridTargetFollowHold = 60 * time.Second
	// GridTargetPlanRestEpsKw: "the plan does not discharge" tolerates the
	// classification noise of a resting slot (the tolerance of guards.classify).
	GridTargetPlanRestEpsKw = 0.05
	// gridTargetDefaultGrace is the fallback proof window (see nativeDefaultGrace).
	gridTargetDefaultGrace = 60 * time.Second
)

var gridTargetReasonText = map[string]string{
	GridTargetEngaged: "Der Wechselrichter regelt den Netzanschluss gerade selbst auf „keine Einspeisung“ " +
		"und drosselt dafür seine eigene PV.",
	GridTargetPending: "Der Wechselrichter soll den Netzanschluss selbst regeln - die Rückmeldung des Geräts steht noch aus.",

	GridTargetOff:            "Die Wechselrichter-Automatik ist abgeschaltet.",
	GridTargetNoCurtailment:  "In diesem Zeitabschnitt sieht der Fahrplan keine Abregelung vor.",
	GridTargetPlanStale:      "Es liegt kein aktueller Fahrplan vor.",
	GridTargetPlanDischarges: "Der Fahrplan entlädt den Speicher in diesem Zeitabschnitt - VoltPilot gibt den Sollwert vor.",
	GridTargetNoLever:        "Für dieses Wechselrichter-Modell ist die netzseitige Regelung nicht freigegeben.",
	GridTargetOtherMode:      "Der Wechselrichter regelt in diesem Zeitabschnitt bereits selbst.",
	GridTargetSharedControl:  "Mehrere Boxen steuern diesen Netzanschluss gemeinsam - VoltPilot gibt den Sollwert vor.",
	GridTargetForeignHolder:  "Eine Regel, ein Handeingriff oder die Anlagen-Pause hat gerade Vorrang.",
	GridTargetNotAuthorized:  "Die Steuerung dieses Wechselrichters ist nicht freigegeben.",
	GridTargetNoFloor:        "Die Reserve-Untergrenze der Anlage ist nicht bekannt - netzseitig achtet der Wechselrichter nicht auf seine eigenen Ladegrenzen.",
	GridTargetSocOutside:     "Der Ladestand ist unbekannt oder zu nah an der Reserve - VoltPilot gibt den Sollwert vor.",

	GridTargetFloorReached:     "Der Ladestand hat die Reserve erreicht - VoltPilot übernimmt den Speicher wieder.",
	GridTargetStaleMeasurement: "Es fehlen aktuelle Messwerte, um den Wechselrichter dabei zu beaufsichtigen - VoltPilot übernimmt wieder.",
	GridTargetNoReadback:       "Der Wechselrichter meldet gerade nichts zurück - VoltPilot übernimmt wieder.",
	GridTargetUnproven:         "Der Wechselrichter hat die netzseitige Regelung nicht bestätigt - VoltPilot übernimmt wieder.",
	GridTargetNotFollowing:     "Der Netzanschluss ist dem Ziel über eine Minute nicht gefolgt - VoltPilot übernimmt wieder.",
	GridTargetSlotEnd:          "Der Zeitabschnitt mit Abregelung ist zu Ende - VoltPilot gibt den Sollwert wieder vor.",

	GridTargetHintExhausted: "Der Wechselrichter speist selbst nichts mehr ein - die verbleibende Einspeisung stammt von den anderen Erzeugern.",
}

// GridTargetReasonText is the German sentence for a reason code ("" for an
// unknown code - a word we do not understand must not become a sentence). The
// K6 leader refusals keep their own words and sentences (guards/leader.go via
// nativemode.go): "Gerät regelt" needs the Führungsgerät on either path.
func GridTargetReasonText(code string) string {
	if t, ok := gridTargetReasonText[code]; ok {
		return t
	}
	switch code {
	case NativeMeterLocationMissing, NativeMeterElsewhere, NativeMeterImplausible, NativeSecondRegulator:
		return NativeReasonText(code)
	}
	return ""
}

// ClampGridTarget is the EEG clamp of the grid target: never above
// GridTargetMaxKw (an import target would charge the storage from the grid),
// and a value that is not a number is the null export. It is a property of the
// code, not a promise - Layer 1 applies the same bound again.
func ClampGridTarget(kw float64) float64 {
	if math.IsNaN(kw) || math.IsInf(kw, 0) {
		return GridTargetNullExportKw
	}
	if kw > GridTargetMaxKw {
		return GridTargetMaxKw
	}
	return kw
}

// GridTargetInput is every fact the decision needs, passed in whole.
type GridTargetInput struct {
	// Enabled is the operator's own switch for "Gerät regelt"
	// (VP_NATIVE_SELF_REGULATION_ENABLED). Not the safety gate - Layer 1's
	// release and the two write gates are.
	Enabled bool
	// SlotStart identifies the active slot. A CHANGE re-arms: a take-back is
	// latched for the rest of ITS slot.
	SlotStart time.Time
	// PlanFresh is the plan's own freshness.
	PlanFresh bool
	// CurtailmentWanted: the slot carries pv_limit_kw - the plan caps the plant
	// here (negative price / zero export).
	CurtailmentWanted bool
	// PlannedKw is the plan's battery setpoint of this slot (+ charge /
	// - discharge), NaN when no slot is active.
	PlannedKw float64
	// Lever is Layer 1's report that THIS selection carries the released
	// grid-side lever (native_capabilities.intents contains GridTargetLever).
	// Not reported = no lever.
	Lever bool
	// OtherModeActive: the device already regulates itself in this slot (the
	// native self-regulation published its intent on the previous tick).
	OtherModeActive bool
	// SharedControl: the box holds a share document (GEMEINSAME STEUERUNG) -
	// see GridTargetSharedControl.
	SharedControl bool
	// HolderExempt is the arbitration boundary of every market-economic
	// execution choice: no plant rest, no non-plan holder, no owner claim.
	HolderExempt bool
	// Authorized is the core's control gate: kill-switch AND certification.
	Authorized bool
	// MeasurementsFresh / ReadbackHealthy are the two observation channels.
	MeasurementsFresh bool
	ReadbackHealthy   bool
	// SocPct is the measured state of charge (NaN = unknown).
	SocPct float64
	// FloorPct is the cloud-computed full reserve stack; nil = unknown.
	// SocMinPct is the configured technical floor - the higher of the two binds.
	FloorPct  *float64
	SocMinPct float64
	// Proven is Layer 1's evidence: a fresh, held readback whose registers show
	// the grid side and our target.
	Proven bool
	// GridKw is the measured connection point (+ import / - feed-in), BatteryKw
	// the measured battery (+ charge). NaN = unknown.
	GridKw, BatteryKw float64
	// OwnPvKw is the device's OWN measured PV (site PV minus every other fresh
	// producer). NaN = unknown - then a standing feed-in cannot be attributed
	// and counts as the device's.
	OwnPvKw float64
	// LeaderRefusal is guards.LeaderFor's refusal code ("" = the selection is
	// the connection point's Führungsgerät). A device whose meter does not see
	// the whole connection point regulates the wrong quantity to 0 (K6).
	LeaderRefusal string
}

// GridTargetDecision is one evaluation.
type GridTargetDecision struct {
	// Engage: publish battery_mode "grid_target" this tick. True while the mode
	// is PENDING as well as while it is PROVEN - Layer 1 has to be told in both.
	Engage bool
	// Proven: the device confirmed the grid side. Only a proven mode may be
	// reported to the cloud, so "wanted" and "achieved" can never be confused.
	Proven bool
	// TargetKw is the grid target to publish while Engage (already clamped).
	TargetKw float64
	// Reason is the closed-vocabulary code of the STANDING state, Text its
	// German sentence. Both are always filled.
	Reason string
	Text   string
	// Ended names WHY the mode ended, on the transition tick only (the previous
	// evaluation engaged, this one does not); EndedText its sentence. "Jede
	// Rücknahme trägt ihren Grund" - including the ordinary ones (slot end,
	// pause, kill-switch).
	Ended     string
	EndedText string
	// Following is the measured effect while proven: the grid point is inside
	// GridTargetFollowBandKw of the target. nil = not proven or not measured.
	Following *bool
	// Hint is an observation without take-back (GridTargetHintExhausted).
	Hint     string
	HintText string
}

// GridTargetLever is the word Layer 1 reports in native_capabilities.intents
// for a selection that carries the released grid-side lever, and the
// battery_mode word the core publishes for it.
const GridTargetLever = "grid_target"

// GridTargetMode carries the per-slot supervision state across setpoint ticks.
//
// ANTI-FLAP, asymmetric like NativeMode: entering is immediate, every TAKE-BACK
// is LATCHED FOR THE REST OF ITS SLOT. A side switch costs a write sequence in
// each direction and a device-side mode change; toggling it with the 10-second
// cadence because a measurement blinked would be worse for the plant than
// finishing the slot on the battery side. Consecutive qualifying slots do NOT
// toggle the device: the mode simply continues across the slot boundary.
type GridTargetMode struct {
	mu sync.Mutex
	// grace is how long an intent may stay unproven before it is withdrawn.
	grace time.Duration
	// slot is the slot the current arming belongs to; a different one re-arms.
	slot time.Time
	// since is when the intent was first published without proof (proof clock).
	since time.Time
	// latched is the take-back reason for this slot ("" = not taken back).
	latched string
	// engaged mirrors the last decision.
	engaged bool
	// First-seen times of "the grid point is off the target" while proven
	// (zero = not currently seen).
	importSince, exportSince time.Time
}

// NewGridTargetMode returns a released supervision with the given proof grace.
// A non-positive grace falls back to gridTargetDefaultGrace so a mis-wired
// caller cannot create an intent that is never withdrawn.
func NewGridTargetMode(grace time.Duration) *GridTargetMode {
	if grace <= 0 {
		grace = gridTargetDefaultGrace
	}
	return &GridTargetMode{grace: grace}
}

// Decide evaluates the supervision for this tick. The order is the safety
// argument and it is fail-closed at every step: the mode is entered only when
// EVERY fact is present and good, and left as soon as ONE is not.
func (g *GridTargetMode) Decide(now time.Time, in GridTargetInput) GridTargetDecision {
	g.mu.Lock()
	defer g.mu.Unlock()
	was := g.engaged
	slotChanged := !in.SlotStart.Equal(g.slot)
	d := g.decide(now, in)
	g.engaged = d.Engage
	if was && !d.Engage {
		d.Ended = d.Reason
		// The ordinary end: the slot that carried the curtailment is over and
		// the next one gives no cause of its own beyond "not such a slot".
		if slotChanged && (d.Reason == GridTargetNoCurtailment || d.Reason == GridTargetPlanDischarges ||
			d.Reason == GridTargetPlanStale) {
			d.Ended = GridTargetSlotEnd
		}
		d.EndedText = GridTargetReasonText(d.Ended)
	}
	return d
}

func (g *GridTargetMode) decide(now time.Time, in GridTargetInput) GridTargetDecision {
	refuse := func(code string) GridTargetDecision {
		g.since = time.Time{}
		g.clearFollow()
		return GridTargetDecision{Reason: code, Text: GridTargetReasonText(code)}
	}
	// A take-back is remembered for the rest of the slot (see the type doc).
	takeBack := func(code string) GridTargetDecision {
		g.latched = code
		return refuse(code)
	}
	// leave is "refuse while nothing is handed over, take back once it is": a
	// fact that is merely missing before the hand-over may still arrive, the
	// same fact lost DURING it ends the mode for the slot.
	leave := func(code string) GridTargetDecision {
		if g.engaged {
			return takeBack(code)
		}
		return refuse(code)
	}

	// 1. The operator's own switch, first - an emergency stop needs no reasoning.
	if !in.Enabled {
		g.reset()
		return refuse(GridTargetOff)
	}
	// 2. The entry rule, plan half (§2.6): a fresh plan whose slot CURTAILS and
	//    does not discharge the battery. Not such a slot -> the ordinary path,
	//    and the latch is cleared (the next such slot may be grid side again).
	if !in.PlanFresh {
		g.reset()
		return refuse(GridTargetPlanStale)
	}
	if !in.CurtailmentWanted {
		g.reset()
		return refuse(GridTargetNoCurtailment)
	}
	if math.IsNaN(in.PlannedKw) || in.PlannedKw < -GridTargetPlanRestEpsKw {
		g.reset()
		return refuse(GridTargetPlanDischarges)
	}
	// 3. A new slot re-arms: the previous slot's take-back does not bind here.
	//    The proof clock is NOT reset - a mode that continues across the
	//    boundary stays what it was.
	if !in.SlotStart.Equal(g.slot) {
		g.slot = in.SlotStart
		g.latched = ""
	}
	// 4. The certificate is Layer 1's: without its report of the released lever
	//    for THIS model nothing is asked of the device.
	if !in.Lever {
		return refuse(GridTargetNoLever)
	}
	// 4b. K6: only the connection point's leader may regulate it. A refusal
	//     while nothing is handed over, a take-back when the verdict turns
	//     while the device regulates (the meter comparison flips mid-slot).
	if in.LeaderRefusal != "" {
		return leave(in.LeaderRefusal)
	}
	// 4c. GEMEINSAME STEUERUNG: a connection point several boxes hold by shares
	//     is never handed to one device's own regulator - refused like K6, and
	//     taken back should the document arrive while the device regulates.
	if in.SharedControl {
		return leave(GridTargetSharedControl)
	}
	// 5. One device-regulated mode at a time.
	if in.OtherModeActive {
		return refuse(GridTargetOtherMode)
	}
	// 6. Somebody else owns the battery, or nothing may be written at all. Not
	//    latched - there is nothing of ours to take back that the ordinary plan
	//    does not take back by itself on this very tick.
	if !in.HolderExempt {
		return refuse(GridTargetForeignHolder)
	}
	if !in.Authorized {
		return refuse(GridTargetNotAuthorized)
	}
	// 7. This slot already handed the connection point back once.
	if g.latched != "" {
		return refuse(g.latched)
	}
	// 8. The two observation channels.
	if !in.MeasurementsFresh {
		return leave(GridTargetStaleMeasurement)
	}
	if !in.ReadbackHealthy {
		return leave(GridTargetNoReadback)
	}
	// 9. The reserve floor - the ONE bound the device does not enforce for us in
	//    grid mode. Unknown floor or unknown SoC: no grid mode at all.
	if in.FloorPct == nil {
		return leave(GridTargetNoFloor)
	}
	floor := math.Max(*in.FloorPct, in.SocMinPct)
	switch {
	case math.IsNaN(in.SocPct) || in.SocPct > GridTargetChargeCeilingPct:
		return leave(GridTargetSocOutside)
	case in.SocPct <= floor+GridTargetFloorMarginPct:
		if g.engaged {
			return takeBack(GridTargetFloorReached)
		}
		return refuse(GridTargetSocOutside)
	}

	target := ClampGridTarget(GridTargetNullExportKw)
	d := GridTargetDecision{Engage: true, TargetKw: target}

	// 10. Pending: the intent stands, the device has not confirmed it. Bounded
	//     by the grace - "we asked" must never be allowed to look like "it does".
	if !in.Proven {
		g.clearFollow()
		if g.since.IsZero() {
			g.since = now
		}
		if now.Sub(g.since) > g.grace {
			return takeBack(GridTargetUnproven)
		}
		d.Reason, d.Text = GridTargetPending, GridTargetReasonText(GridTargetPending)
		return d
	}
	g.since = now

	// 11. The EFFECT. Registers that hold prove nothing about what the meter
	//     does, so the measured grid point is watched for as long as the mode
	//     stands. An unknown grid point is a stale measurement by another name.
	if math.IsNaN(in.GridKw) {
		return takeBack(GridTargetStaleMeasurement)
	}
	dev := in.GridKw - target
	following := math.Abs(dev) <= GridTargetFollowBandKw
	d.Following = &following
	held := func(cond bool, since *time.Time) bool {
		if !cond {
			*since = time.Time{}
			return false
		}
		if since.IsZero() {
			*since = now
		}
		return now.Sub(*since) > GridTargetFollowHold
	}
	// IMPORT above the target: the device should cover it (own PV, then the
	// storage). A minute of that is a device that does not regulate.
	if held(dev > GridTargetFollowBandKw, &g.importSince) {
		return takeBack(GridTargetNotFollowing)
	}
	// FEED-IN beyond the target is the device's to answer only as far as its
	// OWN share reaches: own PV minus what the storage takes (a discharging
	// storage adds to it). Unknown share = the device's - never excused by
	// silence. A device that feeds nothing in any more is exhausted, not
	// disobedient: the rest belongs to the other producers' caps.
	exporting := dev < -GridTargetFollowBandKw
	ownShare := in.OwnPvKw - in.BatteryKw
	exhausted := exporting && !math.IsNaN(ownShare) && ownShare <= GridTargetFollowBandKw
	if held(exporting && !exhausted, &g.exportSince) {
		return takeBack(GridTargetNotFollowing)
	}
	if exhausted {
		d.Hint, d.HintText = GridTargetHintExhausted, GridTargetReasonText(GridTargetHintExhausted)
	}

	d.Proven = true
	d.Reason, d.Text = GridTargetEngaged, GridTargetReasonText(GridTargetEngaged)
	return d
}

// Engaged reports whether the last decision published the grid-target intent.
func (g *GridTargetMode) Engaged() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.engaged
}

// Release drops the supervision state (the setpoint path's early exits: without
// a reading, or while a bounded test owns the inverter, it cannot supervise).
func (g *GridTargetMode) Release() {
	g.mu.Lock()
	g.reset()
	g.engaged = false
	g.mu.Unlock()
}

func (g *GridTargetMode) reset() {
	g.slot = time.Time{}
	g.since = time.Time{}
	g.latched = ""
	g.clearFollow()
}

func (g *GridTargetMode) clearFollow() {
	g.importSince, g.exportSince = time.Time{}, time.Time{}
}
