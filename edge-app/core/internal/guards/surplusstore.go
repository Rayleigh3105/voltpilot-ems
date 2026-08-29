// Surplus storage is the CHARGE-side trust floor of the Fahrplan mode, and the
// mirror image of the price-aware trim: the trim LOWERS a commanded charge to
// the measured surplus so the battery is never filled with bought grid energy;
// this rule RAISES the command to the measured surplus so a surplus the
// 15-minute forecast never saw is stored instead of exported.
//
// It authorizes TWO entries, and the difference between them is the whole
// safety argument of this file:
//
//   - THE PLAN IS ALREADY CHARGING - only the AMOUNT is corrected (B1);
//   - THE PLAN RESTS and the CLOUD marked the slot cover_load_from_battery,
//     i.e. an own-consumption slot rather than a sale (B2).
//
// The live case (Anlage Pilsting/Herzogau, 2026-08-29 10:47, scout report
// vp-herzogau-einspeisung-statt-laden-h3 §4/§8 B1): the plan commanded
// +9,82 kW while the measured surplus was 29,5 kW, so 19,7 kW left the site at
// a NEGATIVE price with the storage at 37 %. Nothing raised it - the trim only
// lowers, the load follower only acts on a discharge, and the cloud-economic
// absorption duty (charge_surplus_to_battery) is structurally silent on exactly
// the surplus days it was built for, because the stored-energy value lambda
// collapses to ~wear/2 whenever the plan's own trajectory fills the battery
// inside the horizon anyway.
//
// WHY THE CHARGE ENTRY NEEDS NO PRICE DISCRIMINATOR - the one property that
// makes it safe: the plan is ALREADY CHARGING. The storage-versus-sale decision
// of this slot has been made by the cloud, and this rule only corrects the
// AMOUNT. It can never turn a deliberate sale into a charge; there is no sale
// here to turn.
//
// WHY THE IDLE ENTRY NEEDS ONE: a resting command with a large surplus can also
// mean "deliberately feed in at the peak price". The only correct discriminator
// is the one the cloud already publishes - cover_load_from_battery is set on a
// "grid ~ 0" own-consumption slot and NEVER on a sell slot - and the caller
// folds it into IdleAuthorized together with the write gates and the held
// readback that every locally STARTED direction demands.
//
// GENERALIZED ON 2026-08-29 from the narrow upper PV buffer that shipped one
// day earlier (guards/highsoc.go, execution name "high_soc_charge"), which
// engaged ONLY between soc_max-5 and soc_max. The live case that outgrew it:
// Anlage Pilsting/Herzogau 10:14 - storage 19 %, PV 39,354 kW, house 16,383 kW,
// and 22,8 kW leaving the site while the cover-load slot's own forecast-derived
// discharge had already been followed down to 0,0 kW. 19 % is nowhere near the
// top band, so the charge side refused a surplus the box could measure directly
// - while its DISCHARGE twin (guards/deficitcover.go) had dropped exactly that
// band limit the day before. This file closes that asymmetry: the SoC window is
// gone, the marker and the idle command remain.
//
// THE HONEST RESIDUAL OBJECTION, not argued away: in an EVENING cover-load slot
// an UNEXPECTED surplus is now stored instead of sold at up to ~21 ct. The
// spread is lambda against the export value, the quantity is one slot's forecast
// error, and the next 15-minute run corrects the SoC path. Ruling that out too
// would need the per-slot export value in the schedule contract - a contract
// change plus an edge release. The CHARGE entry does not carry this objection
// at all (there is no sale in a charging slot).
//
// WHAT THIS IS NOT: a second optimizer and not an economic verdict, exactly
// like its discharge twin (guards/deficitcover.go). It never decides WHETHER
// cycling pays - it refuses to GIVE AWAY energy the plant is producing while
// the plan itself already asked to store some of it. The economics stay with
// the cloud duties (slot_trim.py); this rule is the floor under them.
//
// The guarantees, all structural rather than promised:
//
//   - it authorizes the SAME measured-surplus controller (guards.SurplusCharger)
//     the cloud duty uses, so the raised target is re-run through the
//     authoritative guards.Clamp: rated band, SoC ceiling, EEG solar-only charge
//     and the §14a envelope all still bind, and it can never write past one;
//   - charge <= measured surplus means the predicted grid power after it is
//     load + charge - pv <= 0: it can never create or raise an IMPORT and only
//     ever moves an EXPORT toward zero, so the §14a import bound, any feed-in
//     cap and the PS-3 peak target hold a fortiori;
//   - never a direction flip: a commanded discharge is outside both entries, and
//     an idle command without the cloud's own-consumption marker is outside the
//     second one;
//   - it never regulates blind - an unknown measurement is a refusal, never a
//     guessed zero.
//
// The caller owns the hold reasons only it can see: plant pause, a non-plan
// holder, an owner-claimed battery, the self-consumption fallback (which
// already follows pv - load) and a stale plan.
package guards

