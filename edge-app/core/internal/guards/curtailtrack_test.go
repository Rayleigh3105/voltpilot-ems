package guards

import (
	"math"
	"testing"
	"time"
)

// THE INCIDENT (scout report vp-herzogau-einspeisung-statt-laden-h3 §2 Glied 1b):
// the 10:30 run planned pv_limit_kw = 36,869 kW = 6,5 kW house + 30 kW battery.
// That was right at 10:30 and wrong for the next ten minutes, because the house
// climbed to 27-29 kW while the cap stood still and pinned the plant ~20 kW
// below what it could have produced.
func TestCurtailTrackerFollowsTheRisingHouseInsteadOfStandingStill(t *testing.T) {
	tr := NewCurtailTracker()
	plan := ptr(36.869)
	base := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)

	// 10:30 - the plan's own value and the law agree to within the rounding of
	// the report's table. Nothing has moved yet.
	tr.Observe(base, 6.5, 30)
	first := tr.Cap(base, plan)
	if !first.Active || first.State != CurtailTracking {
		t.Fatalf("a curtailing slot must be tracked: %+v", first)
	}
	if math.Abs(first.CapKw-36.5) > 1e-9 {
		t.Fatalf("cap = %.3f kW, want 6.5 + 30 = 36.5", first.CapKw)
	}

	// 10:35 - 10:44: the house climbs. The static plan value would still say
	// 36,869; the law grows with it (rate-limited, so a full five minutes is far
	// more than enough for the ~20 kW).
	for _, m := range []struct {
		min  int
		load float64
	}{{35, 27}, {40, 28}, {44, 29}} {
		at := base.Add(time.Duration(m.min-30) * time.Minute)
		tr.Observe(at, m.load, 30)
		got := tr.Cap(at, plan)
		want := m.load + 30
		if math.Abs(got.CapKw-want) > 1e-9 {
			t.Fatalf("10:%02d cap = %.3f kW, want %.3f (house %.0f + battery 30)",
				m.min, got.CapKw, want, m.load)
		}
		if got.CapKw <= *plan {
			t.Fatalf("10:%02d the live cap must exceed the frozen plan value %.3f, got %.3f",
				m.min, *plan, got.CapKw)
		}
	}
	// The report's expectation for 10:44 was "~57 kW" (29 house + 28 battery).
	if last, _ := tr.CommandedCap(); last < 55 || last > 60 {
		t.Fatalf("final cap = %.3f kW, the report expected ~57", last)
	}
}

// The other direction of the SAME law: when the house or the battery command
// falls inside the slot, a static cap becomes too WIDE and the plant exports.
// Tightening is immediate - it never waits for a rate limit.
func TestCurtailTrackerTightensImmediatelyWhenTheHouseFalls(t *testing.T) {
	tr := NewCurtailTracker()
	plan := ptr(57.0)
	base := time.Date(2026, 8, 29, 8, 44, 0, 0, time.UTC)

	tr.Observe(base, 29, 30)
	if got := tr.Cap(base, plan); math.Abs(got.CapKw-59) > 1e-9 {
		t.Fatalf("cap = %.3f kW, want 59", got.CapKw)
	}
	// One tick later the house drops to 6,5 kW. The cap must follow AT ONCE.
	at := base.Add(10 * time.Second)
	tr.Observe(at, 6.5, 30)
	got := tr.Cap(at, plan)
	if math.Abs(got.CapKw-36.5) > 1e-9 {
		t.Fatalf("cap = %.3f kW, want an immediate 36.5 - a tightening never waits", got.CapKw)
	}
	if got.CapKw >= *plan {
		t.Fatalf("the live cap must undercut the too-wide plan value %.3f, got %.3f",
			*plan, got.CapKw)
	}
}

// The predicted grid exchange of the law is exactly zero, at every operating
// point - that is what "the plan wants to curtail" asks for, and it is why the
// cap can safely exceed the plan's own static value: zero export is at least as
// tight as any feed-in or §14a bound in the system.
func TestCurtailTrackerLandsOnZeroGridExchange(t *testing.T) {
	tr := NewCurtailTracker()
	plan := ptr(36.869)
	base := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)

	for i, tc := range []struct{ load, charge, pv float64 }{
		{6.5, 30, 48.8},  // 10:30
		{29, 30, 55.1},   // 10:44, the plant could produce far more than the cap
		{16.383, 30, 39}, // the 10:14 constellation
	} {
		at := base.Add(time.Duration(i) * time.Minute)
		tr.Observe(at, tc.load, tc.charge)
		got := tr.Cap(at, plan)
		// With PV capped at CapKw: grid = load - pv + battery.
		pv := math.Min(tc.pv, got.CapKw)
		if grid := tc.load - pv + tc.charge; grid < -1e-9 {
			t.Fatalf("case %d exports %.3f kW; the cap must land at grid >= 0", i, -grid)
		}
		if pv < got.CapKw {
			continue // the plant cannot even reach the cap - nothing is curtailed
		}
		if grid := tc.load - pv + tc.charge; math.Abs(grid) > 1e-9 {
			t.Fatalf("case %d grid = %.3f kW, want exactly zero", i, grid)
		}
	}
}

// A discharge is not a charge: the battery term floors at zero, so a slot that
// curtails while discharging caps at the house alone instead of inventing
// headroom that does not exist.
func TestCurtailTrackerNeverCountsADischargeAsHeadroom(t *testing.T) {
	tr := NewCurtailTracker()
	now := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	tr.Observe(now, 6.5, -30)
	if got := tr.Cap(now, ptr(36.869)); math.Abs(got.CapKw-6.5) > 1e-9 {
		t.Fatalf("cap = %.3f kW, want the house alone (6.5)", got.CapKw)
	}
}

