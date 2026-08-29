// Abregelung, die der MESSUNG folgt statt 15 Minuten auf dem Planwert zu stehen:
// the live half of the plan's own curtailment, and the third member of the
// "the cloud prices, the edge enforces against measured values" family (the
// trim, the load follower and the surplus storage are the other three).
//
// WHY IT EXISTS (Anlage Pilsting/Herzogau, live 2026-08-29, scout report
// vp-herzogau-einspeisung-statt-laden-h3 §2 Glied 1b / §8 Fix D). The 10:30 run
// planned pv_limit_kw = 36,869 kW = 6,5 kW house + 30 kW battery, i.e. exactly
// "export nothing". That was right at 10:30 - and WRONG for the following ten
// minutes, because the house climbed to 27-29 kW while the cap stood still:
//
//	10:30  house  6,5  battery +30  cap 36,9  -> export 0, correct
//	10:35  house 27    battery +30  cap 36,9  -> the plant is pinned ~20 kW
//	10:44  house 29    battery +30  cap 37,4     BELOW what it could produce
//
// A cap that was a fit at the top of the quarter hour becomes a shackle inside
// it. And it closes a loop the cloud cannot see out of: the plant's measured
// output IS the capped value, the next run's PV nowcast measures exactly that,
// under-estimates the surplus, plans a smaller charge - and the cap collapses
// (§2 Glied 1b: "die Abregelung frisst ihre eigene Messung").
//
// THE CONTROL LAW is FEED-FORWARD from what the plant can absorb right now:
//
//	cap = max(0, load_measured + max(battery_command, 0))
//
// i.e. "produce exactly what the house and the battery take, and nothing else" -
// a grid exchange of zero, which is what the plan's own curtailment slot asked
// for. Wallboxes and every other consumer are inside load_measured, so they are
// netted automatically; the battery term is the COMMANDED setpoint after the
// full guard chain, not its present power, because that present power is itself
// a consequence of the cap (with the cap at 36,9 the battery could only find
// ~8 kW of surplus to charge with, which is what froze the loop).
//
// ⚠ A CLOSED LOOP ON THE GRID MEASUREMENT CANNOT DO THIS, and that is worth
// writing down because the compliance sibling (guards/exportlimit.go) uses one.
// Its law is cap = pv + (limit - export). At limit 0 every point with export = 0
// is a fixed point, so it can tighten but never release - it would have held
// 36,9 kW for the whole ten minutes. The compliance guard does not have that
// problem because its limit is 30 kW, far above the operating point.
//
// AUTHORIZATION is the plan's own curtailment: the active slot carries
// pv_limit_kw. The PRICE decision is therefore the cloud's, already made; this
// guard only executes it against the measurement instead of against a
// quarter-hour-old forecast. Without that flag it is INACTIVE and the plant
// behaves byte-for-byte as before.
//
// Safety posture, structural rather than argued:
//
//   - IT TARGETS ZERO GRID EXCHANGE, which is at least as tight as every
//     compliance limit in the system. A feed-in cap (site.max_feed_in_kw) and a
//     §14a export envelope both bound the EXPORT; a cap that lands on export 0
//     can never violate either, whether or not the box knows their values. So
//     "the live cap may exceed the plan's static value" is safe by construction
//   - the plan's value can only ever have been a TIGHTER-or-equal export
//     target, never a looser one.
//   - IT NEVER COMMANDS PRODUCTION. A cap only ever caps: with PV below it,
//     nothing happens at all.
//   - IT NEVER TOUCHES THE BATTERY, the §14a envelope, a SoC bound or the rated
//     band. Absorbing a surplus is an optimizer decision (guards/surpluscharge.go).
//   - THE COMPLIANCE WATCHDOG STAYS SUPERORDINATE: the caller composes this cap
//     with guards.ExportLimiter most-restrictive-wins, so the 30-kW feed-in
//     guard can only ever tighten it further.
//   - Tightening is IMMEDIATE; releasing is rate-limited, so the loop cannot
//     chase the inverter's own WMaxLimPct ramp.
//
// ⚠ THE FAIL-SAFE RULE IS THE PLAN, NOT A RELEASE - the compliance sibling's
// inverted rule, applied to an economic cap:
//
//	fresh load + command      -> the law above
//	gap <= CurtailHoldWindow  -> HOLD the last commanded cap
//	longer / never measured   -> the PLAN's own pv_limit_kw, i.e. exactly the
//	                             behaviour that shipped before this guard
//
// ⚠ HONEST LIMIT, unchanged by this guard: the primary hybrid's own PV is not
// curtailable (the Deye remote path reports pvLimitSupported:false - its feed-in
// register is an installer EEPROM setting we never touch). The cap is a
// PLANT-level total and the executor's split subtracts that uncontrollable
// share, so "export 0" is only reachable while house + battery >= the Deye's own
// production. Above that the writable budget floors at 0 and the rest is
// exported - visibly, not silently.
package guards

