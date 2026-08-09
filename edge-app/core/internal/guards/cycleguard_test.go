package guards

import (
	"math"
	"testing"
	"time"
)

var berlin = func() *time.Location {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		panic(err)
	}
	return loc
}()

func at(h, m, s int) time.Time {
	return time.Date(2026, 8, 10, h, m, s, 0, time.UTC)
}

func TestMinOffHoldsASwitchOnAndReleasesAfterThePause(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MinOff: 60 * time.Second}, berlin)

	// Baseline: on, then off.
	if on, _, hold := g.Apply(at(10, 0, 0), true, math.NaN()); !on || hold != nil {
		t.Fatalf("initial on refused: on=%v hold=%v", on, hold)
	}
	if on, _, hold := g.Apply(at(10, 5, 0), false, math.NaN()); on || hold != nil {
		t.Fatalf("switch-off refused: on=%v hold=%v", on, hold)
	}

	// A wish to restart 20 s later is HELD with the honest reason.
	on, _, hold := g.Apply(at(10, 5, 20), true, math.NaN())
	if on {
		t.Fatalf("min-off pause violated: switched on after 20s")
	}
	if hold == nil || hold.Code != CycleReasonMinOff || hold.Text != "wartet - Mindestpause" {
		t.Fatalf("hold = %+v, want guard_min_off with the German sentence", hold)
	}
	if st := g.State(at(10, 5, 21)); st.Hold == nil || st.Hold.Code != CycleReasonMinOff {
		t.Fatalf("state does not carry the hold: %+v", st)
	}

	// After the pause the same wish passes.
	if on, _, hold := g.Apply(at(10, 6, 1), true, math.NaN()); !on || hold != nil {
		t.Fatalf("switch-on after the pause refused: on=%v hold=%v", on, hold)
	}
}

func TestMinOnHoldsTheGrantedLevelUntilTheMinimumRuntime(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MinOn: 120 * time.Second}, berlin)

	if on, kw, _ := g.Apply(at(9, 0, 0), true, 2.2); !on || kw != 2.2 {
		t.Fatalf("start refused: on=%v kw=%v", on, kw)
	}
	// A switch-off wish 30 s in HOLDS the previously granted level - never a
	// new one, never off.
	on, kw, hold := g.Apply(at(9, 0, 30), false, 0)
	if !on || kw != 2.2 {
		t.Fatalf("min-on hold must keep 2.2 kW on: on=%v kw=%v", on, kw)
	}
	if hold == nil || hold.Code != CycleReasonMinOn {
		t.Fatalf("hold = %+v, want guard_min_on", hold)
	}
	// After the minimum runtime the switch-off passes.
	if on, kw, hold := g.Apply(at(9, 2, 1), false, 0); on || kw != 0 || hold != nil {
		t.Fatalf("switch-off after min-on refused: on=%v kw=%v hold=%v", on, kw, hold)
	}
}

func TestMaxStartsPerDayHoldsFurtherStartsUntilTheLocalDayRollsOver(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MaxStartsPerDay: 2}, berlin)

	for i, tt := range []struct{ on, off time.Time }{
		{at(8, 0, 0), at(8, 10, 0)},
		{at(9, 0, 0), at(9, 10, 0)},
	} {
		if on, _, hold := g.Apply(tt.on, true, math.NaN()); !on || hold != nil {
			t.Fatalf("start %d refused: on=%v hold=%v", i+1, on, hold)
		}
		if on, _, _ := g.Apply(tt.off, false, math.NaN()); on {
			t.Fatalf("stop %d refused", i+1)
		}
	}
	on, _, hold := g.Apply(at(10, 0, 0), true, math.NaN())
	if on || hold == nil || hold.Code != CycleReasonMaxStarts {
		t.Fatalf("third start must be held: on=%v hold=%+v", on, hold)
	}
	if st := g.State(at(10, 0, 1)); st.StartsToday != 2 {
		t.Fatalf("StartsToday = %d, want 2", st.StartsToday)
	}

	// Local-day rollover (Europe/Berlin): 22:30 UTC on Aug 10 is 00:30 local
	// on Aug 11 - the budget resets, the start passes.
	next := time.Date(2026, 8, 10, 22, 30, 0, 0, time.UTC)
	if on, _, hold := g.Apply(next, true, math.NaN()); !on || hold != nil {
		t.Fatalf("start after local-day rollover refused: on=%v hold=%v", on, hold)
	}
	if st := g.State(next.Add(time.Second)); st.StartsToday != 1 {
		t.Fatalf("StartsToday after rollover = %d, want 1", st.StartsToday)
	}
}

