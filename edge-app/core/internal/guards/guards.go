// Package guards holds the local plausibility / limit checks applied to
// EVERY battery setpoint before it is handed to Layer 1 for an inverter
// write. It is a faithful port of the Node-RED edge's "5 - Guards" flow
// (edge/node-red/flows.json fn-guards), extended to cap the §14a envelope on
// BOTH directions (import and export) and to enforce EEG solar-only charging
// against MEASURED values (Limits.SolarOnlyCharge, P5), matching the cloud
// MILP's semantics.
//
// The schedule contract (docs/contracts/mqtt-schedule.schema.json,
// x-failsafe) declares the plan ADVISORY: the edge clamps every commanded
// setpoint through these guards.
package guards

import "math"

// Limits are the battery's rated limits plus the operating SoC band.
type Limits struct {
	MaxChargeKw    float64 // > 0
	MaxDischargeKw float64 // > 0 (magnitude)
	SocMinPct      float64
	SocMaxPct      float64
	// SolarOnlyCharge enforces the EEG Ausschliesslichkeitsprinzip at
	// EXECUTION time (P5, the on-device twin of the cloud MILP's
	// solar-only-charge constraint): commanded CHARGE is clamped to the
	// MEASURED PV production max(pv, 0) (FK3, captain decision 2026-07-16;
	// measured PV is the inverter's ACTUAL output, i.e. already
	// post-curtailment, so this is the measured twin of the solver's charge <=
	// pv - curtail). Unknown pv clamps charge to 0. Set from the plan's
	// grid_charge_allowed=false (the schedule contract's optional field
	// mirroring site.netzladen_erlaubt). Zero value (false) = no extra clamp.
	// Discharge is never affected. Since EN-1 A (2026-11-02) a plant with
	// this posture is also under the Netzladen-Sperre (charge <= pv - load -
	// NetzladenReserveKw): on the v1 write path as the stateful LAST stage
	// before the write (NetzladenSperre), everywhere else through
	// StrictExclusivity below.
	SolarOnlyCharge bool

	// StrictExclusivity is the Netzladen-Sperre as a stateless stage (captain
	// decisions EN-1 A / EN-2 A, 2026-11-02, "der Speicher darf nie vom Netz
	// beladen werden, wenn Netzladen aus ist"; ported from MiSpeL MP-45 with a
	// reserve instead of a tolerance): commanded CHARGE <= max(measured pv -
	// measured load - NetzladenReserveKw, 0), unknown pv or load = 0. FK3 alone
	// let the house import its load in parallel, which at the connection point
	// is grid power in the storage (BNetzA MiSpeL, Anlage 1 S. 11). Set where
	// no stateful last stage follows: the v2 arbiter (entities: the plant's v1
	// posture, or an entity whose charge_from_grid_allowed is explicitly
	// false), a window bound that FORCES a flow in the device's own mode
	// (ClipWindow) and the First-Light test write. NOT on the v1
	// chain: the in-chain clamps run on the LIVE reading, whose load is derived
	// from a battery half that can lag the grid half by a measurement - a bound
	// on it cuts on the echo of every raise and swings; there the
	// NetzladenSperre rests on the follower's settled control reading.
	StrictExclusivity bool

	// Bms is what the battery's own protection currently ALLOWS (P5c,
	// Konzept vp-deye-diybms-luecke-l5 §3.2b/§3.3): a HARD upper bound on
	// top of everything else in this struct. nil = the pack said nothing,
	// and then nothing changes - a battery without a protection block, or
	// one whose block went silent, is governed by the other guards exactly
	// as before. It is a POINTER for that reason: a zero value that meant
	// "0 kW allowed" would shut down every plant that never had one.
	Bms *BmsEnvelope
}

