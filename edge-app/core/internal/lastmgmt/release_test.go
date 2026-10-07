package lastmgmt

import (
	"math"
	"strings"
	"testing"
	"time"
)

// „Sonne + Speicher" (06.10.2026): the box releases battery energy above the
// cloud's floor - with a fresh plan, a known SoC, a ready battery path and a
// measured effect only. Every unknown falls back to „Nur Sonne".

func eigenheim() Settings {
	return Settings{GridLimitKw: 35, MarginPct: 10, MinPowerKw: 1.4,
		RotationPeriod: 15 * time.Minute}.WithDefaults()
}

func fp(v float64) *float64 { return &v }

// ready is a release input in which everything is known and fine: a fresh
// plan with a floor of 30 % in the running slot, the battery at 80 %, a 5-kW
// battery that is not yet covering any house deficit.
func ready() ReleaseInput {
	return ReleaseInput{
		Now: base, PlanFresh: true, MaxDischargeKw: fp(5), FloorPct: fp(30),
		SocPct: fp(80), Measured: true, BatteryReady: true,
		RatedDischargeKw: 0, BmsDischargeKw: math.NaN(),
	}
}

func TestAKnownBatteryAboveItsFloorReleasesItsPowerMinusTheHouse(t *testing.T) {
	var g ReleaseGate
	in := ready()
	in.DeficitKw = 1.2
	v := g.Decide(in)
	if !v.Active || v.Mode != ReleaseActive || v.StorageFirst {
		t.Fatalf("release expected: %+v", v)
	}
	near(t, "release = 5 kW minus the 1,2 kW the house already takes", v.Kw, 3.8)
	if !strings.Contains(v.Reason, "30 %") || !strings.Contains(v.Reason, "80 %") {
		t.Fatalf("the sentence names floor and SoC: %q", v.Reason)
	}
	// The box's own rated band and the BMS envelope can only narrow it.
	in.RatedDischargeKw, in.BmsDischargeKw = 4, 3
	near(t, "BMS binds", g.Decide(in).Kw, 1.8)
}

func TestEveryUnknownFallsBackToNurSonne(t *testing.T) {
	cases := map[string]struct {
		mut  func(*ReleaseInput)
		mode ReleaseMode
	}{
		"stale plan":             {func(in *ReleaseInput) { in.PlanFresh = false }, ReleaseNoPlan},
		"site not computed":      {func(in *ReleaseInput) { in.MaxDischargeKw = nil }, ReleaseNoPlan},
		"forecast too old":       {func(in *ReleaseInput) { in.FloorPct, in.CloudReason = nil, "prognose_veraltet" }, ReleaseCloudStale},
		"night beyond capacity":  {func(in *ReleaseInput) { in.FloorPct, in.CloudReason = nil, "nachtbedarf_ueber_kapazitaet" }, ReleaseCloudNightTooBig},
		"the plan trades here":   {func(in *ReleaseInput) { in.FloorPct = nil }, ReleasePlanTrades},
		"SoC unknown":            {func(in *ReleaseInput) { in.SocPct = nil }, ReleaseSocUnknown},
		"no measurement":         {func(in *ReleaseInput) { in.Measured = false }, ReleaseNoMeasurement},
		"battery path not ready": {func(in *ReleaseInput) { in.BatteryReady, in.BatteryNote = false, "Die Steuerung ist pausiert" }, ReleaseBatteryPath},
		"BMS blocks":             {func(in *ReleaseInput) { in.BmsBlocked = true }, ReleaseBmsBlocks},
		"house takes it all":     {func(in *ReleaseInput) { in.DeficitKw = 5 }, ReleaseNoPower},
	}
	for name, c := range cases {
		var g ReleaseGate
		in := ready()
		c.mut(&in)
		v := g.Decide(in)
		if v.Active || v.Kw != 0 || v.Mode != c.mode || v.Reason == "" {
			t.Fatalf("%s: want inactive %q with a sentence, got %+v", name, c.mode, v)
		}
		if v.StorageFirst {
			t.Fatalf("%s: only a KNOWN floor puts the battery first: %+v", name, v)
		}
	}
}