import (
	"fmt"
	"math"
	"sync"
	"time"
)

// CurtailState is the tracker's machine-readable verdict; Reason carries its ONE
// German sentence, so no surface has to parse prose and the sentence is written
// once.
type CurtailState string

const (
	// CurtailOff: the active slot carries no pv_limit_kw - the plan is not
	// curtailing, so there is nothing to track.
	CurtailOff CurtailState = "aus"
	// CurtailTracking: the cap follows the measured house plus the commanded
	// battery charge.
	CurtailTracking CurtailState = "folgt"
	// CurtailHolding: the measurement went away recently - the last commanded
	// cap is frozen.
	CurtailHolding CurtailState = "haelt"
	// CurtailPlan: blind for too long, or never measured - the plan's own static
	// cap, which is what the plant ran on before this guard existed.
	CurtailPlan CurtailState = "planwert"
)

const (
	// CurtailFreshWindow is how old the newest house/PV measurement may be and
	// still drive the law. Several source poll cycles (5 s) and setpoint ticks
	// (10 s) - the same sizing as the compliance watchdog, because it is the same
	// measurement path.
	CurtailFreshWindow = 30 * time.Second
	// CurtailHoldWindow is how long a gap is absorbed by FREEZING the last cap,
	// measured from the last measurement. After it the plan value takes over: a
	// held economic cap is only defensible while the picture it was formed from
	// is still roughly true.
	CurtailHoldWindow = 90 * time.Second
	// CurtailReleaseRateKwPerSec limits how fast the cap may RISE. A release
	// invites the plant to produce more, and both our measurement and the
	// inverter's own ramp are behind us; tightening is never delayed.
	CurtailReleaseRateKwPerSec = 2.0
	// CurtailStepKw is the smallest cap change worth writing - stable registers
	// without ever deferring a tightening.
	CurtailStepKw = 0.1
)

// CurtailCap is one evaluation of the tracker.
type CurtailCap struct {
	// Active is true whenever the plan curtails this slot, i.e. whenever CapKw
	// is a real command. False = CurtailOff and the caller keeps whatever the
	// plan said.
	Active bool
	// CapKw is the PLANT-level total PV cap to command (kW, >= 0).
	CapKw float64
	// PlanCapKw echoes the plan's own static cap, so a surface can show both.
	PlanCapKw float64
	State     CurtailState
	Reason    string
	// LoadKw / ChargeKw are the two terms the law was formed from; nil while the
	// tracker is running blind - never a fabricated zero.
	LoadKw   *float64
	ChargeKw *float64
	// MeasurementAge is how old the newest usable measurement is; 0 with none.
	MeasurementAge time.Duration
	// Blind is true whenever the verdict was NOT formed from a fresh
	// measurement (hold / plan value).
	Blind bool
}

// CurtailTracker holds the tracker's measurement and hysteresis state across
// setpoint ticks. Concurrency-safe like its siblings: the setpoint path is the
// only caller today but is reachable from the tick loop, the schedule handler
// and the web API.
type CurtailTracker struct {
	mu sync.Mutex

	seen     bool
	at       time.Time
	loadKw   float64
	chargeKw float64

	capValid bool
	cap      float64
	capAt    time.Time
}

// NewCurtailTracker returns an idle tracker (no measurement, no cap).
func NewCurtailTracker() *CurtailTracker { return &CurtailTracker{} }

