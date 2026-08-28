// In-slot load following: the local half of the 2026-07-30 fix for the Pilsting
// quarter-hour gap - the plant settling its own forecast error at the grid while
// its battery sat at 77 % SoC (firstmate scout report vp-netzbezug-nacht-s3,
// P1). It has TWO symmetric halves, both observed live on the same night:
//
//   - 21:22 - the plan discharged 4,33 kW (its LOAD FORECAST) into a 7,12 kW
//     house, so 2,79 kW was BOUGHT at the full import price (~32,5 ct). Over one
//     night ~4,9 EUR, and the plan (believing the night smaller than it was)
//     carried ~15 kWh unused into the morning.
//   - 23:12 - the mirror image: the plan discharged 6,7 kW (again its forecast)
//     into a house that only drew 5,1 kW, so 1,4 kW was EXPORTED at ~21 ct while
//     that same kWh was worth ~32,5 ct as avoided import a few hours later.
//
// Both are the same defect: a 15-min setpoint stands for the whole quarter hour,
// but the house load moves every second and the setpoint was computed from a
// quarter-hour load FORECAST. So in a flagged slot the duty is not "discharge at
// least the deficit" but TRACK the measured deficit: the target is
// grid power = 0, and the correction serves it in BOTH directions.
//
// THE SPLIT IS THE POINT, identical to the price-aware trim (slottrim.go): the
// CLOUD decides whether covering the house from the battery is economic in this
// slot (ONE price truth - services/optimization slot_trim.py, published as the
// additive per-slot contract flag cover_load_from_battery), the EDGE only
// enforces it against MEASURED values. Nothing here knows a price, ever. The
// naive alternative - always track the house - is the price-blind
// self-consumption logic and would destroy the deliberate cheap-hour purchases
// that make arbitrage work.
//
// Safety posture, structurally the PS-3 peak guard's - the DEEPEN half literally
// IS PeakShave with a zero import target plus anti-flap, so the two can never
// drift apart, and the REDUCE half is safe by algebra rather than by bounds:
//
//   - THE INVARIANT: the correction only ever moves the predicted grid power
//     TOWARD zero - never past it, never further away. Deepening lowers a
//     positive (import) prediction toward 0, reducing raises a negative (export)
//     one toward 0. So neither half can push the site into export or into
//     import beyond what entered the guard: the §14a export bound and any
//     feed-in cap are untouchable by construction, and the §14a import bound
//     was applied to a value that only ever gets reduced further.
//   - Deepening is bounded by the rated discharge and stops at the SoC floor
//     (PeakShave applies both), so the guard band Clamp established cannot be
//     escaped. Reducing needs no bound of its own: it shrinks the discharge
//     MAGNITUDE, so the rated band and the SoC floor hold trivially, and it
//     never crosses into a charge, so the SoC ceiling and the EEG solar-only
//     charge clamp are equally untouched.
//   - Reducing has a HARD FLOOR AT ZERO discharge. Where PV already covers the
//     house (deficit 0) the setpoint goes to 0 - the follower stops the
//     discharge, it never turns it into a charge. A direction flip is not
//     something an economic guard may do (the trim likewise stops at 0 and never
//     crosses into discharge). So where it bites the BATTERY stops contributing
//     to the grid exchange: predicted grid is exactly 0 whenever the house has a
//     deficit, and the remaining PV surplus where it has none - absorbing that
//     would take a CHARGE, i.e. a price decision this guard must never take.
//   - The peak RESERVE bounds the DEEPEN half (reserveSocPct raises the SoC
//     floor): ordinary load covering is exactly what that reserve must survive -
//     the same rule the stale-plan fallback applies. Peak DEFENSE may still go
//     below it (PeakShave runs after this and gets the untouched limits) - that
//     is what the reserve is FOR. The reduce half only ever PRESERVES stored
//     energy, so no reserve can be endangered by it.
//   - The later peak guard can never be undone by a reduce: it enforces
//     predicted <= allowedImport with allowedImport >= 0, and a reduce lands at
//     predicted = 0.
//   - It never regulates blind: unknown pv or load leaves the command untouched
//     (the economic-guard convention - a missed correction costs a little money,
//     a blind one could dump a battery).
//   - A correction is DELIBERATE, not a failed write. The followed value is what
//     gets written, so the register readback matches it and the debounced
//     confirmation logic (PR #280) can never read it as "setpoint not adopted" -
//     which is why FollowResult carries the direction: an unnamed correction
//     reads as a defect just like an unnamed limitation.
//
// WHY THE FLAG MAY BE READ AS "TARGET GRID 0": the edge cannot tell a plan's
// DELIBERATE export apart from a forecast overshoot, because the plan carries
// only the setpoint, never its own forecast grid power. It does not have to -
// the distinction is made in the cloud, where both numbers exist: the flag is
// emitted ONLY on the "eigenverbrauch" kink, a real discharge whose planned grid
// exchange is within a deadband of zero in BOTH directions
// (slot_trim.cover_load_from_battery, |grid_kw| <= 0.05 kW). So a deliberate
// sell window and a deliberate cheap-hour purchase are equally unflagged, and an
// unflagged slot is byte-for-byte untouched here - that is what protects the
// price arbitrage in both directions.
//
// Safety does NOT rest on that, though: a device paired with an older cloud can
// still see a marked slot that plans a small export. Limiting it then holds that
// energy in the battery (worth at least the water value, re-dispatched by the
// next 15-min replan) - a bounded, self-correcting deferral, unlike the unpriced
// export the correction exists to stop.
//
// Anti-flap is SYMMETRIC around the zero-grid target and asymmetric in time,
// like the trim: engaging is immediate in either direction (a load step settled
// at the grid is exactly what must not be traded), releasing needs the plan's
// OWN setpoint to track the deficit within the margin for a dwell window - so
// the correction cannot switch on and off with the ~10 s setpoint cadence.
//
// DELIBERATE DEVIATION from the trim: there is no step-limited follower on the
// applied value. Both directions here are load following - the target simply is
// pv - load - and holding a stale (deeper) discharge while the deficit SHRINKS
// is precisely the 23:12 symptom. Following it directly is also what the
// long-shipped self-consumption fallback does, so the written value is no
// churnier than the fallback's; the register write-on-change discipline lives in
// the Layer-1 executor, where it belongs.
package guards

