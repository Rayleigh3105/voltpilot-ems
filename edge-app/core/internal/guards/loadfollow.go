// In-slot load following: the local half of the 2026-07-30 fix for the Pilsting
// NIGHT symptom - the plant buying grid power at ~32,5 ct while its battery sat
// at 77 % SoC (firstmate scout report vp-netzbezug-nacht-s3, P1).
//
// It is the exact MIRROR of the price-aware trim (slottrim.go). A dispatch
// setpoint stands for a whole quarter hour, but the house load moves every
// second - and the setpoint itself was computed from a quarter-hour load
// FORECAST. Executing that watt value rigidly means every under-forecast quarter
// is silently covered from the GRID: measured live, the plan discharged 4,33 kW
// (its forecast) into a 7,12 kW house, and the 2,79 kW difference was bought at
// the full import price. Over one night that was ~4,9 EUR, and the plan - having
// believed the night smaller than it was - carried ~15 kWh unused into the
// morning.
//
// THE SPLIT IS THE POINT, identical to the trim: the CLOUD decides whether
// covering the house from the battery is economic in this slot (ONE price truth
// - services/optimization slot_trim.py, published as the additive per-slot
// contract flag cover_load_from_battery), the EDGE only enforces it against
// MEASURED values. Nothing here knows a price, ever. The naive alternative -
// always cover the house - is the price-blind self-consumption logic and would
// destroy the deliberate cheap-hour purchases that make arbitrage work.
//
// Safety posture, structurally the PS-3 peak guard's (this is PeakShave with a
// zero import target plus anti-flap, and it reuses that same bounded correction
// so the two can never drift apart):
//
//   - RESTRICT-TO-ZERO-GRID, discharge side only. It lowers the setpoint toward
//     pv - load (i.e. deepens a discharge) and never raises it, never touches a
//     commanded CHARGE, never commands generation.
//   - It cannot violate a compliance bound. The corrected predicted grid power is
//     exactly 0 where it bites (load + (pv - load) - pv), so the site is NEVER
//     pushed into export: the §14a export bound and any feed-in cap are
//     untouchable by construction, and the §14a IMPORT bound was applied to a
//     value this only reduces further. The raised discharge is bounded by the
//     rated discharge and stops at the SoC floor (PeakShave applies both), so the
//     guard band Clamp established cannot be escaped.
//   - The peak RESERVE is honored (reserveSocPct): ordinary load covering is
//     exactly what that reserve must survive - the same rule the stale-plan
//     fallback applies. Peak DEFENSE may still go below it (PeakShave runs after
//     this and gets the untouched limits) - that is what the reserve is FOR.
//   - It never regulates blind: unknown pv or load leaves the command untouched
//     (the economic-guard convention - a missed correction costs a little money,
//     a blind one could dump a battery).
//   - A raise is a DELIBERATE correction, not a failed write. The followed value
//     is what gets written, so the register readback matches it and the debounced
//     confirmation logic (PR #280) can never read it as "setpoint not adopted".
//
// Anti-flap mirrors the trim ASYMMETRICALLY: engaging is immediate (a load step
// covered from the grid is exactly what must not be bought), releasing needs the
// plan's OWN setpoint to comfortably cover the house for a dwell window - so the
// correction cannot switch on and off with the ~10 s setpoint cadence.
//
// DELIBERATE DEVIATION from the trim: there is no step-limited follower on the
// applied value. The trim may hold a stale cap while the surplus GROWS because
// that direction is the safe one; here BOTH directions are load following - the
// target simply is pv - load - and holding a stale (deeper) discharge while the
// deficit SHRINKS would push the site into export, breaking the safety argument
// above. Following it directly is also what the long-shipped self-consumption
// fallback does, so the written value is no churnier than the fallback's; the
// register write-on-change discipline lives in the Layer-1 executor, where it
// belongs.
package guards

import (
	"math"
	"sync"
	"time"
)