// Without the plan's own curtailment the tracker changes NOTHING - the plant
// behaves byte-for-byte as it did before this guard existed.
func TestCurtailTrackerIsInactiveWithoutAPlannedCurtailment(t *testing.T) {
	tr := NewCurtailTracker()
	now := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	tr.Observe(now, 29, 30)
	for _, p := range []*float64{nil, ptr(math.NaN()), ptr(-1)} {
		got := tr.Cap(now, p)
		if got.Active || got.State != CurtailOff || got.CapKw != 0 {
			t.Fatalf("no planned curtailment must produce no cap: %+v", got)
		}
	}
}

// THE FAIL-SAFE CHAIN, and it is the plan - never a release, never a guess.
func TestCurtailTrackerFallsBackToTheHeldCapThenToThePlan(t *testing.T) {
	tr := NewCurtailTracker()
	plan := ptr(36.869)
	base := time.Date(2026, 8, 29, 8, 44, 0, 0, time.UTC)

	tr.Observe(base, 29, 30)
	if got := tr.Cap(base, plan); got.Blind {
		t.Fatalf("a fresh measurement is not blind: %+v", got)
	}

	// Inside the hold window the last cap is FROZEN.
	held := tr.Cap(base.Add(60*time.Second), plan)
	if held.State != CurtailHolding || math.Abs(held.CapKw-59) > 1e-9 || !held.Blind {
		t.Fatalf("a short gap must freeze the last cap: %+v", held)
	}
	if held.LoadKw != nil || held.ChargeKw != nil {
		t.Fatalf("a blind verdict must not claim measurements: %+v", held)
	}

	// Beyond it the plan's own value takes over - exactly the pre-guard behaviour.
	fell := tr.Cap(base.Add(3*time.Minute), plan)
	if fell.State != CurtailPlan || math.Abs(fell.CapKw-36.869) > 1e-9 || !fell.Blind {
		t.Fatalf("a long gap must fall back to the plan value: %+v", fell)
	}
}

func TestCurtailTrackerWithoutAnyMeasurementIsThePlanValue(t *testing.T) {
	tr := NewCurtailTracker()
	got := tr.Cap(time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC), ptr(36.869))
	if got.State != CurtailPlan || math.Abs(got.CapKw-36.869) > 1e-9 || !got.Blind {
		t.Fatalf("never measured must be the plan value: %+v", got)
	}
	if got.Reason == "" {
		t.Fatal("every non-tracking verdict carries its German reason")
	}
}

// A tracker that has NEVER measured must FOLLOW the plan, tick after tick - it
// may not freeze on the first cap it ever emitted, or a later plan value could
// never take effect on a plant whose house load is not measured at all.
func TestCurtailTrackerWithoutMeasurementsFollowsEveryNewPlanValue(t *testing.T) {
	tr := NewCurtailTracker()
	base := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	if got := tr.Cap(base, ptr(5)); got.CapKw != 5 {
		t.Fatalf("first plan value = %.3f, want 5", got.CapKw)
	}
	got := tr.Cap(base.Add(10*time.Second), ptr(40))
	if got.State != CurtailPlan || got.CapKw != 40 {
		t.Fatalf("a new plan value must take effect at once: %+v", got)
	}
}

// An unusable evaluation point is NOT a measurement: it must not overwrite a
// good one, and it must not become a fabricated zero.
func TestCurtailTrackerIgnoresUnusableEvaluationPoints(t *testing.T) {
	tr := NewCurtailTracker()
	base := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	tr.Observe(base, 29, 30)

	for _, bad := range []struct{ load, cmd float64 }{
		{math.NaN(), 30},
		{29, math.NaN()},
		{math.Inf(1), 30},
		{-1, 30},
	} {
		tr.Observe(base.Add(time.Second), bad.load, bad.cmd)
	}
	if got := tr.Cap(base.Add(time.Second), ptr(36.869)); math.Abs(got.CapKw-59) > 1e-9 {
		t.Fatalf("a garbage point must leave the good one standing: %+v", got)
	}
}

// A release is rate-limited so the loop cannot chase the inverter's own ramp;
// a tightening in the same situation is not.
func TestCurtailTrackerRateLimitsOnlyTheRelease(t *testing.T) {
	tr := NewCurtailTracker()
	plan := ptr(36.869)
	base := time.Date(2026, 8, 29, 8, 30, 0, 0, time.UTC)
	tr.Observe(base, 6.5, 30)
	tr.Cap(base, plan) // cap 36.5

	// One second later the house jumps by 20 kW. The release may move at most
	// CurtailReleaseRateKwPerSec per second.
	at := base.Add(time.Second)
	tr.Observe(at, 26.5, 30)
	got := tr.Cap(at, plan)
	if got.CapKw > 36.5+CurtailReleaseRateKwPerSec+1e-9 {
		t.Fatalf("a release must be rate-limited, got %.3f kW after one second", got.CapKw)
	}
	if got.CapKw <= 36.5 {
		t.Fatalf("but it must still move: %.3f kW", got.CapKw)
	}
	// A tightening of the same size is immediate.
	at2 := at.Add(time.Second)
	tr.Observe(at2, 0, 0)
	if got := tr.Cap(at2, plan); math.Abs(got.CapKw) > 1e-9 {
		t.Fatalf("a tightening is never rate-limited, got %.3f kW", got.CapKw)
	}
}