import (
	"math"
	"sync"
	"time"
)

const (
	// FollowEngageMarginKw is how far the plan's own setpoint must miss the
	// zero-grid target - in EITHER direction - before load following engages:
	// above measurement noise, well below any meaningful purchase or giveaway.
	FollowEngageMarginKw = 0.2
	// FollowReleaseMarginKw is how closely the plan's OWN setpoint must track
	// the measured deficit (i.e. how near zero it must hold the predicted grid
	// power, either way) to count as "no longer needing the correction".
	FollowReleaseMarginKw = 0.2
	// FollowReleaseDwell is how long that must hold before the correction lets
	// go. Several setpoint ticks (default cadence 10 s), so a flickering load
	// can never toggle it.
	FollowReleaseDwell = 90 * time.Second
	// followWriteResolutionKw is the 1 W write resolution: below it there is
	// nothing to correct, and claiming the card for a rounding artefact would
	// read as a defect.
	followWriteResolutionKw = 0.001
)

// Follow directions, reported on FollowResult/state.FollowInfo so the local card
// can NAME what it did (an unnamed correction reads as a defect).
const (
	// FollowDeepen = the plan discharged LESS than the measured house deficit,
	// so the discharge was raised: the difference is no longer bought.
	FollowDeepen = "deepen"
	// FollowReduce = the plan discharged MORE than the measured deficit, so the
	// discharge was limited (down to zero at most): the difference is no longer
	// given away.
	FollowReduce = "reduce"
)

// FollowResult is one evaluation of the load following.
type FollowResult struct {
	// Kw is the setpoint to use (the input value when the correction does not
	// bite).
	Kw float64
	// Active is true only while the correction is actually changing the
	// commanded discharge (in either direction).
	Active bool
	// Direction is FollowDeepen or FollowReduce while Active, "" otherwise.
	Direction string
	// CommandedKw is the pre-correction command - what the plan/holder asked
	// for, so the local card can name the deliberate correction instead of
	// hiding it.
	CommandedKw float64
	// DeficitKw is the measured house deficit max(load - pv, 0) the discharge
	// follows; NaN when unknown (then the correction is inactive - never
	// regulate blind).
	DeficitKw float64
	// Path distinguishes adjustment of an already-planned discharge ("follow")
	// from the additive 0-kW idle fallback ("idle_follow") and the local
	// customer-trust deficit coverage ("deficit_cover").
	Path string
	// FloorSocPct is the actual floor applied while one of the two local
	// authorizations starts or widens a discharge: the FULL cloud-computed
	// reserve stack, which neither of them ever spends.
	FloorSocPct *float64
}