func TestRampBoundsTheLevelChangeInBothDirectionsAndConverges(t *testing.T) {
	g := NewCycleGuard(CycleLimits{RampKwPerMin: 6}, berlin)

	// Fresh start: ramps FROM 0, so the first decision grants 0.
	if _, kw, hold := g.Apply(at(12, 0, 0), true, 11); kw != 0 || hold == nil || hold.Code != CycleReasonRamp {
		t.Fatalf("fresh start must ramp from 0: kw=%v hold=%+v", kw, hold)
	}
	// 30 s later: 6 kW/min * 0.5 min = 3 kW allowed.
	if _, kw, hold := g.Apply(at(12, 0, 30), true, 11); kw != 3 || hold == nil {
		t.Fatalf("ramp after 30s = %v (hold %+v), want 3", kw, hold)
	}
	// 2 min later the wish is reachable - hold clears.
	if _, kw, hold := g.Apply(at(12, 2, 30), true, 11); kw != 11 || hold != nil {
		t.Fatalf("ramp convergence failed: kw=%v hold=%+v", kw, hold)
	}
	// Downward is bounded too (a hold toward the wish, never below it).
	if _, kw, hold := g.Apply(at(12, 3, 0), true, 2); kw != 8 || hold == nil || hold.Code != CycleReasonRamp {
		t.Fatalf("downward ramp = %v (hold %+v), want 8", kw, hold)
	}
}

func TestUnknownLimitsInventNoProtection(t *testing.T) {
	g := NewCycleGuard(CycleLimits{}, berlin)
	// Rapid toggling passes untouched - no axis is configured.
	times := []time.Time{at(7, 0, 0), at(7, 0, 1), at(7, 0, 2), at(7, 0, 3)}
	wishes := []bool{true, false, true, false}
	for i := range times {
		on, _, hold := g.Apply(times[i], wishes[i], math.NaN())
		if on != wishes[i] || hold != nil {
			t.Fatalf("step %d: on=%v hold=%v - an unconfigured guard must never hold", i, on, hold)
		}
	}
}

func TestRuntimeTodayAccruesCommandedOnTimeAndResetsOnRollover(t *testing.T) {
	g := NewCycleGuard(CycleLimits{}, berlin)
	g.Apply(at(6, 0, 0), true, math.NaN())
	if st := g.State(at(6, 10, 0)); st.RuntimeTodaySeconds != 600 {
		t.Fatalf("RuntimeTodaySeconds = %d, want 600", st.RuntimeTodaySeconds)
	}
	g.Apply(at(6, 20, 0), false, math.NaN())
	if st := g.State(at(6, 30, 0)); st.RuntimeTodaySeconds != 1200 {
		t.Fatalf("RuntimeTodaySeconds after stop = %d, want 1200", st.RuntimeTodaySeconds)
	}
	// Rollover clears the day counters.
	next := time.Date(2026, 8, 10, 22, 30, 0, 0, time.UTC) // 00:30 local Aug 11
	if st := g.State(next); st.RuntimeTodaySeconds != 0 || st.StartsToday != 0 {
		t.Fatalf("day rollover did not reset: %+v", st)
	}
}

func TestFirstDecisionAfterBootOwesNoPauseButConsumesTheStartBudget(t *testing.T) {
	// A reboot forgets the state; the guard must not invent a pause it cannot
	// know - but a commanded start still counts against the day budget.
	g := NewCycleGuard(CycleLimits{MinOff: 10 * time.Minute, MaxStartsPerDay: 1}, berlin)
	if on, _, hold := g.Apply(at(11, 0, 0), true, math.NaN()); !on || hold != nil {
		t.Fatalf("first start after boot refused: on=%v hold=%v", on, hold)
	}
	g.Apply(at(11, 30, 0), false, math.NaN())
	on, _, hold := g.Apply(at(12, 0, 0), true, math.NaN())
	if on || hold == nil || hold.Code != CycleReasonMaxStarts {
		t.Fatalf("budget must bind after the boot start: on=%v hold=%+v", on, hold)
	}
}

func TestNoteUncommandedFallsToOffWithoutAHold(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MinOn: time.Hour}, berlin)
	g.Apply(at(14, 0, 0), true, 3)
	// A release failsafe stops commanding entirely: no command is left to
	// hold onto, the guard's view falls to off with no hold.
	g.NoteUncommanded(at(14, 0, 30))
	st := g.State(at(14, 0, 31))
	if st.On || st.Hold != nil {
		t.Fatalf("uncommanded must be off with no hold: %+v", st)
	}
}

func TestOnOffWishWithoutALevelKeepsNaN(t *testing.T) {
	g := NewCycleGuard(CycleLimits{RampKwPerMin: 1}, berlin)
	_, kw, _ := g.Apply(at(15, 0, 0), true, math.NaN())
	if !math.IsNaN(kw) {
		t.Fatalf("a pure on/off wish must not grow a level: kw=%v", kw)
	}
}
