package lastmgmt

import (
	"testing"
	"time"
)

// The go-e of the Edge-Light pilot at 230 V / 16 A.
var goeBands = Bands{{Phases: 1, MinKw: 1.38, MaxKw: 3.68}, {Phases: 3, MinKw: 4.14, MaxKw: 11.04}}

func home() Settings {
	return Settings{GridLimitKw: 24, MarginPct: 10, RotationPeriod: 15 * time.Minute}.WithDefaults()
}

func switching(key string, since time.Duration) Session {
	s := sess(key, 11.04, since)
	s.Source = PolicySolarOnly
	s.Ranges = goeBands
	return s
}

func solar(t *testing.T, surplus float64, sessions ...Session) Plan {
	t.Helper()
	return Decide(Input{Settings: home(), Sessions: sessions, SourceBudgetKw: kwp(surplus),
		Policy: PolicyFast, Now: base})
}

// TestASmallSurplusChargesOnOnePhase is the point of the whole feature: below
// the three-phase minimum the vehicle charges on one phase instead of waiting.
func TestASmallSurplusChargesOnOnePhase(t *testing.T) {
	a := alloc(t, solar(t, 2.5, switching("goe#1", 0)), "goe#1")
	if a.Paused || a.Phases != 1 {
		t.Fatalf("%+v", a)
	}
	near(t, "one phase follows the sun", a.Kw, 2.5)

	a = alloc(t, solar(t, 1.2, switching("goe#1", 0)), "goe#1")
	if !a.Paused || a.Reason != ReasonNoSurplus || a.Phases != 0 {
		t.Fatalf("below 6 A on one phase it still waits: %+v", a)
	}
}

// TestBetweenTheBandsTheAllocationSnapsDown - 3.9 kW is neither: one phase at
// its ceiling, never a three-phase value the sun does not cover.
func TestBetweenTheBandsTheAllocationSnapsDown(t *testing.T) {
	p := solar(t, 3.9, switching("goe#1", 0))
	a := alloc(t, p, "goe#1")
	if a.Phases != 1 {
		t.Fatalf("%+v", a)
	}
	near(t, "snapped to the one-phase ceiling", a.Kw, 3.68)
	near(t, "only what is charged is covered", p.SourceAllocatedKw, 3.68)

	a = alloc(t, solar(t, 6.5, switching("goe#1", 0)), "goe#1")
	if a.Phases != 3 {
		t.Fatalf("%+v", a)
	}
	near(t, "three phases above their minimum", a.Kw, 6.5)
}

// TestWhatOneSnapFreesGoesToTheNextVehicle - the snapped-off rest is not lost.
func TestWhatOneSnapFreesGoesToTheNextVehicle(t *testing.T) {
	plain := sess("plain#1", 7.4, time.Minute)
	plain.Source = PolicySolarOnly
	plain.MinKw = 1.4
	p := solar(t, 8.4, switching("goe#1", 0), plain)
	g, o := alloc(t, p, "goe#1"), alloc(t, p, "plain#1")
	// An equal share of 4.2 each is fine for both; at 7.8 the go-e would
	// sit at 3.9 in the gap, snap to 3.68 and hand the rest over.
	near(t, "go-e", g.Kw, 4.2)
	near(t, "other", o.Kw, 4.2)
	p = solar(t, 7.8, switching("goe#1", 0), plain)
	g, o = alloc(t, p, "goe#1"), alloc(t, p, "plain#1")
	near(t, "go-e snapped", g.Kw, 3.68)
	near(t, "other gets the rest", o.Kw, 4.12)
	near(t, "nothing lost", p.AllocatedKw, 7.8)
}

// TestAChosenMinimumStaysAThreshold - a customer who chose to start at 4.2 kW
// keeps that, bands or not; the one-phase band below it is not offered.
func TestAChosenMinimumStaysAThreshold(t *testing.T) {
	s := switching("goe#1", 0)
	s.MinKw = 4.2
	a := alloc(t, solar(t, 3, s), "goe#1")
	if !a.Paused || a.Reason != ReasonNoSurplus {
		t.Fatalf("%+v", a)
	}
	a = alloc(t, solar(t, 5, s), "goe#1")
	if a.Phases != 3 {
		t.Fatalf("%+v", a)
	}
	near(t, "three phases", a.Kw, 5)

	// The site-wide Mindestleistung stands in for a floor the box cannot
	// know; with bands the box knows it, so the one-phase band stays open.
	set := home()
	set.MinPowerKw = 4.2
	p := Decide(Input{Settings: set, Sessions: []Session{switching("goe#1", 0)}, SourceBudgetKw: kwp(3),
		Policy: PolicyFast, Now: base})
	if a := alloc(t, p, "goe#1"); a.Paused || a.Phases != 1 {
		t.Fatalf("the site minimum must not close the one-phase band: %+v", a)
	}
	plain := sess("plain#1", 11, 0)
	plain.Source = PolicySolarOnly
	p = Decide(Input{Settings: set, Sessions: []Session{plain}, SourceBudgetKw: kwp(3),
		Policy: PolicyFast, Now: base})
	if a := alloc(t, p, "plain#1"); !a.Paused {
		t.Fatalf("without bands the site minimum binds as before: %+v", a)
	}

	// A minimum inside the gap starts at the next achievable value.
	s.MinKw = 3.9
	a = alloc(t, solar(t, 4, s), "goe#1")
	if !a.Paused {
		t.Fatalf("3.9 kW cannot be charged, 4 kW of sun is not 4.14: %+v", a)
	}
}

