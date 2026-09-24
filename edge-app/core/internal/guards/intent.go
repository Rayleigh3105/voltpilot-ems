// Absicht + Fenster (Box ①, concept vp-wechselrichter-eigenregelung-k1 §3/§6.1,
// package K4): the cloud's per-slot flags describe WHAT the battery should do in
// this quarter hour; this file turns them into ONE intent and ONE power window
// [MinKw ; MaxKw] (+ = charge, - = discharge, the setpoint contract's sign).
// Inside the window the goal is always the same - grid point -> 0 - so a window
// that is a POINT is a fixed setpoint (nothing to regulate), and an OPEN window
// is exactly a slot in which the box used to chase the measurement every 10 s.
//
// It is PURE and changes no contract: the flags are the frozen mqtt-schedule
// ones, and the words below only travel on the LOCAL bus (edge/setpoint) and in
// the additive heartbeat block. The shared vectors
// docs/contracts/v2/native-intent-window-vectors.json pin the mapping.
package guards

import "math"

// The wire words of an intent the DEVICE can be asked to regulate itself
// (battery_native_intent on edge/setpoint, native.intent on the readback). They
// name what the device does, not which flags produced it.
const (
	// NativeIntentCoverLoad (E↓): cover the house from the battery, never charge.
	// The pre-existing native mode (NativeDutyCoverLoad / NativeDutyUnplanned).
	NativeIntentCoverLoad = "cover_load"
	// NativeIntentSurplusCharge (E↑): store every surplus, never from the grid,
	// never discharge - the Herzogau case.
	NativeIntentSurplusCharge = "surplus_charge"
	// NativeIntentSelfConsumption (E, E~): charge the surplus AND cover the
	// deficit; E~ is the same intent with a charge cap below the rated power.
	NativeIntentSelfConsumption = "self_consumption"
)

// The intent KINDS of the concept's table (§3). Reported, never branched on by
// Layer 1: the device only ever sees the wire word plus the window.
const (
	IntentKindSelfConsumption = "E"       // [-max ; +max]
	IntentKindSurplusCharge   = "E_up"    // [0 ; +max]
	IntentKindCoverLoad       = "E_down"  // [-max ; 0]
	IntentKindThrottled       = "E_tilde" // charge side capped below the rated power
	IntentKindGridCharge      = "N"       // point > 0
	IntentKindHold            = "H"       // point = 0
	IntentKindSell            = "A"       // point < 0
)

// WindowPointToleranceKw: a window narrower than this is a point. One tenth of a
// kW is below every register resolution that matters and far below any
// economic effect, so "almost a point" never becomes a hand-over.
const WindowPointToleranceKw = 0.1

// IntentFlags are the slot's cloud flags (already gated by the caller's
// marketCorrectionsAllowed boundary) plus the one box rule that opens a window
// on its own (deficit_cover, guards/deficitcover.go).
type IntentFlags struct {
	ChargeFromSurplusOnly  bool // lower a planned charge to the surplus (trim)
	ChargeSurplusToBattery bool // raise the charge up to the surplus (absorb)
	CoverLoadFromBattery   bool // follow the deficit with the discharge
	LimitDischargeToLoad   bool // shrink a planned discharge to the deficit
	UnplannedLoadDischarge bool // rest slot: cover an unplanned deficit
	DeficitCover           bool // box rule: cover a measured deficit
}

// Intent is one slot's intent before the guards: the window the PLAN opens.
type Intent struct {
	// Kind is the concept letter (IntentKind*).
	Kind string
	// Word is the wire word for an open window ("" for a point).
	Word string
	// MinKw / MaxKw is the plan window (+ charge, - discharge).
	MinKw, MaxKw float64
	// NeedsWindow: a POLICY bound is narrower than the intent's natural window
	// (E~ charge cap, a discharge limited to the plan value, a charge floor) -
	// the device can only carry it with a certified window lever.
	NeedsWindow bool
}

// Open reports whether the plan window leaves anything to regulate.
func (i Intent) Open() bool { return i.MaxKw-i.MinKw >= WindowPointToleranceKw }

// IntentFor maps the flags onto the window, exactly as §3 of the concept:
//   - both charge flags               -> charge side [0 ; max]
//   - only charge_from_surplus_only   -> [0 ; planned]
//   - only charge_surplus_to_battery  -> [planned ; max]
//   - cover_load_from_battery, unplanned_load_discharge, deficit_cover
//     -> the discharge side opens fully
//   - limit_discharge_to_load         -> the discharge side opens up to the plan value
//   - no flag                         -> the point = the plan value.
//
// The charge flags only ever act on a non-negative command (the trim lowers a
// charge, the absorber raises a non-negative command) - exactly like the box
// rules they replace; with the discharge side opened the command can reach 0,
// so there they open the charge side as well (E = all three flags).
func IntentFor(plannedKw float64, f IntentFlags, maxChargeKw, maxDischargeKw float64) Intent {
	if math.IsNaN(plannedKw) || math.IsInf(plannedKw, 0) {
		plannedKw = 0
	}
	maxCh := math.Max(maxChargeKw, 0)
	maxDis := math.Max(maxDischargeKw, 0)
	lo, hi := plannedKw, plannedKw

	// Discharge side first: it may bring the command to 0, which is what lets the
	// charge flags act on a discharging plan value at all.
	switch {
	case f.CoverLoadFromBattery || f.UnplannedLoadDischarge || f.DeficitCover:
		lo = -maxDis
		hi = math.Max(hi, 0)
	case f.LimitDischargeToLoad && plannedKw < 0:
		hi = 0
	}
	// Charge side: only on a non-negative upper bound.
	if hi >= 0 {
		switch {
		case f.ChargeFromSurplusOnly && f.ChargeSurplusToBattery:
			lo = math.Min(lo, 0)
			hi = maxCh
		case f.ChargeFromSurplusOnly:
			lo = math.Min(lo, 0)
		case f.ChargeSurplusToBattery:
			hi = maxCh
		}
	}
	lo = math.Max(lo, -maxDis)
	hi = math.Min(hi, maxCh)
	if lo > hi {
		lo = hi
	}
	in := Intent{MinKw: round3(lo), MaxKw: round3(hi)}
	classify(&in, maxCh, maxDis)
	return in
}

