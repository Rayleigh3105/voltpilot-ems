package guards

// In-slot load following (2026-07-30), the discharge-side mirror of the trim.
// Each test states a property the correction must have: the un-marked slot is
// untouched, the marked one TRACKS the MEASURED house in BOTH directions (raise
// where the plan falls short, limit where it overshoots, floor at zero - never a
// charge), the compliance bounds survive (never move the predicted grid past
// zero, never past the rated band / SoC floor / peak reserve), unknown
// measurements never regulate blind, and the state cannot flap with the ~10 s
// setpoint cadence.

import (
	"math"
	"testing"
	"time"
)

func followBase() time.Time { return time.Date(2026, 7, 30, 21, 22, 48, 0, time.UTC) }

func followLimits() Limits {
	return Limits{MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 10, SocMaxPct: 95}
}

// pilstingNight is the live reading behind the whole feature (scout report
// vp-netzbezug-nacht-s3 §2.1): house 7.117 kW, PV 0.03 kW, SoC 77 % - and a plan
// setpoint of -4.332 kW (its LOAD FORECAST), so 2.755 kW came from the grid.
func pilstingNight() Reading {
	return Reading{SocPct: 77, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: Unknown()}
}

func TestUnmarkedSlotLeavesThePlanSetpointUntouched(t *testing.T) {
	f := NewLoadFollower()
	got := f.Apply(followBase(), -4.332, false, followLimits(), nil, pilstingNight())
	if got.Kw != -4.332 || got.Active {
		t.Fatalf("unmarked slot: %+v, want the plan setpoint -4.332 untouched", got)
	}
	if f.Engaged() {
		t.Fatal("an unmarked slot must never engage the correction")
	}
}

// THE money case: the plan's forecast-derived discharge is raised to what the
// house really draws, so the 2.755 kW is no longer bought.
func TestMarkedSlotRaisesTheDischargeToTheMeasuredHouseLoad(t *testing.T) {
	f := NewLoadFollower()
	got := f.Apply(followBase(), -4.332, true, followLimits(), nil, pilstingNight())
	if !got.Active {
		t.Fatal("a marked slot with a 2.755 kW grid draw must engage the correction")
	}
	want := 0.03 - 7.117 // pv - load
	if math.Abs(got.Kw-want) > 1e-3 {
		t.Fatalf("followed setpoint = %v, want the measured deficit %v", got.Kw, want)
	}
	if got.CommandedKw != -4.332 {
		t.Fatalf("commanded = %v, want the pre-correction -4.332 (the card names it)", got.CommandedKw)
	}
	if got.Direction != FollowDeepen {
		t.Fatalf("direction = %q, want %q (the card names which way it corrected)", got.Direction, FollowDeepen)
	}
	if math.Abs(got.DeficitKw-7.087) > 1e-3 {
		t.Fatalf("deficit = %v, want 7.087", got.DeficitKw)
	}
	// The point of the whole feature: the house causes NO grid import.
	predictedGrid := 7.117 + got.Kw - 0.03
	if math.Abs(predictedGrid) > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0 (the house is covered)", predictedGrid)
	}
}

// THE OTHER money case (Pilsting 23:12, the mirror of the 21:22 one): the plan
// discharged 6.7 kW - again its forecast - into a house drawing only 5.1 kW, so
// 1.4 kW left the site at ~21 ct while that same kWh was worth ~32.5 ct as
// avoided import a few hours later. The correction must LIMIT the discharge to
// what the house draws.
func TestMarkedSlotLimitsADischargeThatOvershootsTheMeasuredHouse(t *testing.T) {
	f := NewLoadFollower()
	r := Reading{SocPct: 77, PvKw: 0, LoadKw: 5.1, GridLimitKw: Unknown()}
	got := f.Apply(followBase(), -6.7, true, followLimits(), nil, r)
	if !got.Active {
		t.Fatal("a marked slot exporting 1.4 kW of battery energy must engage the correction")
	}
	if got.Direction != FollowReduce {
		t.Fatalf("direction = %q, want %q", got.Direction, FollowReduce)
	}
	if math.Abs(got.Kw+5.1) > 1e-9 {
		t.Fatalf("followed setpoint = %v, want the measured deficit -5.1", got.Kw)
	}
	if got.CommandedKw != -6.7 {
		t.Fatalf("commanded = %v, want the pre-correction -6.7 (the card names it)", got.CommandedKw)
	}
	// The point: nothing leaves the site unpriced any more.
	if predicted := r.LoadKw + got.Kw - r.PvKw; math.Abs(predicted) > 1e-9 {
		t.Fatalf("predicted grid = %v kW, want 0", predicted)
	}
}