const (
	// FollowEngageMarginKw is how much predicted grid IMPORT the plan's own
	// setpoint must leave before load following engages - above measurement
	// noise, well below any meaningful purchase.
	FollowEngageMarginKw = 0.2
	// FollowReleaseMarginKw is how far the plan's own setpoint must cover the
	// house BEYOND zero grid to count as "no longer needing the correction"
	// (the hysteresis band).
	FollowReleaseMarginKw = 0.2
	// FollowReleaseDwell is how long that must hold before the correction lets
	// go. Several setpoint ticks (default cadence 10 s), so a flickering load
	// can never toggle it.
	FollowReleaseDwell = 90 * time.Second
)

// FollowResult is one evaluation of the load following.
type FollowResult struct {
	// Kw is the setpoint to use (the input value when the correction does not
	// bite).
	Kw float64
	// Active is true only while the correction is actually DEEPENING the
	// commanded discharge.
	Active bool
	// CommandedKw is the pre-correction command - what the plan/holder asked
	// for, so the local card can name the deliberate correction instead of
	// hiding it.
	CommandedKw float64
	// DeficitKw is the measured house deficit max(load - pv, 0) the discharge
	// follows; NaN when unknown (then the correction is inactive - never
	// regulate blind).
	DeficitKw float64
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

// Apply raises an already guard-clamped DISCHARGE command up to the measured
// house deficit.
//
// coverLoad is the active slot's cloud-published duty (false = the slot is not
// worth covering, no active slot, stale plan, or a pre-feature cloud -> the
// command is returned untouched). reserveSocPct is the plan-carried peak reserve
// (nil = none): ordinary load covering stops there, because that is precisely
// what the reserve exists to survive.
//
// Call it AFTER Clamp and any holder override, and BEFORE the peak guard: this
// one only ever LOWERS the setpoint and the peak guard only ever lowers it
// further, so the composition is a minimum either way and neither can undo the
// other's bound.
func (f *LoadFollower) Apply(
	now time.Time,
	kw float64,
	coverLoad bool,
	l Limits,
	reserveSocPct *float64,
	r Reading,
) FollowResult {
	res := FollowResult{Kw: kw, CommandedKw: kw, DeficitKw: math.NaN()}

	// Nothing to enforce: not worth covering / no duty / no plan.
	if !coverLoad {
		f.release()
		return res
	}
	// Never regulate blind (the economic-guard convention, cf. PeakShave).
	if !known(r.PvKw) || !known(r.LoadKw) || math.IsNaN(kw) || math.IsInf(kw, 0) {
		f.release()
		return res
	}
	// A commanded CHARGE is left alone. Deepening a discharge is a magnitude
	// correction; turning a charge into a discharge would be a DIRECTION FLIP,
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

	// predicted grid power of the command as it stands (+ = import).
	predicted := r.LoadKw + kw - r.PvKw
	exceeds := predicted > FollowEngageMarginKw
	fits := predicted <= -FollowReleaseMarginKw

	if !f.engaged {
		if !exceeds {
			return res // the command already covers the house
		}
		f.engaged, f.fitsSince = true, time.Time{}
	} else if fits {
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

	// The correction itself IS the peak guard's bounded import correction with a
	// zero target - rated discharge, SoC floor and never-raise all come from
	// there, so the two economic guards share ONE piece of safety arithmetic.
	// The reserve raises the effective SoC floor: ordinary load covering must
	// not eat what peak defense is holding.
	lim := l
	if reserveSocPct != nil && *reserveSocPct > lim.SocMinPct {
		lim.SocMinPct = *reserveSocPct
	}
	target := PeakShave(kw, 0, lim, r)
	// Below the 1 W write resolution there is nothing to correct - claiming the
	// card for a rounding artefact would read as a defect. (Reachable only inside
	// the release dwell; engaging needs FollowEngageMarginKw.)
	if target >= kw-0.001 {
		// Engaged but not biting (inside the release dwell, at the SoC floor, or
		// already at the rated discharge).
		return res
	}
	res.Kw = math.Round(target*1000) / 1000
	res.Active = true
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
