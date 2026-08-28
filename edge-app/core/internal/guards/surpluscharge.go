// In-slot surplus absorption: the local half of the 2026-08-02 fix for the
// Pilsting negative-price MORNING (scout report vp-pilsting-abregeln, question
// 5b) - and the piece the other two in-slot duties structurally could not do.
//
// The trim (slottrim.go) only ever LOWERS a charge; the load follower
// (loadfollow.go) only ever acts on a discharge. So nothing could put an
// UNFORECAST PV surplus into the battery - and that is where the real money of
// that morning was: the solver charges the FORECAST surplus only
// (charge <= pv_forecast - curtail), so an under-forecast morning plans a
// trickle (or 0,0 kW) and every 15-min re-plan repeats it, because there is no
// nowcast of the running slot. Measured live at 10:41: PV 23,9 kW, house
// 4,3 kW, battery at 7 % SoC - and 16,6 kW leaving the site at a NEGATIVE spot
// price, hour after hour. Roughly 2-10 EUR given away in one morning, against
// ~0,1-0,7 EUR for the curtailment that was displayed but not executed.
//
// THE SPLIT IS THE POINT, identical to its two siblings: normally the CLOUD
// decides whether storing beats selling in this slot (ONE price truth -
// services/optimization slot_trim.py, published as the additive per-slot
// contract flag charge_surplus_to_battery), the EDGE only enforces it against
// MEASURED values. The same safe mechanism is also reused by the narrow local
// high-SoC buffer: only inside a cloud-marked cover-load slot and only between
// soc_max-5 and soc_max. Nothing here knows a price or invents a slot role,
// ever. Outside that explicit top-band exception, always charging the surplus
// would still be the price-blind self-consumption logic this plan replaced.
//
// Safety posture. This is the ONLY guard in the chain that RAISES a setpoint,
// so its argument is stated in full:
//
//   - RAISE-ONLY, and only on a NON-NEGATIVE command. It never lowers anything,
//     never touches a discharge, and never flips a direction (a commanded
//     discharge is left exactly as it is) - which also makes it disjoint from
//     the load follower by construction.
//   - THE BOUND IS THE MEASURED SURPLUS max(pv - load, 0), so the predicted grid
//     power after it is load + min(kw_raised, surplus) - pv <= 0: the site is
//     never pushed into IMPORT, so the §14a import bound and the PS-3
//     quarter-hour peak target are untouched by construction, and the export it
//     reduces only ever moves TOWARD zero, so the §14a export bound and any
//     feed-in cap hold a fortiori. It can only ever make the site's grid
//     exchange smaller.
//   - BECAUSE it raises, the raised target is re-run through the FULL guard
//     chain (Clamp: rated band, SoC window, EEG solar-only charge, §14a
//     envelope) rather than through a hand-rolled bound - the same technique
//     the load follower's deepen half uses (it calls PeakShave). So it is
//     impossible for this guard to write past a guard or to widen one: it can
//     only ever propose a value the authoritative chain already accepted, and
//     it takes it only if it is HIGHER than what was commanded.
//   - It never regulates blind: unknown pv or load leaves the command untouched
//     (the economic-guard convention - a missed absorption costs a little money,
//     a blind one could charge into a limit).
//   - An absorption is a DELIBERATE correction, not a failed write. The raised
//     value is what gets written, so the register readback matches it and the
//     debounced confirmation logic (PR #280) can never read it as "setpoint not
//     adopted" - which is why the result carries the plan's own value: an
//     unnamed correction reads as a defect.
//
// Anti-flap mirrors the trim (they are the same channel, in opposite
// directions): engaging is immediate (a surplus being exported at a negative
// price is exactly what must not be given away), releasing needs the plan's OWN
// setpoint to comfortably reach the surplus for a dwell window. The applied
// level follows a SHRINKING surplus immediately (never charge into an import)
// and a growing one only in steps, which keeps the written register stable.
package guards

import (
	"math"
	"sync"
	"time"
)

const (
	// AbsorbEngageMarginKw is how far the measured surplus must exceed the
	// commanded charge before absorption engages - above measurement noise,
	// well below any meaningful giveaway.
	AbsorbEngageMarginKw = 0.2
	// AbsorbReleaseMarginKw is how far the commanded charge must already reach
	// INTO the surplus to count as "no longer needing the correction".
	AbsorbReleaseMarginKw = 0.2
	// AbsorbReleaseDwell is how long that must hold before the correction lets
	// go. Several setpoint ticks (default cadence 10 s), so a flickering surplus
	// can never toggle it.
	AbsorbReleaseDwell = 90 * time.Second
	// AbsorbStepKw is the granularity the applied level FOLLOWS a growing
	// surplus with. A shrinking surplus is followed immediately (never charge
	// beyond it); growth in sub-step wiggles keeps the previous level, so the
	// register write stays stable.
	AbsorbStepKw = 0.2
	// absorbWriteResolutionKw is the 1 W write resolution: below it there is
	// nothing to correct, and claiming the card for a rounding artefact would
	// read as a defect.
	absorbWriteResolutionKw = 0.001
)

