package lastmgmt

import (
	"strings"
	"testing"
	"time"
)

// The mockups' running site: 277 kW connection, 10 % margin -> 249,3 kW
// planable, 167 kW statically reserved for the building -> 82,3 kW static
// budget, worst known building load 180 kW.
func dynSite() Settings {
	return Settings{
		GridLimitKw: 277, HouseReserveKw: 167, MarginPct: 10,
		MinPowerKw: 30, RotationPeriod: 15 * time.Minute, MaxHouseLoadKw: 180,
	}.WithDefaults()
}

var t0 = time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)

// TestWithoutAMeasurementTheBudgetIsByteForByteStufe1 is the compatibility
// promise of the whole file: a site that never measures its connection point
// must get EXACTLY the number the operator's own arithmetic produces.
func TestWithoutAMeasurementTheBudgetIsByteForByteStufe1(t *testing.T) {
	set := dynSite()
	v := NewBudgetTracker().Budget(t0, set)
	if v.Mode != BudgetStatic {
		t.Fatalf("mode = %q, want %q", v.Mode, BudgetStatic)
	}
	if v.Kw != set.BudgetKw() {
		t.Fatalf("budget %v, want the Stufe-1 figure %v", v.Kw, set.BudgetKw())
	}
	near(t, "budget", v.Kw, 82.3)
	if v.SiteLoadKw != nil || v.GridKw != nil {
		t.Fatal("a site that measured nothing must not report a measurement")
	}
	if v.Blind {
		t.Fatal("a never-measured site is not blind - it is static")
	}
	if !strings.Contains(v.Reason, "hinterlegte") {
		t.Fatalf("the reason must name the maintained figure: %q", v.Reason)
	}
}

// TestTheOperatorCanForceTheStaticBudget: the switch is an operator decision
// and it wins over any measurement.
func TestTheOperatorCanForceTheStaticBudget(t *testing.T) {
	set := dynSite()
	set.StaticBudget = true
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true) // the building is only drawing 20 kW right now
	v := tr.Budget(t0, set)
	if v.Mode != BudgetStatic || v.Kw != set.BudgetKw() {
		t.Fatalf("forced static ignored: %+v", v)
	}
	if !strings.Contains(v.Reason, "feste Ladebudget") {
		t.Fatalf("the reason must say the operator chose it: %q", v.Reason)
	}
}

// TestTheBudgetFollowsTheMeasuredRestOfTheSite is the headline: the maintained
// 167 kW reserve is replaced by what the connection point actually shows.
func TestTheBudgetFollowsTheMeasuredRestOfTheSite(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	// 60 kW at the connection point, 40 kW of which the charge points draw:
	// the REST of the site is 20 kW, so 249,3 - 20 = 229,3 kW may charge.
	tr.Observe(t0, 60, 40, true)
	v := tr.Budget(t0, set)
	if v.Mode != BudgetMeasured {
		t.Fatalf("mode = %q, want %q (%s)", v.Mode, BudgetMeasured, v.Reason)
	}
	near(t, "budget", v.Kw, 229.3)
	if v.SiteLoadKw == nil || *v.SiteLoadKw != 20 {
		t.Fatalf("site load = %v, want 20", v.SiteLoadKw)
	}
	for _, want := range []string{"249,3", "20,0", "229,3"} {
		if !strings.Contains(v.Reason, want) {
			t.Fatalf("the reason must show the arithmetic (%s missing): %q", want, v.Reason)
		}
	}
}

// TestTheChargingPowerIsAddedBackOrTheLoopOscillates is the stability argument
// written as a test: without subtracting the measured charging power, granting
// the budget would shrink the budget.
func TestTheChargingPowerIsAddedBackOrTheLoopOscillates(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	house := 20.0
	// The cars ramp from nothing to 200 kW while the building stays put.
	for i, charging := range []float64{0, 50, 120, 200} {
		at := t0.Add(time.Duration(i) * 5 * time.Second)
		tr.Observe(at, house+charging, charging, true)
		v := tr.Budget(at, set)
		near(t, "budget while the cars ramp", v.Kw, 229.3)
	}
}

