// Price-aware in-slot trim: the local half of the 2026-07-30 fix for the
// captain's Pilsting observation ("ist das schlau, starr mit 10,8 kW zu laden,
// statt den Überschuss reinzuballern?").
//
// A dispatch setpoint stands for a whole quarter hour, but PV and house load
// move every second. When reality undercuts the forecast, a rigid charge
// setpoint is silently covered from the GRID. That is fine when importing is
// cheap (measured live: 3,3 ct spot against a 22 ct evening - the purchase was
// economically right) and a real loss when it is not.
//
// THE SPLIT IS THE POINT: the CLOUD decides whether a slot is expensive (ONE
// price truth - services/optimization slot_trim.py, published as the additive
// per-slot contract flag charge_from_surplus_only), the EDGE only enforces it
// against MEASURED values. Nothing here knows a price, ever.
//
// Safety posture, identical in kind to the PS-3 peak guard:
//
//   - RESTRICT-ONLY on CHARGE. It lowers a commanded charge toward the measured
//     surplus max(pv - load, 0) and never raises anything, never touches
//     discharge, never commands generation.
//   - It cannot violate a compliance bound. After a trim the predicted grid
//     power is load + min(kw, surplus) - pv = max(load - pv, 0) >= 0, so the
//     site is never pushed into export: the §14a export bound and any feed-in
//     cap are untouchable by construction, and the import bound was applied to a
//     value the trim only reduces further. It stays strictly inside [0, kw], so
//     the rated band and the SoC window hold trivially.
//   - FK3 stays the regulatory upper bound: the EEG solar-only clamp (charge <=
//     measured PV production, house may import in parallel) already ran inside
//     Clamp; the economic trim is TIGHTER (surplus <= production for a
//     non-negative load) and therefore never widens it. Most restrictive wins.
//   - It never regulates blind: unknown pv or load leaves the command untouched
//     (the economic-guard convention - a missed trim costs a little money, a
//     blind one could stop a legitimate charge).
//   - A trim is a DELIBERATE limitation, not a failed write. The trimmed value
//     is what gets written, so the register readback matches it and the
//     confirmation logic (PR #280) can never read it as "setpoint not adopted".
//
// Anti-flap is ASYMMETRIC on purpose: engaging is immediate (a cloud passing
// through is exactly what must not be bought), releasing needs the plan setpoint
// to comfortably fit inside the surplus for a dwell window - so the limitation
// cannot switch on and off with the ~10 s setpoint cadence. The applied cap
// follows a shrinking surplus at once and a growing one only in steps, which
// keeps the written register value stable.
package guards

import (
	"math"
	"sync"
	"time"
)

const (
	// TrimEngageMarginKw is how far a commanded charge must exceed the measured
	// surplus before the trim engages - above measurement noise, well below any
	// real grid draw for the battery.
	TrimEngageMarginKw = 0.2
	// TrimReleaseMarginKw is how far the commanded charge must fit UNDER the
	// surplus to count as "no longer needing the trim" (the hysteresis band).
	TrimReleaseMarginKw = 0.2
	// TrimReleaseDwell is how long that fit must hold before the trim lets go.
	// Several setpoint ticks (default cadence 10 s), so a flickering surplus can
	// never toggle the limitation.
	TrimReleaseDwell = 90 * time.Second
	// TrimStepKw is the granularity the applied cap FOLLOWS a growing surplus
	// with. A shrinking surplus is followed immediately (never allow grid import);
	// growth in sub-step wiggles keeps the previous cap, so the register write
	// stays stable.
	TrimStepKw = 0.2
)

// TrimResult is one evaluation of the trim.
type TrimResult struct {
	// Kw is the setpoint to use (the input value when the trim does not bite).
	Kw float64
	// Active is true only while the trim is actually LOWERING the command.
	Active bool
	// CommandedKw is the pre-trim command - what the plan/holder asked for, so
	// the local card can name the deliberate limitation instead of hiding it.
	CommandedKw float64
	// SurplusKw is the measured surplus the cap follows; NaN when unknown (then
	// the trim is inactive - never regulate blind).
	SurplusKw float64
}

