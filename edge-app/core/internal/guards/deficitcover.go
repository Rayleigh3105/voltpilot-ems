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
//
// THE HOLD is not this rule's any more. It began here (Captain decision E2 A,
// 2026-10-10, report vp-wr-ueberschuss-entladung-k3 §1.5/§4): at Herzogau a
// ~2 kW consumer ran 10-15 s in a slot that planned a charge, the battery
// followed the discharge command ~12 s later - when the consumer was off again
// - and 1,5 kW of stored energy left through the grid connection point beside
// the PV surplus (twelve such episodes in 79 minutes). A device that needs
// longer to follow a command than the consumer runs cannot cover that consumer
// at all; it can only miss it. So the rule waited - in a slot that plans a
// charge, and only there.
//
// The device is just as slow in every other slot. The Zusatzlauf of
// edge-2026.10.1 measured it for a slot that rests: 22,3 Wh of stored energy
// fed into the grid behind six short consumers, up to 20 s in one stretch. So
// since the Captain decision of 2026-10-13 (answer A: "auch dort, einheitlich")
// the wait belongs to the ONE place where a measured deficit becomes a
// discharge, whichever authority asked for it - the load follower
// (loadfollow.go, "THE HOLD"). This file keeps what the wait needs: the one
// hold time (DeficitCoverHold) and the one clock (DeficitHold). The decision
// below is the plain trust rule again and knows nothing about time.
package guards

import (
	"sync"
	"time"
)

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
	// DeficitCoverHold is THE hold time: how long the house deficit must have
	// been measured without a break before a measurement may RAISE a discharge -
	// in every slot kind and for every authority that covers a measured deficit
	// (LoadFollower: deficit_cover, follow, idle_follow). One constant, read by
	// one clock (DeficitHold) and applied in one place (LoadFollower).
	//
	// History: Captain decision E2 A, 2026-10-10 ("erst entladen, wenn das
	// Defizit eine Minute anhaelt") introduced it for the slot that plans a
	// charge; Captain decision A, 2026-10-13 made it the rule of every slot.
	//
	// Why a minute: it is longer than measurement and inverter need together.
	// The slowest device measured so far (Deye at Herzogau) refreshes its
	// registers every 5-25 s and follows a write after 4,6-34,5 s (~12 s
	// typical), so a discharge commanded on the first sight of a deficit
	// arrives 15-35 s later; the consumers that triggered the case ran 5-20 s.
	// The cost of waiting is bounded and small - 1 kW for 60 s is 0,017 kWh -
	// while every discharge that arrives after its consumer has gone is sold
	// at the feed-in price and bought back later.
	//
	// The span is measured between the tick that FIRST judged the deficit and
	// the time of the newest MEASUREMENT that still shows it (DeficitHold), so
	// it always rests on at least two distinct measurements, and a deficit
	// that physically ended within the hold can never release the cover - no
	// matter how late the device reports its end.
	DeficitCoverHold = 60 * time.Second
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
// there is nothing to oscillate. WHEN an authorized cover may begin is not
// decided here: the follower holds every raise of a discharge until the
// deficit has stood for DeficitCoverHold.
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

// DeficitHold is the one clock of the hold: for how long the HOUSE deficit
// (load above PV, the battery-independent quantity the follower covers) has
// been measured without a break. It is a fact about the house, not about a
// rule or a slot - it keeps running through every slot kind and through every
// hold reason of the caller (a paused plant, a lost readback), so a deficit that
// has stood for minutes is not made to wait again when a slot boundary or a
// recovered readback hands the decision back to the box.
//
// Concurrency-safe like the other in-slot state holders (the setpoint path is
// reachable from the tick loop, the schedule handler and the web API).
type DeficitHold struct {
	mu sync.Mutex
	// since is the time of the tick that first judged the unbroken deficit.
	since time.Time
	// lastAt is the time of the newest measurement that still showed it.
	lastAt time.Time
}

// NewDeficitHold returns a clock without a standing deficit.
func NewDeficitHold() *DeficitHold { return &DeficitHold{} }

// Observe judges one tick and reports whether the deficit has stood for
// DeficitCoverHold.
//
// measuredAt is the time the judged values were MEASURED - with the damped
// follower the time of its control reading's device pair, without it the
// reading's own sample time. The span that counts runs from the tick that
// first saw the deficit (never earlier than the deficit itself) to the newest
// measurement still showing it (never later than the deficit itself): both
// ends err toward waiting, so a deficit that lasted no longer than the hold
// can never be reported as sustained, however stale or irregular the device's
// measurements are. A tick that re-reads a measurement it already judged
// proves nothing new and moves nothing.
//
// Anything short of a measured deficit ends the count: a measurement without
// a deficit, an unknown value, a stale reading. A gap in the evidence is not
// a deficit that lasted.
func (h *DeficitHold) Observe(now, measuredAt time.Time, measurementsFresh bool, pvKw, loadKw float64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !measurementsFresh || measuredAt.IsZero() || !finite(pvKw) || !finite(loadKw) ||
		loadKw-pvKw <= DeficitCoverImportDeadbandKw {
		h.since, h.lastAt = time.Time{}, time.Time{}
		return false
	}
	if h.since.IsZero() {
		h.since = now
	}
	if measuredAt.After(h.lastAt) {
		h.lastAt = measuredAt
	}
	return !h.lastAt.Before(h.since.Add(DeficitCoverHold))
}

// Since returns the tick time the standing deficit was first judged, and
// whether one stands at all.
func (h *DeficitHold) Since() (time.Time, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.since, !h.since.IsZero()
}

// Release forgets the standing deficit (used by the setpoint path's early
// exits: without a reading, or while a bounded test write owns the inverter,
// nothing is judged and no evidence may be carried across).
func (h *DeficitHold) Release() {
	h.mu.Lock()
	h.since, h.lastAt = time.Time{}, time.Time{}
	h.mu.Unlock()
}