// AbsorbResult is one evaluation of the surplus absorption.
type AbsorbResult struct {
	// Kw is the setpoint to use (the input value when the correction does not
	// bite).
	Kw float64
	// Active is true only while the correction is actually RAISING the commanded
	// charge.
	Active bool
	// Path lets the caller distinguish the cloud-economic absorption from a
	// stricter local authorization that deliberately reuses this same safe
	// measured-surplus controller. Empty means the established economic path.
	Path string
	// CommandedKw is the pre-correction command - what the plan/holder asked
	// for, so the local card can name the deliberate correction instead of
	// hiding it.
	CommandedKw float64
	// SurplusKw is the measured surplus the charge follows; NaN when unknown
	// (then the correction is inactive - never regulate blind).
	SurplusKw float64
}

// SurplusCharger holds the correction's hysteresis state across setpoint ticks.
// Concurrency-safe, like PriceTrimmer and LoadFollower (the setpoint path is the
// only caller but is reachable from the tick loop, the schedule handler and the
// web API).
type SurplusCharger struct {
	mu        sync.Mutex
	engaged   bool
	lvlValid  bool
	lvl       float64
	fitsSince time.Time
}

// NewSurplusCharger returns a released charger.
func NewSurplusCharger() *SurplusCharger { return &SurplusCharger{} }

// Apply RAISES an already guard-clamped, non-negative command to the measured
// PV surplus.
//
// absorb is the caller's explicit authorization: normally the active slot's
// cloud-published economic duty, or the separately proven upper-buffer grant.
// False returns the command untouched. l/r are the SAME limits and reading the
// authoritative chain used: because this guard RAISES, its target is re-run
// through Clamp, so rated band, SoC ceiling, EEG solar-only charge and the §14a
// envelope all still bind - it can never write past them.
//
// Call it AFTER Clamp, after any holder override and after the two restricting
// in-slot duties, and BEFORE the peak guard: it lands at predicted grid <= 0,
// which is within any import allowance the peak guard can compute (>= 0), so it
// can neither undo nor be undone by it.
func (c *SurplusCharger) Apply(
	now time.Time,
	kw float64,
	absorb bool,
	l Limits,
	r Reading,
) AbsorbResult {
	res := AbsorbResult{Kw: kw, CommandedKw: kw, SurplusKw: math.NaN()}

	// Nothing to enforce: selling beats storing / no duty / no plan.
	if !absorb {
		c.release()
		return res
	}
	// Never regulate blind (the economic-guard convention, cf. PeakShave).
	if !known(r.PvKw) || !known(r.LoadKw) || math.IsNaN(kw) || math.IsInf(kw, 0) {
		c.release()
		return res
	}
	// A commanded DISCHARGE is left alone. Raising it into a charge would be a
	// DIRECTION FLIP, and an economic guard must not do that (the trim likewise
	// stops at 0 and never crosses into discharge, the follower likewise floors
	// at 0 and never crosses into charge). This is also what keeps this guard
	// disjoint from the load follower. A direction change is a real change, never
	// flap noise, so the hysteresis state is released rather than carried across.
	if kw < 0 {
		c.release()
		return res
	}
	surplus := math.Max(r.PvKw-r.LoadKw, 0)
	res.SurplusKw = surplus

	c.mu.Lock()
	defer c.mu.Unlock()

	shortfall := surplus > kw+AbsorbEngageMarginKw
	fits := kw >= surplus-AbsorbReleaseMarginKw

	if !c.engaged {
		if !shortfall {
			return res // the command already absorbs the surplus
		}
		c.engaged, c.lvlValid, c.fitsSince = true, false, time.Time{}
	} else if fits {
		if c.fitsSince.IsZero() {
			c.fitsSince = now
		}
		if now.Sub(c.fitsSince) >= AbsorbReleaseDwell {
			c.engaged, c.lvlValid, c.fitsSince = false, false, time.Time{}
			return res
		}
	} else {
		c.fitsSince = time.Time{}
	}

	target := surplus
	// Hold the previous level while it still fits inside the surplus and the
	// surplus only grew by less than a step - stable register writes without ever
	// charging beyond the surplus (a SHRINKING surplus fails `c.lvl <= surplus`
	// and is therefore followed immediately).
	if c.lvlValid && c.lvl <= surplus && surplus-c.lvl < AbsorbStepKw {
		target = c.lvl
	}
	// THE authoritative bound: the raised value goes through the SAME guard chain
	// the command itself came from, so rated band, SoC ceiling, EEG solar-only
	// charge and the §14a envelope all still hold. This guard can only ever
	// propose a value the chain already accepted.
	target = Clamp(target, l, r)
	if target <= kw+absorbWriteResolutionKw {
		// Engaged but not biting: inside the release dwell, at the SoC ceiling,
		// at the rated charge power, or clamped back below the command.
		return res
	}
	c.lvl, c.lvlValid = target, true
	res.Kw = math.Round(target*1000) / 1000
	res.Active = true
	return res
}

// Engaged reports whether the hysteresis currently holds the correction engaged
// (it may be engaged without biting during the release dwell).
func (c *SurplusCharger) Engaged() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.engaged
}

// Release lets the correction go (used by the setpoint path's early exits:
// without an inverter reading, and during a bounded calibration write, it cannot
// regulate at all, so it must not carry an engaged state across).
func (c *SurplusCharger) Release() { c.release() }

func (c *SurplusCharger) release() {
	c.mu.Lock()
	c.engaged, c.lvlValid, c.fitsSince = false, false, time.Time{}
	c.mu.Unlock()
}