// The floor of the limiting direction is a STOPPED discharge, never a charge: an
// economic guard may correct a magnitude, never flip a direction.
func TestWithNoDeficitTheDischargeStopsAtZeroAndNeverCharges(t *testing.T) {
	f := NewLoadFollower()
	// PV covers the house outright, so the deficit is 0.
	r := Reading{SocPct: 80, PvKw: 9.1, LoadKw: 3.4, GridLimitKw: Unknown()}
	got := f.Apply(followBase(), -1.0, true, followLimits(), nil, r)
	if !got.Active || got.Direction != FollowReduce {
		t.Fatalf("surplus slot: %+v, want the discharge limited", got)
	}
	if got.Kw != 0 {
		t.Fatalf("followed setpoint = %v, want exactly 0 - never a charge", got.Kw)
	}
	if got.DeficitKw != 0 {
		t.Fatalf("deficit = %v, want 0", got.DeficitKw)
	}
	// Even a huge surplus never turns into a charge command.
	f.Release()
	r.PvKw = 40
	got = f.Apply(followBase(), -1.0, true, followLimits(), nil, r)
	if got.Kw > 0 {
		t.Fatalf("followed setpoint = %v, must never be positive (that would be a direction flip)", got.Kw)
	}
}

// THE safety property the whole design rests on, now in both directions: the
// correction only ever moves the predicted grid power TOWARD zero - never past
// it, never further away. So it can never push the site into export (the §14a
// export bound and any feed-in cap were applied to the value entering it and
// stay valid) and never raise the import beyond what entered it (same for the
// import bound). Where it bites unbounded it lands at the point where the
// BATTERY no longer contributes to the grid exchange: exactly 0 whenever the
// house has a deficit, and the remaining PV surplus where it has none (only a
// CHARGE could absorb that, and charging is a price decision this guard must
// never take on its own).
func TestTheCorrectionOnlyEverMovesThePredictedGridTowardZero(t *testing.T) {
	f := NewLoadFollower()
	type tc struct {
		r  Reading
		kw float64
	}
	cases := []tc{
		{Reading{SocPct: 80, PvKw: 0, LoadKw: 12, GridLimitKw: Unknown()}, -1.0},        // deep import
		{Reading{SocPct: 80, PvKw: 3.4, LoadKw: 9.1, GridLimitKw: Unknown()}, -1.0},     // import
		{Reading{SocPct: 80, PvKw: 9.1, LoadKw: 3.4, GridLimitKw: Unknown()}, -1.0},     // export via pv
		{Reading{SocPct: 80, PvKw: 0, LoadKw: 5.1, GridLimitKw: Unknown()}, -6.7},       // export via battery
		{Reading{SocPct: 80, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: Unknown()}, -1.0},  // the 21:22 case
		{Reading{SocPct: 80, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: Unknown()}, -7.09}, // already tracking
	}
	for i, c := range cases {
		f.Release()
		before := c.r.LoadKw + c.kw - c.r.PvKw
		got := f.Apply(followBase(), c.kw, true, followLimits(), nil, c.r)
		after := c.r.LoadKw + got.Kw - c.r.PvKw
		lo, hi := math.Min(before, 0), math.Max(before, 0)
		if after < lo-1e-9 || after > hi+1e-9 {
			t.Fatalf("case %d: predicted grid %v -> %v, must stay within [%v, %v]", i, before, after, lo, hi)
		}
		// The battery's own contribution is gone; what remains is the PV surplus.
		wantAfter := -math.Max(c.r.PvKw-c.r.LoadKw, 0)
		if got.Active && math.Abs(after-wantAfter) > 1e-9 {
			t.Fatalf("case %d: where it bites unbounded the predicted grid must be %v, got %v", i, wantAfter, after)
		}
	}
}

// The protection of the price arbitrage: an UNMARKED slot is byte-identical in
// BOTH directions - a deliberate sell window (a deep discharge into the grid)
// and a deliberate cheap-hour purchase both stand exactly as planned.
func TestAnUnmarkedSlotIsUntouchedInBothDirections(t *testing.T) {
	f := NewLoadFollower()
	// A deliberate 30 kW sell window against a small house.
	sell := Reading{SocPct: 80, PvKw: 0, LoadKw: 2.0, GridLimitKw: Unknown()}
	if got := f.Apply(followBase(), -30, false, followLimits(), nil, sell); got.Active || got.Kw != -30 {
		t.Fatalf("sell window: %+v, want the plan's -30 untouched", got)
	}
	// A deliberate purchase: the plan under-discharges on purpose.
	buy := pilstingNight()
	if got := f.Apply(followBase(), -1.0, false, followLimits(), nil, buy); got.Active || got.Kw != -1.0 {
		t.Fatalf("cheap-hour purchase: %+v, want the plan's -1.0 untouched", got)
	}
	if f.Engaged() {
		t.Fatal("an unmarked slot must never engage the correction")
	}
}