// BmsEnvelope is the battery's own statement about what it currently allows,
// already converted to kilowatts (the guards' unit) by the caller.
//
// It is the on-device consumer of the P5c protection block: the SoC current
// staircase and the cell-voltage latch produce charge_limit_a /
// discharge_limit_a / charge_allowed / discharge_allowed, and the agent turns
// the amperes into kilowatts with the MEASURED pack voltage (BmsKw).
//
// ⚠ EVERY field is optional in the honest sense: NaN = "not said", and a
// not-said limit imposes NO cap - never a fabricated 0, which on a limit would
// read as "forbidden". A BLOCK, by contrast, is a statement and binds: it is
// the hysteresis hard stop, and 0 kW is exactly what it means.
type BmsEnvelope struct {
	// ChargeKw / DischargeKw are the allowed magnitudes; NaN = no statement.
	ChargeKw    float64
	DischargeKw float64
	// ChargeBlocked / DischargeBlocked are the hard stops. False means
	// "not blocked" only where the flag was actually reported - the agent
	// never sets one from silence.
	ChargeBlocked    bool
	DischargeBlocked bool
}

// BmsKw converts ONE current limit on the DC side into the power cap the guard
// chain works in. It is exported because it is contract arithmetic: the shared
// vectors (docs/contracts/v2/limit-protection-vectors.json, block `waechter`)
// pin it, and the Node-RED protection block that produces the amperes pins the
// same table on its side.
//
// WITHOUT a measured pack voltage there is NO cap (NaN): guessing a nominal
// voltage would invent a power limit no device ever stated, and the honest
// answer to "how many kilowatts is 22 A?" without a voltage is "unknown". The
// ONE exception is zero: 0 A are 0 kW at ANY voltage, so a zero limit never
// falls through for want of a voltage - which is exactly how the protection
// block reports a blocked direction.
func BmsKw(limitA, packVoltageV float64) float64 {
	if math.IsNaN(limitA) || math.IsInf(limitA, 0) || limitA < 0 {
		return math.NaN()
	}
	if limitA == 0 {
		return 0
	}
	if !known(packVoltageV) || math.IsInf(packVoltageV, 0) || packVoltageV <= 0 {
		return math.NaN()
	}
	return limitA * packVoltageV / 1000
}

// capChargeKw / capDischargeKw are the envelope's effective caps (+Inf = none).
func (b *BmsEnvelope) capChargeKw() float64 {
	if b == nil {
		return math.Inf(1)
	}
	if b.ChargeBlocked {
		return 0
	}
	if known(b.ChargeKw) && b.ChargeKw >= 0 {
		return b.ChargeKw
	}
	return math.Inf(1)
}

func (b *BmsEnvelope) capDischargeKw() float64 {
	if b == nil {
		return math.Inf(1)
	}
	if b.DischargeBlocked {
		return 0
	}
	if known(b.DischargeKw) && b.DischargeKw >= 0 {
		return b.DischargeKw
	}
	return math.Inf(1)
}

// speaks reports whether the envelope constrains anything at all.
func (b *BmsEnvelope) speaks() bool {
	return b != nil && (!math.IsInf(b.capChargeKw(), 1) || !math.IsInf(b.capDischargeKw(), 1))
}

// Reading is the subset of the latest inverter reading the guards need.
// Nil-able fields use NaN for "unknown" (a missing measurement never blocks
// operation, it just skips the guard that would need it).
type Reading struct {
	SocPct      float64 // NaN if unknown
	PvKw        float64 // NaN if unknown
	LoadKw      float64 // NaN if unknown
	GridLimitKw float64 // NaN if unknown (observed effective §14a envelope)
}

// Unknown is the "no value" marker for Reading fields.
func Unknown() float64 { return math.NaN() }

func known(v float64) bool { return !math.IsNaN(v) }

// Guard-chain stage names, reported by ClampTraced. They are CONTRACT
// vocabulary: the v2 arbitration events carry them verbatim in reasons[].stage
// (docs/contracts/v2/edge-desired.schema.json, $defs/arbitration).
const (
	StageRatedBand       = "guard:rated_band"
	StageSocWindow       = "guard:soc_window"
	StageSolarOnlyCharge = "guard:solar_only_charge"
	StageGridLimit14a    = "guard:grid_limit_14a"
	StagePeakShave       = "guard:peak_shave"
	StageLimitReduceOnly = "guard:limit_reduce_only"
	StageBmsLimit        = "guard:bms_limit"

	// StageStrictExclusivity names the Netzladen-Sperre (charge only from the
	// measured surplus minus the reserve, never while importing; the MiSpeL
	// MP-45 stage name, open vocabulary in edge-desired.schema.json).
	StageStrictExclusivity = "guard:strict_exclusivity"
)