// LoadFollower holds the correction's hysteresis state across setpoint ticks.
// Concurrency-safe, like PriceTrimmer (the setpoint path is the only caller but
// is reachable from the tick loop, the schedule handler and the web API).
type LoadFollower struct {
	mu        sync.Mutex
	engaged   bool
	fitsSince time.Time
}

// NewLoadFollower returns a released follower.
func NewLoadFollower() *LoadFollower { return &LoadFollower{} }

// Apply makes an already guard-clamped DISCHARGE command track the measured
// house deficit: it deepens a discharge that falls short of it and limits one
// that exceeds it, with a hard floor at zero discharge (it never commands a
// charge and never flips the direction).
//
// coverLoad is the active slot's cloud-published duty (false = the slot is not
// worth covering, no active slot, stale plan, or a pre-feature cloud -> the
// command is returned untouched). reserveSocPct is the plan-carried peak reserve
// (nil = none): ordinary DEEPENING stops there, because that is precisely what
// the reserve exists to survive.
//
// Call it AFTER Clamp and any holder override, and BEFORE the peak guard: the
// deepen half only lowers the setpoint like the peak guard does, and the reduce
// half lands at exactly zero predicted grid import, which is within any
// allowance the peak guard can compute (>= 0) - so neither can undo the other's
// bound in either order.
func (f *LoadFollower) Apply(
	now time.Time,
	kw float64,
	coverLoad bool,
	l Limits,
	reserveSocPct *float64,
	r Reading,
) FollowResult {
	return f.ApplyAuthorized(now, kw, coverLoad, false, false, reserveSocPct, true, l, r)
}