import "math"

const (
	// SurplusStoreChargeDeadbandKw is the boundary above which a command counts
	// as a real CHARGE - the plan's own storage decision. Same tolerance the
	// schedule duties use for planned charge/discharge intent, so an idle
	// command (which needs the cloud's own-consumption marker) is never
	// reinterpreted here.
	SurplusStoreChargeDeadbandKw = 0.05
	// SurplusStoreIdleDeadbandKw is the real-idle boundary of the second entry -
	// the same tolerance the schedule duties use, so a charge or a sale is never
	// reinterpreted as "resting".
	SurplusStoreIdleDeadbandKw = 0.05
	// SurplusStoreShortfallKw is how far the measured surplus must exceed the
	// commanded charge before the correction is worth claiming. It only ARMS
	// the rule - the threshold that actually decides whether a write happens is
	// the charger's own AbsorbEngageMarginKw, and its release dwell is what
	// keeps a surplus hovering around that boundary from toggling the setpoint.
	// Deliberately ONE hysteresis, owned by the charger: a second threshold
	// here would fight it at exactly the value where it matters.
	SurplusStoreShortfallKw = 0.2
)

// SurplusStoreInput is every fact the rule needs. A missing or non-finite fact
// is a refusal; no default is ever invented for a control decision.
type SurplusStoreInput struct {
	// Eligible folds the caller-side hold reasons: Fahrplan mode with a fresh
	// plan and an active slot, market corrections allowed (no pause, no
	// non-plan holder, no owner claim), and no cloud duty already in charge of
	// this correction - the cloud path keeps its own name where it applies.
	Eligible bool
	// IdleAuthorized is the SECOND entry, and it is the caller's to prove: the
	// active slot carries the cloud's cover_load_from_battery marker (an
	// own-consumption slot, never a sale) AND the gates every locally STARTED
	// direction demands - the kill switch, the family certification and a
	// recent independently held Layer-1 readback. False leaves a resting
	// command exactly as the plan left it.
	IdleAuthorized bool
	// MeasurementsFresh is the same recency window every measurement-driven
	// correction demands - a surplus nobody measured recently is not a surplus.
	MeasurementsFresh bool
	// CommandKw is the setpoint as it stands after the compliance clamps, the
	// holder override and the two restricting in-slot duties (+ = charge). The
	// idle entry is therefore evaluated on the value AFTER the follower has
	// reduced an obsolete planned discharge to real idle.
	CommandKw float64
	// SocPct / SocMaxPct are the measured state of charge and the configured
	// ceiling. The rule never claims a correction the ceiling forbids; Clamp
	// binds anyway, but an authorization that can never bite is a false claim.
	SocPct    float64
	SocMaxPct float64
	PvKw      float64
	LoadKw    float64
}

// SurplusStoreDecision authorizes the surplus charger's raise. Idle reports
// WHICH entry granted it, so the caller can keep the plan's own pre-follower
// value as the comparison the portal renders.
type SurplusStoreDecision struct {
	Active bool
	Idle   bool
}

// StoreSurplus answers one tick. It is stateless on purpose: the hysteresis
// that matters is the charger's own engage/release dwell on the surplus, and
// the SoC boundary needs none - at the ceiling the rule simply refuses, the
// battery stops charging and the SoC cannot rise further, so there is nothing
// to oscillate.
func StoreSurplus(in SurplusStoreInput) SurplusStoreDecision {
	if !in.Eligible || !in.MeasurementsFresh ||
		!finite(in.CommandKw) || !finite(in.SocPct) || !finite(in.SocMaxPct) ||
		!finite(in.PvKw) || !finite(in.LoadKw) ||
		in.SocMaxPct <= 0 || in.SocMaxPct > 100 {
		return SurplusStoreDecision{}
	}
	// WHICH entry, if any. A discharge is a direction and never a magnitude, so
	// it falls through both.
	idle := false
	switch {
	case in.CommandKw > SurplusStoreChargeDeadbandKw:
		// The plan itself decided to store; only the amount is corrected.
	case in.IdleAuthorized && math.Abs(in.CommandKw) <= SurplusStoreIdleDeadbandKw:
		idle = true
	default:
		return SurplusStoreDecision{}
	}
	// Nothing left to fill.
	if in.SocPct >= in.SocMaxPct {
		return SurplusStoreDecision{}
	}
	// What the plan is giving away: the part of the MEASURED surplus its own
	// command does not take. Meter noise is not a shortfall.
	if in.PvKw-in.LoadKw-in.CommandKw <= SurplusStoreShortfallKw {
		return SurplusStoreDecision{}
	}
	return SurplusStoreDecision{Active: true, Idle: idle}
}