// NetzladenReserveKw is R of the Netzladen-Sperre (captain decision EN-1 A,
// 2026-11-02: "R = 1 kW zum Start", scout vp-herzogau-eeg-netzstrom-scout
// §4.2): with grid charging not allowed the battery charges at most the
// MEASURED surplus pv - load minus this reserve, so the connection point keeps
// at least this much export while charging. Shared by the stateless clamp
// (ClampTraced stage 4b) and the stateful last stage (NetzladenSperre).
const NetzladenReserveKw = 1.0

// netzladenCapKw is the Netzladen-Sperre's bound on a charge command:
// max(pv - load - NetzladenReserveKw, 0), and 0 when pv or load is unknown.
func netzladenCapKw(r Reading) float64 {
	if !known(r.PvKw) || !known(r.LoadKw) || math.IsInf(r.PvKw, 0) || math.IsInf(r.LoadKw, 0) {
		return 0
	}
	return math.Max(r.PvKw-r.LoadKw-NetzladenReserveKw, 0)
}

// ClampStage records one guard stage that actually CHANGED the value while
// clamping a command (stages that pass a value through untouched are not
// reported - the v2 arbitration events only name the guards that bit).
type ClampStage struct {
	Stage string
	// Before/After are the value entering/leaving the stage (kW).
	Before, After float64
}

// Clamp applies the guard chain to a commanded battery power
// (+ = charge, - = discharge) and returns the safe setpoint:
//
//  1. clamp to the rated charge/discharge band,
//  2. SoC bounds: no charging at/above SocMax, no discharging at/below SocMin,
//  3. the BMS envelope (P5c, when Limits.Bms says anything): the battery's own
//     protection is a HARD upper bound - a current staircase turned into
//     kilowatts, and a hysteresis hard stop that means 0,
//  4. EEG solar-only charge (when Limits.SolarOnlyCharge): charge <=
//     max(measured pv, 0) - the FK3 clamp. Unknown pv clamps charge to 0 - a
//     compliance guard must not charge blind (unlike the advisory guards,
//     which skip on missing data). The later §14a export correction can only
//     ever raise charge to pv - load - limit <= pv, so it never re-violates
//     this clamp,
//     4b. the Netzladen-Sperre (with StrictExclusivity, EN-1 A): charge <=
//     max(measured pv - measured load - NetzladenReserveKw, 0) - no charging
//     while the connection point imports. Unknown pv or load clamps charge
//     to 0. Applied again after the §14a correction (6), which could
//     otherwise raise charge to pv - load - limit with a limit below the
//     reserve,
//  5. observed §14a envelope: predicted grid power (load + battery - pv,
//     + = import) must stay within [-gridLimit, +gridLimit],
//  6. re-apply the rated band AND the BMS envelope LAST - the §14a correction
//     can otherwise push the value outside either of them - and the
//     Netzladen-Sperre (4b) with them.
//
// The result is always finite; a non-finite command clamps to 0.
func Clamp(commandKw float64, l Limits, r Reading) float64 {
	kw, _ := ClampTraced(commandKw, l, r)
	return kw
}