// Observe feeds one evaluation point: the measured house load and the FINAL
// commanded battery setpoint (+ = charge) of this tick. A non-finite load is not
// a measurement - the tracker then runs its staged hold/plan fallback rather
// than guessing.
func (t *CurtailTracker) Observe(ts time.Time, loadKw, commandKw float64) {
	if !finite(loadKw) || loadKw < 0 || !finite(commandKw) {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.seen && ts.Before(t.at) {
		return // never step backwards in time
	}
	t.seen, t.at = true, ts
	t.loadKw, t.chargeKw = loadKw, math.Max(commandKw, 0)
}

// Cap evaluates the tracker for now. planCapKw is the active slot's own
// pv_limit_kw (nil = the plan does not curtail -> CurtailOff, and the caller
// changes nothing).
//
// The returned cap REPLACES the plan's static value; the caller then composes it
// with the compliance watchdog most-restrictive-wins, which can only tighten it.
func (t *CurtailTracker) Cap(now time.Time, planCapKw *float64) CurtailCap {
	if planCapKw == nil || !finite(*planCapKw) || *planCapKw < 0 {
		t.forget()
		return CurtailCap{State: CurtailOff}
	}
	plan := *planCapKw

	t.mu.Lock()
	defer t.mu.Unlock()

	res := CurtailCap{Active: true, PlanCapKw: plan}

	age := time.Duration(0)
	fresh := false
	if t.seen {
		age = now.Sub(t.at)
		if age < 0 {
			age = 0
		}
		fresh = age <= CurtailFreshWindow
	}
	res.MeasurementAge = age

	switch {
	case fresh:
		t.freshCap(now, &res)
	// ⚠ t.seen is load-bearing here: without it a tracker that has NEVER
	// measured reports age 0, matches this branch and freezes on the first plan
	// value it ever saw - so a later, different plan cap could never take
	// effect on a plant whose house load is not measured at all.
	case t.seen && t.capValid && age <= CurtailHoldWindow:
		res.CapKw, res.Blind, res.State = t.cap, true, CurtailHolding
		res.Reason = fmt.Sprintf(
			"Seit %s keine frische Messung - die Abregelung bleibt bei %s kW stehen "+
				"(eingefroren, nie freigegeben).", age1(age), kw1(t.cap))
	default:
		t.cap, t.capValid, t.capAt = plan, true, now
		res.CapKw, res.Blind, res.State = plan, true, CurtailPlan
		if !t.seen {
			res.Reason = fmt.Sprintf(
				"Noch keine Messung - die Abregelung folgt dem Planwert von %s kW.", kw1(plan))
		} else {
			res.Reason = fmt.Sprintf(
				"Seit %s keine Messung - die Abregelung faellt auf den Planwert von %s kW "+
					"zurueck.", age1(age), kw1(plan))
		}
	}
	return res
}

// freshCap runs the law on the newest evaluation point. Caller holds t.mu.
func (t *CurtailTracker) freshCap(now time.Time, res *CurtailCap) {
	load, charge := t.loadKw, t.chargeKw
	res.LoadKw, res.ChargeKw = &load, &charge

	target := math.Max(load+charge, 0)
	switch {
	case !t.capValid:
		// First evaluation: adopt the target outright - it comes from a real
		// measurement, so it is neither optimistic nor punitive.
		t.cap, t.capValid, t.capAt = target, true, now
	case target <= t.cap-CurtailStepKw:
		// TIGHTEN: immediate and unconditional. Never wait to stop an export.
		t.cap, t.capAt = target, now
	case target <= t.cap:
		// A tightening below the write resolution: keep the register stable.
	default:
		// RELEASE, rate-limited so the loop cannot chase the inverter's ramp.
		step := CurtailReleaseRateKwPerSec * now.Sub(t.capAt).Seconds()
		if step <= 0 {
			break
		}
		next := math.Min(t.cap+step, target)
		if next-t.cap < CurtailStepKw {
			break // let the elapsed time accumulate into a writable step
		}
		t.cap, t.capAt = next, now
	}

	res.CapKw, res.State = round3(t.cap), CurtailTracking
	res.Reason = fmt.Sprintf(
		"Die Abregelung folgt der Messung: Haus %s kW + Speicher %s kW = %s kW, "+
			"damit nichts ins Netz geht (Planwert war %s kW).",
		kw1(load), kw1(charge), kw1(res.CapKw), kw1(res.PlanCapKw))
}

// CommandedCap reports the cap currently held (kW) - for tests and diagnostics.
func (t *CurtailTracker) CommandedCap() (float64, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cap, t.capValid
}

func (t *CurtailTracker) forget() {
	t.mu.Lock()
	t.capValid, t.cap = false, 0
	t.mu.Unlock()
}