// A commanded CHARGE is never flipped into a discharge - deepening a discharge
// is a magnitude correction, a direction flip is not something an economic guard
// may do (the trim likewise stops at 0).
func TestACommandedChargeIsNeverFlippedIntoADischarge(t *testing.T) {
	f := NewLoadFollower()
	got := f.Apply(followBase(), 5.0, true, followLimits(), nil, pilstingNight())
	if got.Active || got.Kw != 5.0 {
		t.Fatalf("charge command: %+v, want it untouched", got)
	}
	if f.Engaged() {
		t.Fatal("a charge command must leave the correction released")
	}
}

// The raised discharge stays inside the rated band.
func TestTheRaisedDischargeRespectsTheRatedBand(t *testing.T) {
	f := NewLoadFollower()
	l := Limits{MaxChargeKw: 30, MaxDischargeKw: 5, SocMinPct: 10, SocMaxPct: 95}
	got := f.Apply(followBase(), -1.0, true, l, nil, pilstingNight())
	if got.Kw < -5.0-1e-9 {
		t.Fatalf("followed setpoint = %v, want no deeper than the rated -5", got.Kw)
	}
	if got.Kw != -5.0 {
		t.Fatalf("followed setpoint = %v, want the rated -5", got.Kw)
	}
}

// At/below the SoC floor the battery must not be deepened at all - a price can
// never justify discharging below the technical floor.
func TestAtTheSocFloorNothingIsRaised(t *testing.T) {
	f := NewLoadFollower()
	r := pilstingNight()
	r.SocPct = 10 // == SocMinPct
	got := f.Apply(followBase(), 0, true, followLimits(), nil, r)
	if got.Active || got.Kw != 0 {
		t.Fatalf("at the SoC floor: %+v, want no discharge at all", got)
	}
}

// The peak reserve is honored: ordinary load covering is exactly what that
// reserve must survive (the same rule the stale-plan fallback applies). Peak
// DEFENSE may still go below it - that runs after this and gets the untouched
// limits.
func TestThePeakReserveStopsOrdinaryLoadCovering(t *testing.T) {
	f := NewLoadFollower()
	r := pilstingNight()
	r.SocPct = 30
	reserve := 40.0
	got := f.Apply(followBase(), -1.0, true, followLimits(), &reserve, r)
	if got.Active || got.Kw != -1.0 {
		t.Fatalf("below the peak reserve: %+v, want the plan's -1.0 untouched", got)
	}
	// Above the reserve it works normally again.
	f.Release()
	r.SocPct = 60
	got = f.Apply(followBase(), -1.0, true, followLimits(), &reserve, r)
	if !got.Active {
		t.Fatalf("above the reserve: %+v, want the correction to engage", got)
	}
	// The LIMITING direction is never held back by the reserve - it only ever
	// preserves stored energy, which is what the reserve wants.
	f.Release()
	r.SocPct = 30
	got = f.Apply(followBase(), -12.0, true, followLimits(), &reserve, r)
	if !got.Active || got.Direction != FollowReduce {
		t.Fatalf("below the reserve: %+v, want an overshoot still limited", got)
	}
	if math.Abs(got.Kw+7.087) > 1e-3 {
		t.Fatalf("followed setpoint = %v, want the measured deficit -7.087", got.Kw)
	}
}

// Never regulate blind (the economic-guard convention, cf. PeakShave).
func TestUnknownMeasurementsLeaveTheCommandUntouched(t *testing.T) {
	f := NewLoadFollower()
	for name, r := range map[string]Reading{
		"unknown pv":   {SocPct: 77, PvKw: Unknown(), LoadKw: 7.117, GridLimitKw: Unknown()},
		"unknown load": {SocPct: 77, PvKw: 0.03, LoadKw: Unknown(), GridLimitKw: Unknown()},
		"neither":      {SocPct: 77, PvKw: Unknown(), LoadKw: Unknown(), GridLimitKw: Unknown()},
	} {
		f.Release()
		got := f.Apply(followBase(), -4.332, true, followLimits(), nil, r)
		if got.Active || got.Kw != -4.332 {
			t.Fatalf("%s: %+v, want the command untouched (never regulate blind)", name, got)
		}
		if !math.IsNaN(got.DeficitKw) {
			t.Fatalf("%s: deficit = %v, want NaN (unknown)", name, got.DeficitKw)
		}
	}
}