func TestAtTheFloorTheBatteryComesFirstWithHysteresis(t *testing.T) {
	var g ReleaseGate
	in := ready()
	in.SocPct = fp(31.5) // inside the on-margin
	v := g.Decide(in)
	if v.Active || !v.StorageFirst || v.Mode != ReleaseAtFloor {
		t.Fatalf("at the floor: battery first, no release: %+v", v)
	}
	in.SocPct = fp(32.5)
	if !g.Decide(in).Active {
		t.Fatal("2 points above the floor the release starts")
	}
	in.SocPct = fp(31.0)
	if !g.Decide(in).Active {
		t.Fatal("once running it holds down to the off-margin")
	}
	in.SocPct = fp(30.4)
	if v := g.Decide(in); v.Active || !v.StorageFirst {
		t.Fatalf("at floor + 0,5 it stops: %+v", v)
	}
	in.SocPct = fp(31.5)
	if g.Decide(in).Active {
		t.Fatal("and it needs the on-margin again to restart")
	}
}

func TestAReleaseThatImportsIsWithdrawnForAQuarterHour(t *testing.T) {
	var g ReleaseGate
	in := ready()
	if !g.Decide(in).Active {
		t.Fatal("precondition")
	}
	// Import below the tolerance or without release use never counts.
	if g.ObserveEffect(base, 3, 0.4, true) || g.ObserveEffect(base, 0, 4, true) {
		t.Fatal("no latch without a real import while released power is used")
	}
	if g.ObserveEffect(base, 3, 2.5, true) {
		t.Fatal("the first import sample only starts the window")
	}
	if g.ObserveEffect(base.Add(60*time.Second), 3, 2.5, true) {
		t.Fatal("60 s is still inside the window")
	}
	if !g.ObserveEffect(base.Add(91*time.Second), 3, 2.5, true) {
		t.Fatal("90 s of import while releasing latches the release off")
	}
	in.Now = base.Add(5 * time.Minute)
	v := g.Decide(in)
	if v.Active || v.Mode != ReleaseEffectLatch || !strings.Contains(v.Reason, "Netz") {
		t.Fatalf("latched: %+v", v)
	}
	in.Now = base.Add(91*time.Second + ReleaseLatch + time.Second)
	if !g.Decide(in).Active {
		t.Fatal("after the latch the release may try again")
	}
	// A dip below the tolerance restarts the window.
	g.ObserveEffect(in.Now, 3, 2.5, true)
	g.ObserveEffect(in.Now.Add(50*time.Second), 3, 0.1, true)
	if g.ObserveEffect(in.Now.Add(100*time.Second), 3, 2.5, true) {
		t.Fatal("the window restarted at the dip")
	}
}

// --- Decide: the release is one more reading of the ONE lane --------------

func relSess(key string, maxKw float64, since time.Duration) Session {
	s := srcSess(key, maxKw, since, PolicySolarOnly)
	s.StorageRelease = true
	return s
}

func TestAReleaseSessionTakesTheWholeSurplusPlusTheBattery(t *testing.T) {
	p := Decide(Input{
		Settings: eigenheim(), Sessions: []Session{relSess("auto#1", 11, 0)},
		BudgetKw: kwp(30), Policy: PolicySolarOnly,
		// speicher_vor_auto: the battery takes 2 of the 4 kW sun.
		SourceBudgetKw: kwp(2), SourceBudgetAboveStorageKw: kwp(4),
		StorageReleaseKw: kwp(5), Now: base,
	})
	near(t, "4 kW sun + 5 kW battery", alloc(t, p, "auto#1").Kw, 9)
	near(t, "release offered", *p.StorageReleaseKw, 5)
	near(t, "release used", p.StorageReleaseUsedKw, 5)
}

