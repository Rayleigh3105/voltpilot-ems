// Deficit coverage is the GENERAL customer-trust rule of the Fahrplan mode: a
// MEASURED house deficit is covered from the battery whenever the plan is not
// charging and no hold reason stands (Captain decision 2026-08-28).
//
// It generalizes the narrow full-battery relief that shipped one day earlier
// (which only engaged within one percentage point of the SoC ceiling and only
// released a five-point band). The live case that outgrew it: Anlage
// Pilsting/Herzogau, 19:37 - storage 92 %, PV 1,3 kW, house 2,7 kW, so 1,4 kW
// bought at ~25 ct while the plan slot 19:30-19:45 commanded 0,0 kW because its
// PV forecast still saw dusk surplus. 92 % is neither "almost full" nor
// economically marked by the cloud, and both authorizations therefore refused a
// deficit the box could measure directly.
//
// WHAT THIS IS NOT: a second optimizer, and not an economic verdict. It never
// decides WHETHER cycling pays - it only refuses to BUY energy the plant is
// standing on while the plan itself asks for nothing. The economics stay with
// the cloud duties (slot_trim.py); this rule is the floor under them, in the
// same spirit as the relief it replaces: customer trust before a marginal
// shift. Every real price decision the plan expresses stays untouched, because
// a slot that trades is not a slot this rule can enter:
//
//   - a planned CHARGE is never reinterpreted (a direction flip, never a
//     correction);
//   - a planned SALE deeper than the measured deficit leaves no residual import
//     at all, so the entry deadband refuses it - the sale runs unchanged;
//   - the correction is capped at the measured deficit and can therefore only
//     ever move the predicted grid power TOWARD zero, never past it.
//
// The caller owns the remaining hold reasons, because only it can see them:
// plant pause, a non-plan holder (a "Speicher halten" hand intervention or any
// flow/override desired), an owner-claimed battery, the self-consumption
// fallback (which follows pv - load anyway), a stale plan and the two write
// gates. The peak guard needs no refusal of its own: its reserve is already
// inside EffectiveFloorPct, and it runs AFTER this correction and only ever
// lowers the setpoint further, so a deepen can never undo a peak defense.
package guards

const (
	// DeficitCoverImportDeadbandKw is the noise floor under which the plan's
	// own command leaves nothing worth calling a purchase. It only ARMS the
	// rule - the threshold that actually decides whether a write happens is
	// the follower's FollowEngageMarginKw (0.2 kW), and its release dwell is
	// what keeps a deficit hovering around that boundary from toggling the
	// setpoint. Deliberately ONE hysteresis, owned by the follower: a second
	// threshold here would fight it at exactly the value where it matters.
	DeficitCoverImportDeadbandKw = 0.05
	// DeficitCoverChargeDeadbandKw is the boundary above which a command counts
	// as a real CHARGE and is never reinterpreted. Same tolerance the schedule
	// duties use for planned charge/discharge intent.
	DeficitCoverChargeDeadbandKw = 0.05
)

// DeficitCoverInput is every fact the rule needs. A missing or non-finite fact
// is a refusal; no default is ever invented for a control decision.
type DeficitCoverInput struct {
	// Eligible folds the caller-side hold reasons: Fahrplan mode with a fresh
	// plan, market corrections allowed (no pause, no non-plan holder, no
	// owner claim), no cloud duty already in charge, and the write gates ready.
	Eligible bool
	// MeasurementsFresh is the same recency window every locally STARTED
	// direction demands - a deficit nobody measured recently is not a deficit.
	MeasurementsFresh bool
	// CommandKw is the setpoint as it stands after the compliance clamps, the
	// holder override and the price-aware trim (+ = charge).
	CommandKw float64
	// SocPct / EffectiveFloorPct are the measured state of charge and the FULL
	// cloud-computed reserve stack (technical floor, backup reserve, peak
	// reserve). The rule never spends anything below that floor.
	SocPct            float64
	EffectiveFloorPct *float64
	PvKw              float64
	LoadKw            float64
}

// DeficitCoverDecision authorizes the load follower's deepen half and hands it
// the floor it must respect. FloorPct is non-nil exactly while Active.
type DeficitCoverDecision struct {
	Active   bool
	FloorPct *float64
}

// CoverDeficit answers one tick. It is stateless on purpose: the hysteresis
// that matters is the follower's own symmetric engage/release dwell on the
// deficit, and the SoC boundary needs none - at the floor the rule simply
// refuses, the battery stops discharging and the SoC cannot fall further, so
// there is nothing to oscillate.
func CoverDeficit(in DeficitCoverInput) DeficitCoverDecision {
	if !in.Eligible || !in.MeasurementsFresh ||
		!finite(in.CommandKw) || !finite(in.SocPct) ||
		!finite(in.PvKw) || !finite(in.LoadKw) ||
		in.EffectiveFloorPct == nil || !finite(*in.EffectiveFloorPct) {
		return DeficitCoverDecision{}
	}
	// A planned charge is a different intent, not a correction.
	if in.CommandKw > DeficitCoverChargeDeadbandKw {
		return DeficitCoverDecision{}
	}
	// Nothing left of the reserve stack to spend.
	if in.SocPct <= *in.EffectiveFloorPct {
		return DeficitCoverDecision{}
	}
	// What the command as it stands would still BUY. A planned sale lands well
	// below zero here and is refused; so is a reading inside meter noise.
	if in.LoadKw+in.CommandKw-in.PvKw <= DeficitCoverImportDeadbandKw {
		return DeficitCoverDecision{}
	}
	floor := *in.EffectiveFloorPct
	return DeficitCoverDecision{Active: true, FloorPct: &floor}
}