// ClampTraced is Clamp with per-stage attribution: the SAME chain, the SAME
// result (Clamp delegates here, so the two can never drift), plus the list of
// stages that changed the value - the machine-readable "why" the v2
// arbitration events report (reasons[].stage).
func ClampTraced(commandKw float64, l Limits, r Reading) (float64, []ClampStage) {
	kw := commandKw
	if math.IsNaN(kw) || math.IsInf(kw, 0) {
		return 0, []ClampStage{{Stage: StageRatedBand, Before: commandKw, After: 0}}
	}

	var stages []ClampStage
	note := func(stage string, before, after float64) float64 {
		if after != before {
			stages = append(stages, ClampStage{Stage: stage, Before: before, After: after})
		}
		return after
	}
	band := func(v float64) float64 {
		return math.Max(-l.MaxDischargeKw, math.Min(l.MaxChargeKw, v))
	}
	// The BMS envelope is a band of its own (P5c). It is applied TWICE, for
	// exactly the reason the rated band is: once before the §14a correction, so
	// that correction reasons about a value the pack can actually reach, and
	// once after it, so the correction can never push the setpoint back above
	// what the battery allows. Physics wins over the envelope here - what the
	// pack will not absorb it does not absorb, and holding the §14a envelope in
	// that moment is the curtailment's job, not the battery's.
	bmsBand := func(v float64) float64 {
		return math.Max(-l.Bms.capDischargeKw(), math.Min(l.Bms.capChargeKw(), v))
	}

	// 1) rated power band.
	kw = note(StageRatedBand, kw, band(kw))

	// 2) SoC bounds.
	if known(r.SocPct) {
		if r.SocPct >= l.SocMaxPct && kw > 0 {
			kw = note(StageSocWindow, kw, 0)
		}
		if r.SocPct <= l.SocMinPct && kw < 0 {
			kw = note(StageSocWindow, kw, 0)
		}
	}

	// 3) the BMS envelope - what the battery's own protection allows.
	if l.Bms.speaks() {
		kw = note(StageBmsLimit, kw, bmsBand(kw))
	}

	// 4) EEG solar-only charge: never charge beyond the MEASURED PV
	// production (FK3). Charging without a usable pv reading clamps to 0 -
	// grid-charging blind is exactly the violation this guard exists to
	// exclude.
	if l.SolarOnlyCharge && kw > 0 {
		produced := 0.0
		if known(r.PvKw) {
			produced = math.Max(r.PvKw, 0)
		}
		kw = note(StageSolarOnlyCharge, kw, math.Min(kw, produced))
	}
	// 4b) the Netzladen-Sperre (EN-1 A): never charge beyond the MEASURED
	// surplus pv - load minus the reserve, so the battery takes nothing while
	// the site draws from the grid. Blind (pv or load unknown) clamps to 0.
	if l.StrictExclusivity && kw > 0 {
		kw = note(StageStrictExclusivity, kw, math.Min(kw, netzladenCapKw(r)))
	}

	// 5) observed §14a envelope, both directions. predictedGrid > 0 = import.
	if known(r.GridLimitKw) && known(r.LoadKw) && known(r.PvKw) {
		limit := math.Abs(r.GridLimitKw)
		predicted := r.LoadKw + kw - r.PvKw
		if predicted > limit {
			kw = note(StageGridLimit14a, kw, limit-r.LoadKw+r.PvKw)
		} else if predicted < -limit {
			kw = note(StageGridLimit14a, kw, -limit-r.LoadKw+r.PvKw)
		}
	}

	// 6) rated band and BMS envelope again - the §14a correction must never
	// escape either of them.
	kw = note(StageRatedBand, kw, band(kw))
	if l.Bms.speaks() {
		kw = note(StageBmsLimit, kw, bmsBand(kw))
	}
	if l.StrictExclusivity && kw > 0 {
		kw = note(StageStrictExclusivity, kw, math.Min(kw, netzladenCapKw(r)))
	}

	// Round to W resolution like the Node-RED guard (stable register writes).
	return math.Round(kw*1000) / 1000, stages
}

// SelfConsumption is the Default-Watchdog fallback: the battery follows
// PV - load (charge the surplus, discharge to cover the deficit). No price
// or time-window logic, by design. Returns 0 if either input is unknown.
func SelfConsumption(r Reading) float64 {
	if !known(r.PvKw) || !known(r.LoadKw) {
		return 0
	}
	return math.Round((r.PvKw-r.LoadKw)*1000) / 1000
}