func TestWithoutAVerdictAReleaseSessionIsExactlyNurSonne(t *testing.T) {
	in := Input{
		Settings: eigenheim(), BudgetKw: kwp(30), Policy: PolicySolarOnly,
		SourceBudgetKw: kwp(2), SourceBudgetAboveStorageKw: kwp(4), Now: base,
	}
	in.Sessions = []Session{relSess("auto#1", 11, 0)}
	with := Decide(in)
	in.Sessions = []Session{srcSess("auto#1", 11, 0, PolicySolarOnly)}
	without := Decide(in)
	if alloc(t, with, "auto#1") != alloc(t, without, "auto#1") || with.StorageReleaseKw != nil {
		t.Fatalf("fallback must be byte-identical: %+v vs %+v", with, without)
	}
}

func TestTwoReleaseStationsShareTheBatteryOnce(t *testing.T) {
	p := Decide(Input{
		Settings: eigenheim(),
		Sessions: []Session{relSess("a#1", 11, 0), relSess("b#1", 11, time.Minute)},
		BudgetKw: kwp(30), Policy: PolicySolarOnly,
		SourceBudgetKw: kwp(3), SourceBudgetAboveStorageKw: kwp(3),
		StorageReleaseKw: kwp(5), Now: base,
	})
	a, b := alloc(t, p, "a#1").Kw, alloc(t, p, "b#1").Kw
	near(t, "together: 3 kW sun + 5 kW battery, not 2 x 5", a+b, 8)
	near(t, "shared fairly", a, b)
	near(t, "used", p.StorageReleaseUsedKw, 5)
}

func TestANurSonneNeighbourNeverReachesIntoTheBattery(t *testing.T) {
	// One group (unranked), two stations: „Nur Sonne" and „Sonne + Speicher".
	p := Decide(Input{
		Settings: eigenheim(),
		Sessions: []Session{srcSess("sonne#1", 11, 0, PolicySolarOnly), relSess("speicher#1", 11, time.Minute)},
		BudgetKw: kwp(30), Policy: PolicySolarOnly,
		SourceBudgetKw: kwp(4), SourceBudgetAboveStorageKw: kwp(4),
		StorageReleaseKw: kwp(5), Now: base,
	})
	sonne, speicher := alloc(t, p, "sonne#1").Kw, alloc(t, p, "speicher#1").Kw
	near(t, "the sun is shared, the battery goes to the release station only", sonne, 2)
	near(t, "2 kW sun + 5 kW battery", speicher, 7)
	near(t, "sum", sonne+speicher, 9)
	if p.StorageReleaseUsedKw > 5+1e-9 {
		t.Fatalf("used %v > offered", p.StorageReleaseUsedKw)
	}
}

func TestAtTheFloorTheReleaseStationWaitsForTheBatteryEvenCarsFirst(t *testing.T) {
	// An „Autos zuerst" site: the site reading is the whole 4 kW surplus, but
	// below its floor the battery must take its 3 kW first.
	in := Input{
		Settings: eigenheim(),
		Sessions: []Session{relSess("speicher#1", 11, 0), srcSess("sonne#1", 11, time.Minute, PolicySolarOnly)},
		BudgetKw: kwp(30), Policy: PolicySolarOnly,
		SourceBudgetKw: kwp(4), SourceBudgetAboveStorageKw: kwp(4),
		StorageFirst: true, SourceBudgetBelowStorageKw: kwp(1), Now: base,
	}
	in.Settings.MinPowerKw = 0.5
	p := Decide(in)
	near(t, "the release station gets what the battery leaves", alloc(t, p, "speicher#1").Kw, 0.5)
	near(t, "the „Nur Sonne“ neighbour keeps the site's own reading", alloc(t, p, "sonne#1").Kw, 3.5)
	if p.StorageReleaseKw != nil || p.StorageReleaseUsedKw != 0 {
		t.Fatalf("no release at the floor: %+v", p)
	}
}