// ApplyAuthorized composes the established follow duty with the two additive
// local authorizations. Both are strictly fail-closed - fresh load/PV/SoC and an
// explicit effective floor - and they differ only in reach:
//
//   - unplannedLoad is the cloud's ECONOMIC idle-slot duty
//     (unplanned_load_discharge): it starts from a real zero command only;
//   - deficitCover is the local CUSTOMER-TRUST rule (guards.CoverDeficit): it
//     may also widen a partial planned discharge, and it is DEEPEN-ONLY, so a
//     planned sale can never be cut back by it.
//
// Existing cover_load_from_battery semantics stay unchanged through the Apply
// wrapper above.
func (f *LoadFollower) ApplyAuthorized(
	now time.Time,
	kw float64,
	coverLoad bool,
	unplannedLoad bool,
	deficitCover bool,
	effectiveFloorSocPct *float64,
	measurementsFresh bool,
	l Limits,
	r Reading,
) FollowResult {
	res := FollowResult{Kw: kw, CommandedKw: kw, DeficitKw: math.NaN()}

	// Nothing to enforce: not worth covering / no duty / no plan.
	if !coverLoad && !unplannedLoad && !deficitCover {
		f.release()
		return res
	}
	// Conflicting grants are not a reason to guess which contract was meant.
	// The optimizer never emits both; a hand-crafted/corrupt payload therefore
	// leaves the original plan untouched.
	if coverLoad && unplannedLoad {
		f.release()
		return res
	}
	path := "follow"
	deepenOnly := false
	// The cloud's own duty is the more capable one (it may also LIMIT), so it
	// keeps the tick whenever it is granted; the two local authorizations only
	// ever act where no cloud duty does.
	if !coverLoad {
		// Starting - or widening - a discharge is a larger authority than
		// adjusting one the plan already asked for. Refuse on every ambiguity:
		// stale measurements, unknown SoC or a missing reserve stack.
		if !measurementsFresh || effectiveFloorSocPct == nil ||
			!known(r.SocPct) || r.SocPct <= *effectiveFloorSocPct {
			f.release()
			return res
		}
		floor := *effectiveFloorSocPct
		res.FloorSocPct = &floor
		if unplannedLoad {
			// The economic idle duty is granted for a slot the cloud read as
			// idle; a non-zero command means the payload and the plan disagree,
			// and that is not a disagreement to resolve in favour of acting.
			if math.Abs(kw) > 0.05 {
				f.release()
				return res
			}
			path = "idle_follow"
		} else {
			// The local trust rule. It may widen a partial planned discharge,
			// but it must never SHRINK one: limiting a discharge is a price
			// decision (is the surplus worth more stored than sold?) and that
			// decision stays entirely with the cloud's cover_load_from_battery.
			deepenOnly = true
			path = "deficit_cover"
		}
	}
	// Never regulate blind (the economic-guard convention, cf. PeakShave).
	if !known(r.PvKw) || !known(r.LoadKw) || math.IsNaN(kw) || math.IsInf(kw, 0) {
		f.release()
		return res
	}
	// A commanded CHARGE is left alone. Changing the magnitude of a discharge is
	// a correction; turning a charge into a discharge would be a DIRECTION FLIP,
	// and an economic guard must not do that (the trim likewise stops at 0 and
	// never crosses into discharge). The cloud's own consistency guard already
	// refuses to mark a charging slot, so this is defence in depth - and a
	// direction change is a real change, never flap noise, so the hysteresis
	// state is released rather than carried across it.
	if kw > 0 {
		f.release()
		return res
	}
	deficit := math.Max(r.LoadKw-r.PvKw, 0)
	res.DeficitKw = deficit

	f.mu.Lock()
	defer f.mu.Unlock()

	// predicted grid power of the command as it stands (+ = import). The target
	// is 0, and |off| is how far the plan's own value misses it - the ONE
	// quantity the symmetric hysteresis keys on.
	predicted := r.LoadKw + kw - r.PvKw
	off := math.Abs(predicted)

	if !f.engaged {
		if off <= FollowEngageMarginKw {
			return res // the command already tracks the house
		}
		f.engaged, f.fitsSince = true, time.Time{}
	} else if off <= FollowReleaseMarginKw {
		if f.fitsSince.IsZero() {
			f.fitsSince = now
		}
		if now.Sub(f.fitsSince) >= FollowReleaseDwell {
			f.engaged, f.fitsSince = false, time.Time{}
			return res
		}
	} else {
		f.fitsSince = time.Time{}
	}

	if predicted > 0 {
		// DEEPEN. The correction IS the peak guard's bounded import correction
		// with a zero target - rated discharge, SoC floor and never-raise all
		// come from there, so the two economic guards share ONE piece of safety
		// arithmetic. The reserve raises the effective SoC floor: ordinary load
		// covering must not eat what peak defense is holding.
		lim := l
		if effectiveFloorSocPct != nil && *effectiveFloorSocPct > lim.SocMinPct {
			lim.SocMinPct = *effectiveFloorSocPct
		}
		target := PeakShave(kw, 0, lim, r)
		if target >= kw-followWriteResolutionKw {
			// Engaged but not biting (inside the release dwell, at the SoC
			// floor/reserve, or already at the rated discharge).
			return res
		}
		res.Kw = math.Round(target*1000) / 1000
		res.Active, res.Direction, res.Path = true, FollowDeepen, path
		return res
	}

	if deepenOnly {
		// Local trust rule: nothing to deepen (the command already covers the
		// house or discharges past it). Never reduce - see the path selection
		// above.
		return res
	}

	// REDUCE: the plan discharges deeper than the house needs, so the surplus is
	// leaving the site unpriced. Raise the setpoint to exactly the measured
	// deficit - which is <= 0 by construction, i.e. the floor is a STOPPED
	// discharge, never a charge. No bound of its own is needed: shrinking a
	// discharge magnitude cannot escape the rated band or the SoC floor, cannot
	// touch the SoC ceiling or the EEG solar-only clamp, and only ever preserves
	// what a peak reserve is holding.
	target := -deficit
	if target < kw {
		// Defensive: this branch must never LOWER the setpoint (that is the
		// deepen half's job, with its bounds). Unreachable while predicted <= 0.
		return res
	}
	if target <= kw+followWriteResolutionKw {
		return res // engaged but not biting (inside the release dwell)
	}
	res.Kw = math.Round(target*1000) / 1000
	res.Active, res.Direction, res.Path = true, FollowReduce, path
	return res
}

// Engaged reports whether the hysteresis currently holds the correction engaged
// (it may be engaged without biting during the release dwell).
func (f *LoadFollower) Engaged() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.engaged
}

// Release lets the correction go (used by the setpoint path's early exits:
// without an inverter reading, and during a bounded calibration write, it cannot
// regulate at all, so it must not carry an engaged state across).
func (f *LoadFollower) Release() { f.release() }

func (f *LoadFollower) release() {
	f.mu.Lock()
	f.engaged, f.fitsSince = false, time.Time{}
	f.mu.Unlock()
}