// Anti-flap, SYMMETRIC around the zero-grid target and asymmetric in time:
// engaging is immediate in either direction, releasing needs the plan's OWN
// setpoint to track the deficit within the margin for the dwell window.
func TestTheCorrectionDoesNotFlapWithTheSetpointCadence(t *testing.T) {
	f := NewLoadFollower()
	now := followBase()
	l := followLimits()
	r := pilstingNight()
	tracking := -(r.LoadKw - r.PvKw) // exactly zero grid

	if got := f.Apply(now, -4.332, true, l, nil, r); !got.Active {
		t.Fatal("engaging must be immediate")
	}
	// The plan itself now tracks the house: engaged while the dwell runs.
	now = now.Add(10 * time.Second)
	if got := f.Apply(now, tracking, true, l, nil, r); !f.Engaged() {
		t.Fatalf("released after one tick (%+v) - the dwell must hold it", got)
	}
	// Still inside the dwell.
	now = now.Add(30 * time.Second)
	f.Apply(now, tracking, true, l, nil, r)
	if !f.Engaged() {
		t.Fatal("released before the dwell elapsed")
	}
	// Past the dwell it lets go.
	now = now.Add(FollowReleaseDwell)
	f.Apply(now, tracking, true, l, nil, r)
	if f.Engaged() {
		t.Fatal("the correction must release after the dwell")
	}
	// A load step back re-engages immediately (money must not be bought while a
	// dwell runs down).
	if got := f.Apply(now.Add(time.Second), -1.0, true, l, nil, r); !got.Active {
		t.Fatal("a fresh deficit must re-engage at once")
	}
}

// The SAME hysteresis on the limiting side: a plan overshooting the house
// engages at once, and a dwell of tracking is what releases it - a plan sitting
// just inside the margin must not toggle the correction every tick.
func TestTheLimitingDirectionHasTheSameHysteresis(t *testing.T) {
	f := NewLoadFollower()
	now := followBase()
	l := followLimits()
	r := Reading{SocPct: 77, PvKw: 0, LoadKw: 5.1, GridLimitKw: Unknown()}

	// Inside the engage margin: nothing happens (0.1 kW of export is noise).
	if got := f.Apply(now, -5.2, true, l, nil, r); got.Active || f.Engaged() {
		t.Fatalf("%+v: a 0.1 kW overshoot is inside the margin, nothing to correct", got)
	}
	// Beyond it: engage immediately.
	now = now.Add(10 * time.Second)
	if got := f.Apply(now, -6.7, true, l, nil, r); !got.Active || got.Direction != FollowReduce {
		t.Fatalf("%+v: a 1.6 kW overshoot must engage the limiting direction", got)
	}
	// The plan comes back to the house: held engaged through the dwell...
	now = now.Add(10 * time.Second)
	f.Apply(now, -5.1, true, l, nil, r)
	if !f.Engaged() {
		t.Fatal("released after one tick - the dwell must hold it")
	}
	// ...then released.
	now = now.Add(FollowReleaseDwell)
	f.Apply(now, -5.1, true, l, nil, r)
	if f.Engaged() {
		t.Fatal("the correction must release after the dwell")
	}
	// And an overshoot swinging back re-engages at once.
	if got := f.Apply(now.Add(time.Second), -6.7, true, l, nil, r); !got.Active {
		t.Fatal("a fresh overshoot must re-engage at once")
	}
}

// The two directions are one state machine: a slot whose measured deficit swings
// through the plan's setpoint hands over from limiting to deepening without
// releasing, and the applied value follows the deficit each tick.
func TestTheEngagedStateCarriesAcrossADirectionChange(t *testing.T) {
	f := NewLoadFollower()
	now := followBase()
	l := followLimits()
	r := Reading{SocPct: 77, PvKw: 0, LoadKw: 5.1, GridLimitKw: Unknown()}

	got := f.Apply(now, -6.7, true, l, nil, r)
	if got.Direction != FollowReduce || math.Abs(got.Kw+5.1) > 1e-9 {
		t.Fatalf("%+v, want the discharge limited to -5.1", got)
	}
	// The house steps up past the plan's value.
	r.LoadKw = 9.0
	got = f.Apply(now.Add(10*time.Second), -6.7, true, l, nil, r)
	if got.Direction != FollowDeepen || math.Abs(got.Kw+9.0) > 1e-9 {
		t.Fatalf("%+v, want the discharge deepened to -9.0", got)
	}
	if !f.Engaged() {
		t.Fatal("the correction must stay engaged across the direction change")
	}
}