func TestTheReleaseNeverWidensThePhysicalBudget(t *testing.T) {
	p := Decide(Input{
		Settings: eigenheim(), Sessions: []Session{relSess("auto#1", 11, 0)},
		BudgetKw: kwp(6), Policy: PolicySolarOnly,
		SourceBudgetKw: kwp(4), SourceBudgetAboveStorageKw: kwp(4),
		StorageReleaseKw: kwp(5), Now: base,
	})
	near(t, "the connection limit binds", alloc(t, p, "auto#1").Kw, 6)
	near(t, "only 2 kW of the battery used", p.StorageReleaseUsedKw, 2)
}

func TestBelowStorageIsAFreshReadingOfTheSameMeasurement(t *testing.T) {
	tr := NewBudgetTracker()
	// house 1 kW, PV 6 kW, battery charging 3 kW: rest = -2, restNoBatt = -5
	obs(tr, t0, -2, 0, 3)
	v := tr.Surplus(t0, PolicySolarOnly, CarsBeforeStorage)
	if v.BelowStorageKw == nil {
		t.Fatal("below reading missing")
	}
	near(t, "cars first: whole surplus", v.Kw, 5)
	near(t, "below the battery: what it leaves", *v.BelowStorageKw, 2)
	deficit, grid, ok := tr.ReleaseFacts(t0)
	if !ok || deficit != 0 || grid != -2 {
		t.Fatalf("facts: deficit %v grid %v ok %v", deficit, grid, ok)
	}
	if _, _, ok := tr.ReleaseFacts(t0.Add(BudgetFreshWindow + time.Second)); ok {
		t.Fatal("stale facts are no facts")
	}
}

// The executor takes now at the start of its pass; a sample that arrives while
// the pass runs is stamped AFTER it. It is the newest measurement, not none:
// release and surplus decide from it, like Budget does (age 0).
func TestASampleNewerThanThePassIsFreshNotMissing(t *testing.T) {
	tr := NewBudgetTracker()
	obs(tr, t0.Add(1500*time.Millisecond), -2, 0, 3)
	if _, _, ok := tr.ReleaseFacts(t0); !ok {
		t.Fatal("a sample newer than the pass must not read as „keine Messung\"")
	}
	if v := tr.Surplus(t0, PolicySolarOnly, CarsBeforeStorage); v.Blind {
		t.Fatalf("„Nur Sonnenstrom\" must not pause on the newest sample: %+v", v)
	}
}

// --- the OBSERVED battery (Kapitän 07.10.2026) ------------------------------

// observedBattery is ready() for a battery VoltPilot does not command: the
// commanded path is not ready, the box only watches SoC and battery power.
func observedBattery() ReleaseInput {
	in := ready()
	in.BatteryReady, in.BatteryObserved = false, true
	return in
}

func TestAnObservedBatteryAboveItsFloorReleasesWithItsOwnSentence(t *testing.T) {
	var g ReleaseGate
	in := observedBattery()
	in.DeficitKw = 1.2
	v := g.Decide(in)
	if !v.Active || v.Mode != ReleaseObserved || v.StorageFirst {
		t.Fatalf("an observed battery releases: %+v", v)
	}
	near(t, "the same power as a commanded one: 5 kW minus the house", v.Kw, 3.8)
	for _, want := range []string{"steuert den Speicher nicht", "beobachtet", "30 %", "80 %", "Netz"} {
		if !strings.Contains(v.Reason, want) {
			t.Fatalf("the sentence must say %q: %q", want, v.Reason)
		}
	}
	in.RatedDischargeKw, in.BmsDischargeKw = 4, 3
	near(t, "the BMS envelope binds the observed battery too", g.Decide(in).Kw, 1.8)
}