// TestAConnectorWithoutAMeasurementMakesTheSampleUnusable: the completeness
// rule. A head we authorised but cannot measure is exactly the oscillation
// case, so the sample is discarded and the staged fallback takes over.
func TestAConnectorWithoutAMeasurementMakesTheSampleUnusable(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 60, 40, false)
	v := tr.Budget(t0, set)
	if v.Mode != BudgetStatic {
		t.Fatalf("an incomplete sample must not drive the loop: %+v", v)
	}
	if !strings.Contains(v.Reason, "Ladepunkt") {
		t.Fatalf("the reason must name the real cause: %q", v.Reason)
	}
	// And once it is complete again the loop runs.
	tr.Observe(t0.Add(10*time.Second), 60, 40, true)
	if v := tr.Budget(t0.Add(10*time.Second), set); v.Mode != BudgetMeasured {
		t.Fatalf("a complete sample must resume the loop: %+v", v)
	}
}

// TestALoadStepShrinksAtOnceButALoadDropWidensOnlyAfterTheWindow pins the ONE
// smoothing mechanism and its asymmetry.
func TestALoadStepShrinksAtOnceButALoadDropWidensOnlyAfterTheWindow(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	near(t, "quiet building", tr.Budget(t0, set).Kw, 229.3)

	// A machine switches on: 150 kW of building load, immediately.
	at := t0.Add(10 * time.Second)
	tr.Observe(at, 150, 0, true)
	near(t, "after the step", tr.Budget(at, set).Kw, 99.3)

	// It switches off again 10 s later - the budget must NOT jump back while
	// the trailing window still remembers the peak.
	at2 := at.Add(10 * time.Second)
	tr.Observe(at2, 20, 0, true)
	near(t, "right after the drop", tr.Budget(at2, set).Kw, 99.3)

	// Once the whole window has passed, it widens.
	at3 := at.Add(BudgetSmoothWindow + time.Second)
	tr.Observe(at3, 20, 0, true)
	near(t, "after the window", tr.Budget(at3, set).Kw, 229.3)
}

// TestASampleThatDemandsALessBudgetIsUrgent: the out-of-band nudge.
func TestASampleThatDemandsALessBudgetIsUrgent(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	tr.Budget(t0, set) // the tracker learns planable + the budget in force
	if urgent := tr.Observe(t0.Add(5*time.Second), 22, 0, true); urgent {
		t.Fatal("a 2 kW wobble must not be urgent")
	}
	if urgent := tr.Observe(t0.Add(10*time.Second), 150, 0, true); !urgent {
		t.Fatal("a 130 kW building step must be urgent")
	}
	// A DROP is never urgent: widening waits for the ordinary tick.
	if urgent := tr.Observe(t0.Add(BudgetSmoothWindow+2*time.Minute), 20, 0, true); urgent {
		t.Fatal("a widening must never be urgent")
	}
}

// TestTheBudgetIsNeverPlannedAboveTheConnectionEvenWhileExporting: the cap.
func TestTheBudgetIsNeverPlannedAboveTheConnectionEvenWhileExporting(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	// The site EXPORTS 80 kW with nothing charging: rest = -80 kW.
	tr.Observe(t0, -80, 0, true)
	v := tr.Budget(t0, set)
	near(t, "budget while exporting", v.Kw, 249.3) // the planable power, not 329,3
	if !v.Capped {
		t.Fatal("the cap must be reported")
	}
	if !strings.Contains(v.Reason, "Anschluss trägt") {
		t.Fatalf("the reason must explain the cap: %q", v.Reason)
	}
}