// PriceTrimmer holds the trim's hysteresis state across setpoint ticks.
// Concurrency-safe (the setpoint path is the only caller, but it is reachable
// from the tick loop, the schedule handler and the web API).
type PriceTrimmer struct {
	mu        sync.Mutex
	engaged   bool
	capValid  bool
	cap       float64
	fitsSince time.Time
}

// NewPriceTrimmer returns a released trimmer.
func NewPriceTrimmer() *PriceTrimmer { return &PriceTrimmer{} }

// Apply trims an already guard-clamped command.
//
// surplusOnly is the active slot's cloud-published duty (false = cheap slot, no
// active slot, stale plan, or a pre-feature cloud -> the command is returned
// untouched). Call it AFTER Clamp and any holder override, and BEFORE the peak
// guard: both are restrict-only, so the composition is a minimum either way.
//
// It takes no Limits: the result lives strictly inside [0, kw], so the rated band
// and the SoC window Clamp already applied cannot be escaped.
func (t *PriceTrimmer) Apply(now time.Time, kw float64, surplusOnly bool, r Reading) TrimResult {
	res := TrimResult{Kw: kw, CommandedKw: kw, SurplusKw: math.NaN()}

	// Nothing to enforce: cheap slot / no duty / no plan.
	if !surplusOnly {
		t.release()
		return res
	}
	// Never regulate blind (the economic-guard convention, cf. PeakShave).
	if !known(r.PvKw) || !known(r.LoadKw) || math.IsNaN(kw) || math.IsInf(kw, 0) {
		t.release()
		return res
	}
	surplus := math.Max(r.PvKw-r.LoadKw, 0)
	res.SurplusKw = surplus
	// Discharge or idle: the trim caps CHARGE only, so there is nothing to do -
	// and a direction change is a real change, never flap noise, so the
	// hysteresis state is released rather than carried across it.
	if kw <= 0 {
		t.release()
		return res
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	exceeds := kw > surplus+TrimEngageMarginKw
	fits := kw <= surplus-TrimReleaseMarginKw

	if !t.engaged {
		if !exceeds {
			return res // the command already lives inside the surplus
		}
		t.engaged, t.capValid, t.fitsSince = true, false, time.Time{}
	} else if fits {
		if t.fitsSince.IsZero() {
			t.fitsSince = now
		}
		if now.Sub(t.fitsSince) >= TrimReleaseDwell {
			t.engaged, t.capValid, t.fitsSince = false, false, time.Time{}
			return res
		}
	} else {
		t.fitsSince = time.Time{}
	}

	target := math.Min(kw, surplus)
	// Hold the previous cap while it is still inside the surplus and the surplus
	// only grew by less than a step - stable register writes without ever
	// allowing grid import (a SHRINKING surplus fails `t.cap <= surplus` and is
	// therefore followed immediately).
	if t.capValid && t.cap <= surplus && surplus-t.cap < TrimStepKw {
		target = math.Min(kw, t.cap)
	}
	if target < 0 {
		target = 0
	}
	if target >= kw {
		// Engaged but not biting (can happen inside the release dwell).
		return res
	}
	t.cap, t.capValid = target, true
	res.Kw = math.Round(target*1000) / 1000
	res.Active = true
	return res
}

// Engaged reports whether the hysteresis currently holds the trim engaged (the
// limitation may be engaged without biting during the release dwell).
func (t *PriceTrimmer) Engaged() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.engaged
}

// Release lets the trim go (used by the setpoint path's early exits: without an
// inverter reading, and during a bounded calibration write, the trim cannot
// regulate at all, so it must not carry an engaged state across).
func (t *PriceTrimmer) Release() { t.release() }

func (t *PriceTrimmer) release() {
	t.mu.Lock()
	t.engaged, t.capValid, t.fitsSince = false, false, time.Time{}
	t.mu.Unlock()
}