// TestSonneZuerstHoldsTheOnePhaseMinimumFromTheGrid - the concession now costs
// 1.38 kW of grid instead of 4.14.
func TestSonneZuerstHoldsTheOnePhaseMinimumFromTheGrid(t *testing.T) {
	s := switching("goe#1", 0)
	s.Source = PolicySolarFirst
	a := alloc(t, solar(t, 0.5, s), "goe#1")
	if a.Paused || a.Phases != 1 {
		t.Fatalf("%+v", a)
	}
	near(t, "one-phase minimum", a.Kw, 1.38)
}

// TestOnlyTheActiveBandWhileASwitchIsHeld - three phases cannot serve 2 kW, so
// a held switch is a pause, never three phases from the grid.
func TestOnlyTheActiveBandWhileASwitchIsHeld(t *testing.T) {
	s := switching("goe#1", 0)
	s.Ranges = goeBands.OnlyActive(3)
	a := alloc(t, solar(t, 2, s), "goe#1")
	if !a.Paused || a.Reason != ReasonNoSurplus {
		t.Fatalf("%+v", a)
	}
	s.Ranges = goeBands.OnlyActive(1)
	a = alloc(t, solar(t, 9, s), "goe#1")
	if a.Phases != 1 {
		t.Fatalf("%+v", a)
	}
	near(t, "one phase at its ceiling", a.Kw, 3.68)
}

// TestACapBelowEveryBandPausesWithTheHoldersWord.
func TestACapBelowEveryBandPausesWithTheHoldersWord(t *testing.T) {
	s := switching("goe#1", 0)
	s.CapKw, s.CapReason = kwp(1), ReasonPlan
	a := alloc(t, solar(t, 9, s), "goe#1")
	if !a.Paused || a.Reason != ReasonPlan {
		t.Fatalf("%+v", a)
	}
	s.CapKw = kwp(3)
	a = alloc(t, solar(t, 9, s), "goe#1")
	if a.Phases != 1 {
		t.Fatalf("%+v", a)
	}
	near(t, "the cap picks the band", a.Kw, 3)
}

// TestABandChangeIsNeverPaced - holding the old value would hold the old phase
// count, and the executor switches on the band.
func TestABandChangeIsNeverPaced(t *testing.T) {
	s := switching("goe#1", 0)
	first := solar(t, 3.68, s)
	p := Decide(Input{Settings: home(), Sessions: []Session{s}, SourceBudgetKw: kwp(4.3),
		Policy: PolicyFast, Previous: &first, Now: base.Add(time.Second)})
	a := alloc(t, p, "goe#1")
	if a.Phases != 3 {
		t.Fatalf("a +0.62 kW step into the next band went through: %+v", a)
	}
	near(t, "three phases", a.Kw, 4.3)
}

// TestWithoutBandsNothingChanges - the compatibility promise.
func TestWithoutBandsNothingChanges(t *testing.T) {
	s := sess("plain#1", 11, 0)
	s.Source = PolicySolarOnly
	s.MinKw = 4.2
	a := alloc(t, solar(t, 3.9, s), "plain#1")
	if !a.Paused || a.Phases != 0 {
		t.Fatalf("%+v", a)
	}
	a = alloc(t, solar(t, 5, s), "plain#1")
	if a.Phases != 0 {
		t.Fatalf("%+v", a)
	}
	near(t, "plain", a.Kw, 5)
}

func TestPhasePacerDwellsAndPauses(t *testing.T) {
	p := NewPhasePacer(3, 7)
	now := base
	if p.Observe(now, 1) {
		t.Fatal("a new wish must dwell first")
	}
	if !p.Held() {
		t.Fatal("held while dwelling")
	}
	if p.Observe(now.Add(59*time.Second), 1) {
		t.Fatal("still dwelling")
	}
	if !p.Observe(now.Add(60*time.Second), 1) {
		t.Fatal("first switch of a session needs only the dwell")
	}
	now = now.Add(60 * time.Second)
	p.Switched(now, 1)
	if p.Active != 1 || p.Held() {
		t.Fatalf("%+v", p)
	}
	// Back up after the dwell, but not before the pause.
	p.Observe(now.Add(time.Minute), 3)
	if p.Observe(now.Add(4*time.Minute), 3) {
		t.Fatal("five minutes between two switches")
	}
	if !p.Observe(now.Add(5*time.Minute), 3) {
		t.Fatal("pause over")
	}
}

func TestPhasePacerForgetsAWishThatWentAway(t *testing.T) {
	p := NewPhasePacer(3, 7)
	p.Observe(base, 1)
	if !p.Observe(base.Add(30*time.Second), 3) {
		t.Fatal("wanting the active band is always allowed")
	}
	if p.Observe(base.Add(40*time.Second), 1) {
		t.Fatal("the dwell restarts after the wish went away")
	}
	p.Observe(base.Add(50*time.Second), 0)
	if p.Held() {
		t.Fatal("a pause is no switch wish")
	}
	p.Switched(base.Add(time.Minute), 3)
	if p.Active != 3 || !p.lastSwitch.IsZero() {
		t.Fatal("re-confirming the active band is not a switch")
	}
}