// A deficit that GROWS mid-slot is followed immediately: under-covering it is
// exactly the money loss the feature exists to stop, and a shrinking one MUST be
// followed at once or the site would export (the safety argument above).
func TestTheAppliedValueFollowsTheDeficitInBothDirections(t *testing.T) {
	f := NewLoadFollower()
	now := followBase()
	l := followLimits()

	r := Reading{SocPct: 77, PvKw: 0, LoadKw: 5, GridLimitKw: Unknown()}
	got := f.Apply(now, -1.0, true, l, nil, r)
	if math.Abs(got.Kw+5) > 1e-9 {
		t.Fatalf("setpoint = %v, want -5", got.Kw)
	}
	// The house steps up.
	r.LoadKw = 9
	got = f.Apply(now.Add(10*time.Second), -1.0, true, l, nil, r)
	if math.Abs(got.Kw+9) > 1e-9 {
		t.Fatalf("setpoint = %v, want -9 (a growing deficit is followed at once)", got.Kw)
	}
	// The house steps down - following at once is what keeps the site out of
	// export.
	r.LoadKw = 2
	got = f.Apply(now.Add(20*time.Second), -1.0, true, l, nil, r)
	if math.Abs(got.Kw+2) > 1e-9 {
		t.Fatalf("setpoint = %v, want -2 (a shrinking deficit must not be held)", got.Kw)
	}
	if predicted := r.LoadKw + got.Kw - r.PvKw; predicted < -1e-9 {
		t.Fatalf("predicted grid = %v (EXPORT)", predicted)
	}
}

// Composition with the peak guard: both are restrict-only, so the result is the
// minimum either way and neither can undo the other's bound.
func TestTheCorrectionComposesWithThePeakGuard(t *testing.T) {
	f := NewLoadFollower()
	l := followLimits()
	r := pilstingNight()
	got := f.Apply(followBase(), -1.0, true, l, nil, r)
	// The peak guard demands import <= 0 too, so it finds nothing left to do.
	after := PeakShave(got.Kw, 0, l, r)
	if math.Abs(after-got.Kw) > 1e-9 {
		t.Fatalf("peak guard changed %v to %v - the composition must be a minimum", got.Kw, after)
	}
	// A tighter peak target still wins (it may go deeper).
	deeper := PeakShave(got.Kw, 0, Limits{MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 10, SocMaxPct: 95},
		Reading{SocPct: 77, PvKw: 0.03, LoadKw: 12, GridLimitKw: Unknown()})
	if deeper > got.Kw {
		t.Fatalf("peak guard raised the setpoint (%v -> %v)", got.Kw, deeper)
	}

	// The LIMITING direction cannot undo the peak guard either: it lands at
	// predicted import 0, and every allowance the peak guard can compute is >= 0.
	f.Release()
	over := Reading{SocPct: 77, PvKw: 0, LoadKw: 5.1, GridLimitKw: Unknown()}
	limited := f.Apply(followBase(), -6.7, true, l, nil, over)
	for _, allowed := range []float64{0, 0.5, 25} {
		if after := PeakShave(limited.Kw, allowed, l, over); after != limited.Kw {
			t.Fatalf("peak guard (allowed %v) changed the limited %v to %v", allowed, limited.Kw, after)
		}
	}
}

// Release() clears the hysteresis (used by the setpoint path's early exits).
func TestReleaseClearsTheEngagedState(t *testing.T) {
	f := NewLoadFollower()
	f.Apply(followBase(), -4.332, true, followLimits(), nil, pilstingNight())
	if !f.Engaged() {
		t.Fatal("expected the correction to be engaged first")
	}
	f.Release()
	if f.Engaged() {
		t.Fatal("Release must clear the engaged state")
	}
}

// A non-finite command is refused like every other blind input.
func TestANonFiniteCommandIsLeftAlone(t *testing.T) {
	f := NewLoadFollower()
	got := f.Apply(followBase(), math.NaN(), true, followLimits(), nil, pilstingNight())
	if got.Active || !math.IsNaN(got.Kw) {
		t.Fatalf("NaN command: %+v, want it passed through untouched", got)
	}
}