// classify names the kind, the wire word and whether a policy bound needs a
// window lever. Kinds follow the window, not the flags - so the table of §3 and
// the vectors say the same thing.
func classify(in *Intent, maxCh, maxDis float64) {
	lo, hi := in.MinKw, in.MaxKw
	full := func(v, max float64) bool { return v >= max-WindowPointToleranceKw/2 }
	if !in.Open() {
		mid := (lo + hi) / 2
		switch {
		case mid > WindowPointToleranceKw/2:
			in.Kind = IntentKindGridCharge
		case mid < -WindowPointToleranceKw/2:
			in.Kind = IntentKindSell
		default:
			in.Kind = IntentKindHold
		}
		return
	}
	switch {
	case hi <= 0:
		in.Kind, in.Word = IntentKindCoverLoad, NativeIntentCoverLoad
		in.NeedsWindow = !full(-lo, maxDis)
	case lo >= 0 && full(hi, maxCh):
		in.Kind, in.Word = IntentKindSurplusCharge, NativeIntentSurplusCharge
		in.NeedsWindow = lo > 0
	case full(hi, maxCh):
		in.Kind, in.Word = IntentKindSelfConsumption, NativeIntentSelfConsumption
		in.NeedsWindow = !full(-lo, maxDis)
	default:
		// The charge side is capped below the rated power: E~, with or without an
		// open discharge side.
		in.Kind, in.Word = IntentKindThrottled, NativeIntentSelfConsumption
		in.NeedsWindow = true
	}
}

// Window is a power window after the guards.
type Window struct {
	MinKw, MaxKw float64
}

// Point reports whether nothing is left to regulate.
func (w Window) Point() bool { return w.MaxKw-w.MinKw < WindowPointToleranceKw }

// ContainsZero reports whether the device may reach "battery 0" inside the
// window. Self-regulation means grid -> 0, which can need exactly that; a window
// that excludes 0 FORCES a flow (a charge floor, a discharge floor) and is a
// command, not a regulation - the box keeps it.
func (w Window) ContainsZero() bool { return w.MinKw <= 0 && w.MaxKw >= 0 }

// ClipWindow runs BOTH bounds through the same guard chain as a setpoint
// (guards.Clamp: rated band, SoC window, BMS envelope, EEG solar-only charge,
// §14a) plus the platform reserve floor - before the window goes anywhere.
//
// ⚠ ONE deliberate refinement, and it is the whole difference between a window
// and a setpoint: the two GRID-SIDE stages (EEG "charge <= measured PV" and the
// observed §14a envelope) are computed for a battery sitting AT the value. A
// bound that does not force a flow - an upper charge cap, a lower discharge cap
// - is only reached by a device regulating the grid to 0, i.e. from the surplus
// itself, so those two stages cannot be violated through it; clipping it by the
// lagging PV measurement would only re-introduce the box's lag (F2, cloud gap).
// So: a bound that FORCES a flow (MinKw > 0, MaxKw < 0) and every point get the
// full chain; an open bound gets the device-side stages (rated band, SoC window,
// BMS). The EEG rule of an open window is carried by the device's PROVEN
// grid-charge block and the supervision "Laden bei Bezug" (nativemode.go).
func ClipWindow(in Intent, l Limits, r Reading, floorPct *float64) Window {
	lo, hi := in.MinKw, in.MaxKw
	if !in.Open() {
		v := Clamp((lo+hi)/2, l, r)
		lo, hi = v, v
	} else {
		deviceSide := func(kw float64) float64 {
			ll := l
			ll.SolarOnlyCharge = false
			rr := r
			rr.GridLimitKw = math.NaN()
			return Clamp(kw, ll, rr)
		}
		if lo > 0 {
			lo = Clamp(lo, l, r)
		} else {
			lo = deviceSide(lo)
		}
		if hi < 0 {
			hi = Clamp(hi, l, r)
		} else {
			hi = deviceSide(hi)
		}
	}
	// The platform floor (full reserve stack) is not the device's: no discharge
	// at or below it, on either bound.
	if floorPct != nil && known(r.SocPct) && r.SocPct <= *floorPct {
		lo = math.Max(lo, 0)
		hi = math.Max(hi, 0)
	}
	if lo > hi {
		lo = hi
	}
	return Window{MinKw: round3(lo), MaxKw: round3(hi)}
}

// NativeLevers is Layer 1's report of what the selected device can do on its
// own (edge/control/readback native_capabilities): the intents it has a
// CERTIFIED lever for, whether that lever honours window bounds, and whether it
// writes persistent memory. nil = the Layer 1 did not report (older flow, or an
// executor without the report) - see NativeMode.Decide for what that means.
type NativeLevers struct {
	Intents    []string
	Window     bool
	Persistent bool
}

// Has reports whether the device has a certified lever for intent.
func (l *NativeLevers) Has(intent string) bool {
	if l == nil {
		return false
	}
	for _, v := range l.Intents {
		if v == intent {
			return true
		}
	}
	return false
}