// TestTheGridOperatorsEnvelopeWins: §14a is most-restrictive-wins, and only a
// REPORTED envelope counts.
func TestTheGridOperatorsEnvelopeWins(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	near(t, "before the dimming event", tr.Budget(t0, set).Kw, 229.3)

	tr.ObserveGridLimit(100) // the grid operator dims the connection to 100 kW
	v := tr.Budget(t0, set)
	if !v.Section14aBinds || v.Section14aKw == nil || *v.Section14aKw != 100 {
		t.Fatalf("the envelope must bind: %+v", v)
	}
	near(t, "effective limit", v.LimitKw, 100)
	near(t, "budget under §14a", v.Kw, 70) // 100 * 0,9 - 20
	if !strings.Contains(v.Reason, "14a") {
		t.Fatalf("the reason must name §14a: %q", v.Reason)
	}

	// A LOOSER envelope than the maintained limit binds nothing.
	tr.ObserveGridLimit(400)
	if v := tr.Budget(t0, set); v.Section14aBinds {
		t.Fatalf("an envelope above the connection must not bind: %+v", v)
	}
}

// TestAZeroEnvelopeIsAValueNotAnAbsence guards the documented guards.Reading
// footgun on this path: 0 kW means zero kilowatts.
func TestAZeroEnvelopeIsAValueNotAnAbsence(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	tr.ObserveGridLimit(0)
	v := tr.Budget(t0, set)
	if v.Kw != 0 {
		t.Fatalf("a 0 kW envelope must leave no budget: %+v", v)
	}
	if !v.Section14aBinds {
		t.Fatal("a 0 kW envelope binds")
	}
}

// TestTheStagedFallbackHoldsThenContractsAndNeverReleases is the inverted
// fail-safe rule of the whole file.
func TestTheStagedFallbackHoldsThenContractsAndNeverReleases(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	near(t, "measured", tr.Budget(t0, set).Kw, 229.3)

	// Still fresh.
	near(t, "within the fresh window", tr.Budget(t0.Add(20*time.Second), set).Kw, 229.3)

	// Gap: HOLD, never a release.
	hold := tr.Budget(t0.Add(60*time.Second), set)
	if hold.Mode != BudgetHolding || !hold.Blind {
		t.Fatalf("want a hold: %+v", hold)
	}
	near(t, "held", hold.Kw, 229.3)
	if !strings.Contains(hold.Reason, "gehalten") {
		t.Fatalf("the reason must say it is held: %q", hold.Reason)
	}

	// Longer gap: contract toward the safe budget (249,3 - max(167,180) = 69,3).
	mid := tr.Budget(t0.Add(BudgetHoldWindow+BudgetContractWindow/2), set)
	if mid.Mode != BudgetContracting {
		t.Fatalf("want a contraction: %+v", mid)
	}
	if mid.Kw >= 229.3 || mid.Kw <= 69.3 {
		t.Fatalf("the contraction must lie between the held and the safe budget: %v", mid.Kw)
	}

	// All the way: the safe budget, and it is never above the static one.
	end := tr.Budget(t0.Add(BudgetHoldWindow+BudgetContractWindow+time.Minute), set)
	if end.Mode != BudgetSafe {
		t.Fatalf("want the safe budget: %+v", end)
	}
	near(t, "safe budget", end.Kw, 69.3)
	if end.Kw > set.BudgetKw() {
		t.Fatalf("a blind site must never get MORE than the static budget (%v > %v)", end.Kw, set.BudgetKw())
	}
}

// TestABlindControllerNeverReleasesEvenWhenTheSafeBudgetIsHigher: the
// contraction is one-way.
func TestABlindControllerNeverReleasesEvenWhenTheSafeBudgetIsHigher(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	// The building was eating almost everything when we last saw it.
	tr.Observe(t0, 240, 0, true)
	near(t, "measured", tr.Budget(t0, set).Kw, 9.3)

	v := tr.Budget(t0.Add(BudgetHoldWindow+BudgetContractWindow/2), set)
	if v.Mode != BudgetHolding {
		t.Fatalf("a contraction must never raise the budget: %+v", v)
	}
	near(t, "still held", v.Kw, 9.3)
}

