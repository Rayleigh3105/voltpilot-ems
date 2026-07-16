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
	// MEASURED PV production max(pv, 0) - PV-bus Bilanzierung (FK3, captain
	// decision 2026-07-16: the battery may charge up to the full actual PV
	// while the house imports its load in parallel; measured PV is the
	// inverter's ACTUAL output, i.e. already post-curtailment, so this is the
	// measured twin of the solver's charge <= pv - curtail). A PV forecast
	// overshoot can still never turn a planned "solar" charge into real grid
	// import on an EEG-funded plant. Set from the plan's
	// grid_charge_allowed=false (the schedule contract's optional field
	// mirroring site.netzladen_erlaubt). Zero value (false) = no extra clamp.
	// Discharge is never affected.
	SolarOnlyCharge bool
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

// Clamp applies the guard chain to a commanded battery power
// (+ = charge, - = discharge) and returns the safe setpoint:
//
//  1. clamp to the rated charge/discharge band,
//  2. SoC bounds: no charging at/above SocMax, no discharging at/below SocMin,
//  3. EEG solar-only charge (when Limits.SolarOnlyCharge): charge <=
//     max(measured pv, 0) - the FK3 PV-bus clamp; the house may import its
//     load in parallel. Unknown pv clamps charge to 0 - a compliance guard
//     must not charge blind (unlike the advisory guards, which skip on
//     missing data). The later §14a export correction can only ever raise
//     charge to pv - load - limit <= pv, so it never re-violates this clamp,
//  4. observed §14a envelope: predicted grid power (load + battery - pv,
//     + = import) must stay within [-gridLimit, +gridLimit],
//  5. re-apply the rated band LAST - the §14a correction can otherwise push
//     the value outside it.
//
// The result is always finite; a non-finite command clamps to 0.
func Clamp(commandKw float64, l Limits, r Reading) float64 {
	kw := commandKw
	if math.IsNaN(kw) || math.IsInf(kw, 0) {
		return 0
	}

	band := func(v float64) float64 {
		return math.Max(-l.MaxDischargeKw, math.Min(l.MaxChargeKw, v))
	}

	// 1) rated power band.
	kw = band(kw)

	// 2) SoC bounds.
	if known(r.SocPct) {
		if r.SocPct >= l.SocMaxPct && kw > 0 {
			kw = 0
		}
		if r.SocPct <= l.SocMinPct && kw < 0 {
			kw = 0
		}
	}

	// 3) EEG solar-only charge: never charge beyond the MEASURED PV
	// production (FK3 PV-bus semantics - the house may import in parallel).
	// Charging without a usable pv reading clamps to 0 - grid-charging blind
	// is exactly the violation this guard exists to exclude.
	if l.SolarOnlyCharge && kw > 0 {
		produced := 0.0
		if known(r.PvKw) {
			produced = math.Max(r.PvKw, 0)
		}
		kw = math.Min(kw, produced)
	}

	// 4) observed §14a envelope, both directions. predictedGrid > 0 = import.
	if known(r.GridLimitKw) && known(r.LoadKw) && known(r.PvKw) {
		limit := math.Abs(r.GridLimitKw)
		predicted := r.LoadKw + kw - r.PvKw
		if predicted > limit {
			kw = limit - r.LoadKw + r.PvKw
		} else if predicted < -limit {
			kw = -limit - r.LoadKw + r.PvKw
		}
	}

	// 5) rated band again - the envelope correction must never escape it.
	kw = band(kw)

	// Round to W resolution like the Node-RED guard (stable register writes).
	return math.Round(kw*1000) / 1000
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
