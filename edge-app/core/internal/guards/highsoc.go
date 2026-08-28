// Upper PV buffer - the CHARGE half of the full-battery trust rule: in a slot
// the cloud explicitly marked cover_load_from_battery, a measured PV surplus is
// stored back into the top band of the battery instead of being exported. A
// visible 91 % storage must not feed 8,5 kW into the grid while the cockpit
// still calls the slot "Verbrauch decken".
//
// It is deliberately narrow, and narrower than its former discharge sibling:
//
//   - only inside the top band (HighSocReliefBandPct below the configured
//     ceiling), so ordinary charging decisions stay entirely with the plan;
//   - only from a genuinely idle command - a planned charge or sale is never
//     reinterpreted;
//   - only on a material measured surplus, and only up to it, so it can never
//     create or raise an import;
//   - a sell slot never carries cover_load_from_battery and is therefore never
//     entered here.
//
// THE DISCHARGE HALF WAS RETIRED on 2026-08-28: covering a measured house
// deficit is no longer a top-band exception but the general Fahrplan rule -
// see guards/deficitcover.go, which engages at every SoC above the full
// reserve stack instead of within one point of the ceiling. Keeping both would
// have meant two hystereses and two execution names for one behaviour.
package guards

import (
	"math"
)

const (
	// HighSocReliefBandPct is the maximum top band this rule may make available.
	// It is intentionally small: the optimizer keeps all energy below it.
	HighSocReliefBandPct = 5.0
	// HighSocSurplusDeadbandKw: a rounding-sized PV surplus is not worth a
	// write or a battery cycle.
	HighSocSurplusDeadbandKw = 0.2
	// HighSocIdleDeadbandKw is the same real-idle boundary as the additive
	// unplanned-load schedule duty. A charge or sale is never reinterpreted.
	HighSocIdleDeadbandKw = 0.05
)

// HighSocChargeInput contains the facts for the charge-side half of the upper
// buffer. Eligible is intentionally supplied by the caller: it is true only
// for a fresh, explicitly marked cover_load_from_battery slot behind the full
// plan-holder and certified-write boundary.
type HighSocChargeInput struct {
	Eligible          bool
	MeasurementsFresh bool
	CommandKw         float64
	SocPct            float64
	SocMaxPct         float64
	PvKw              float64
	LoadKw            float64
}

// HighSocChargeDecision authorizes measured-surplus absorption inside the
// configured top band. CeilingPct is non-nil exactly while Active.
type HighSocChargeDecision struct {
	Active     bool
	CeilingPct *float64
}

// HighSocCharge authorizes the symmetric charge-side half of the top buffer.
// It is stateless because charging moves SoC away from the lower boundary and
// naturally stops at the configured ceiling through the authoritative Clamp.
// Every ambiguity refuses; a non-idle command or a non-material surplus is
// never reinterpreted.
func HighSocCharge(in HighSocChargeInput) HighSocChargeDecision {
	if !in.Eligible || !in.MeasurementsFresh ||
		!finite(in.CommandKw) || math.Abs(in.CommandKw) > HighSocIdleDeadbandKw ||
		!finite(in.SocPct) || !finite(in.SocMaxPct) ||
		in.SocMaxPct <= 0 || in.SocMaxPct > 100 ||
		!finite(in.PvKw) || !finite(in.LoadKw) {
		return HighSocChargeDecision{}
	}

	floor := in.SocMaxPct - HighSocReliefBandPct
	if in.SocPct < floor || in.SocPct >= in.SocMaxPct ||
		in.PvKw-in.LoadKw <= HighSocSurplusDeadbandKw {
		return HighSocChargeDecision{}
	}

	ceiling := in.SocMaxPct
	return HighSocChargeDecision{Active: true, CeilingPct: &ceiling}
}