// TestABlindStageNamesTheRealCause: a dead telemetry path and a station that
// stopped metering are different problems with different levers.
func TestABlindStageNamesTheRealCause(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	tr.Budget(t0, set)

	// The telemetry itself went quiet.
	if got := tr.Budget(t0.Add(60*time.Second), set).Reason; !strings.Contains(got, "Netzanschluss") {
		t.Fatalf("want the measurement cause: %q", got)
	}
	// A charging connector stopped reporting - the grid is still measured.
	tr.Observe(t0.Add(50*time.Second), 20, 0, false)
	if got := tr.Budget(t0.Add(60*time.Second), set).Reason; !strings.Contains(got, "Ladepunkt") {
		t.Fatalf("want the metering cause: %q", got)
	}
}

// TestABuildingThatEatsTheConnectionLeavesNoBudget - and says so honestly.
func TestABuildingThatEatsTheConnectionLeavesNoBudget(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 300, 0, true)
	v := tr.Budget(t0, set)
	if v.Kw != 0 {
		t.Fatalf("budget = %v, want 0", v.Kw)
	}
	if v.Mode != BudgetMeasured {
		t.Fatalf("a measured zero is still measured: %+v", v)
	}
}

// TestGarbageMeasurementsAreIgnored - NaN/Inf never poison a budget.
func TestGarbageMeasurementsAreIgnored(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	inf := 1.0 / zero()
	tr.Observe(t0, inf, 0, true)
	tr.Observe(t0, 20, inf, true)
	if v := tr.Budget(t0, set); v.Mode != BudgetStatic {
		t.Fatalf("garbage must not become a measurement: %+v", v)
	}
	tr.ObserveGridLimit(-5)
	if v := tr.Budget(t0, set); v.Section14aKw != nil {
		t.Fatalf("a negative envelope must be ignored: %+v", v)
	}
}

// TestAnOutOfOrderSampleIsIgnored - the newest measurement is the truth.
func TestAnOutOfOrderSampleIsIgnored(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.Observe(t0, 20, 0, true)
	tr.Observe(t0.Add(-time.Minute), 200, 0, true)
	near(t, "budget", tr.Budget(t0, set).Kw, 229.3)
}

// TestTheStaticBudgetStillHonoursTheGridOperator: §14a binds in every mode -
// it is the law, not an optimisation.
func TestTheStaticBudgetStillHonoursTheGridOperator(t *testing.T) {
	set := dynSite()
	tr := NewBudgetTracker()
	tr.ObserveGridLimit(100)
	v := tr.Budget(t0, set)
	if v.Mode != BudgetStatic {
		t.Fatalf("no measurement, so static: %+v", v)
	}
	near(t, "budget", v.Kw, 0) // 100*0,9 = 90 planable, minus the 167 kW reserve
	set.HouseReserveKw = 50
	near(t, "with a smaller reserve", tr.Budget(t0, set).Kw, 40)
}

func zero() float64 { return 0 }

// TestAnExplicitBudgetOverridesTheSettings: the seam Stufe 2 hands the measured
// budget in through, and the same one the executor uses to subtract the share
// it holds back for stations it cannot reach.
func TestAnExplicitBudgetOverridesTheSettings(t *testing.T) {
	set := dynSite()
	kw := 40.0
	plan := Decide(Input{
		Settings: set,
		Sessions: []Session{{Key: "a", MaxKw: 240, Since: t0}, {Key: "b", MaxKw: 240, Since: t0}},
		BudgetKw: &kw, Now: t0,
	})
	near(t, "plan budget", plan.BudgetKw, 40)
	near(t, "allocated", plan.AllocatedKw, 40)
	// Without the override it is the settings' own arithmetic, unchanged.
	plain := Decide(Input{
		Settings: set,
		Sessions: []Session{{Key: "a", MaxKw: 240, Since: t0}, {Key: "b", MaxKw: 240, Since: t0}},
		Now:      t0,
	})
	near(t, "plan budget without the override", plain.BudgetKw, 82.3)
	// A negative override is treated as no budget, never as a negative one.
	neg := -5.0
	if got := Decide(Input{Settings: set, Sessions: []Session{{Key: "a", MaxKw: 240}}, BudgetKw: &neg, Now: t0}); got.BudgetKw != 0 {
		t.Fatalf("a negative override must floor at 0: %v", got.BudgetKw)
	}
}