func TestAnObservedBatteryNeedsEveryMeasuredFact(t *testing.T) {
	cases := map[string]struct {
		mut  func(*ReleaseInput)
		mode ReleaseMode
	}{
		"no battery the plan knows": {func(in *ReleaseInput) { in.MaxDischargeKw = nil }, ReleaseNoPlan},
		"stale plan":                {func(in *ReleaseInput) { in.PlanFresh = false }, ReleaseNoPlan},
		"the plan trades here":      {func(in *ReleaseInput) { in.FloorPct = nil }, ReleasePlanTrades},
		"SoC unknown or stale":      {func(in *ReleaseInput) { in.SocPct = nil }, ReleaseSocUnknown},
		"battery power not fresh":   {func(in *ReleaseInput) { in.Measured = false }, ReleaseNoMeasurement},
		"BMS blocks":                {func(in *ReleaseInput) { in.BmsBlocked = true }, ReleaseBmsBlocks},
		"house takes it all":        {func(in *ReleaseInput) { in.DeficitKw = 5 }, ReleaseNoPower},
	}
	for name, c := range cases {
		var g ReleaseGate
		in := observedBattery()
		c.mut(&in)
		v := g.Decide(in)
		if v.Active || v.Kw != 0 || v.Mode != c.mode || v.Reason == "" {
			t.Fatalf("%s: want inactive %q with a sentence, got %+v", name, c.mode, v)
		}
	}
}

func TestACommandedBatteryWithoutReadbackStaysBlocked(t *testing.T) {
	// The regression the captain asked to keep: a battery VoltPilot drives
	// but whose readback is missing is NOT observed - it follows the box's
	// setpoint, not the house.
	var g ReleaseGate
	in := ready()
	in.BatteryReady, in.BatteryNote = false, "VoltPilot steuert den Speicher, aber ohne bestätigte Rückmeldung"
	v := g.Decide(in)
	if v.Active || v.Mode != ReleaseBatteryPath || !strings.Contains(v.Reason, "ohne bestätigte Rückmeldung") {
		t.Fatalf("speicherpfad expected: %+v", v)
	}
	// And a commanded, ready battery keeps its own word even if a stale
	// observed flag came along.
	in = ready()
	in.BatteryObserved = true
	if v := g.Decide(in); !v.Active || v.Mode != ReleaseActive {
		t.Fatalf("a commanded battery stays „frei“: %+v", v)
	}
}

func TestAnObservedBatteryStopsAtItsFloorWithTheSameHysteresis(t *testing.T) {
	var g ReleaseGate
	in := observedBattery()
	in.SocPct = fp(32.5)
	if v := g.Decide(in); !v.Active || v.Mode != ReleaseObserved {
		t.Fatalf("2 points above the floor it starts: %+v", v)
	}
	in.SocPct = fp(31.0)
	if !g.Decide(in).Active {
		t.Fatal("once running it holds down to the off-margin")
	}
	in.SocPct = fp(30.4)
	if v := g.Decide(in); v.Active || !v.StorageFirst || v.Mode != ReleaseAtFloor {
		t.Fatalf("at floor + 0,5 the observed release stops and the battery comes first: %+v", v)
	}
}

func TestAnObservedReleaseThatImportsIsWithdrawnForAQuarterHour(t *testing.T) {
	var g ReleaseGate
	in := observedBattery()
	if v := g.Decide(in); v.Mode != ReleaseObserved {
		t.Fatalf("precondition: %+v", v)
	}
	// The inverter does not cover the car (a forced mode, a hold, a ToU
	// program): the site imports while the car draws released power.
	if g.ObserveEffect(base, 5, 4.2, true) {
		t.Fatal("the first import sample only starts the window")
	}
	if !g.ObserveEffect(base.Add(ReleaseEffectWindow+time.Second), 5, 4.2, true) {
		t.Fatal("90 s of import while releasing latches the observed release off")
	}
	in.Now = base.Add(2 * time.Minute)
	if v := g.Decide(in); v.Active || v.Mode != ReleaseEffectLatch {
		t.Fatalf("latched: %+v", v)
	}
	in.Now = base.Add(ReleaseEffectWindow + ReleaseLatch + 2*time.Second)
	if v := g.Decide(in); !v.Active || v.Mode != ReleaseObserved {
		t.Fatalf("after the latch the observed release may try again: %+v", v)
	}
}
