package guards

// In-slot load following (2026-07-30), the discharge-side mirror of the trim.
// Each test states a property the correction must have: the un-marked slot is
// untouched, the marked one covers the MEASURED house, the compliance bounds
// survive (never export, never past the rated band / SoC floor / peak reserve),
// unknown measurements never regulate blind, and the state cannot flap with the
// ~10 s setpoint cadence.

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
	if math.Abs(got.DeficitKw-7.087) > 1e-3 {
		t.Fatalf("deficit = %v, want 7.087", got.DeficitKw)
	}
	// The point of the whole feature: the house causes NO grid import.
	predictedGrid := 7.117 + got.Kw - 0.03
	if math.Abs(predictedGrid) > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0 (the house is covered)", predictedGrid)
	}
}

// THE safety property the whole design rests on: the correction never moves the
// predicted grid power DOWN past zero. Where it bites it lands exactly at 0, and
// where the plan's own command already exports it is left alone - so the
// correction can never re-violate the §14a export bound or a feed-in cap, which
// were applied to the value entering it.
func TestTheCorrectionNeverDeepensExport(t *testing.T) {
	f := NewLoadFollower()
	cases := []Reading{
		{SocPct: 80, PvKw: 0, LoadKw: 12, GridLimitKw: Unknown()},
		{SocPct: 80, PvKw: 3.4, LoadKw: 9.1, GridLimitKw: Unknown()},
		// A PV surplus: the plan's own -1.0 kW already exports 6.7 kW. Nothing to
		// cover, so the command must come back untouched - the correction must
		// NOT "improve" it toward zero either (it only ever lowers the setpoint).
		{SocPct: 80, PvKw: 9.1, LoadKw: 3.4, GridLimitKw: Unknown()},
		{SocPct: 80, PvKw: 0.03, LoadKw: 7.117, GridLimitKw: Unknown()},
	}
	for i, r := range cases {
		f.Release()
		before := r.LoadKw + (-1.0) - r.PvKw
		got := f.Apply(followBase(), -1.0, true, followLimits(), nil, r)
		after := r.LoadKw + got.Kw - r.PvKw
		floor := math.Min(before, 0)
		if after < floor-1e-9 {
			t.Fatalf("case %d: predicted grid %v -> %v, must never go below min(before, 0) = %v",
				i, before, after, floor)
		}
		if got.Active && math.Abs(after) > 1e-9 {
			t.Fatalf("case %d: where it bites the predicted grid must be exactly 0, got %v", i, after)
		}
	}
}

// A PV surplus means there is nothing to cover: the plan's own discharge stands.
func TestASurplusSlotIsLeftAloneEvenWhenMarked(t *testing.T) {
	f := NewLoadFollower()
	r := Reading{SocPct: 80, PvKw: 9.1, LoadKw: 3.4, GridLimitKw: Unknown()}
	got := f.Apply(followBase(), -1.0, true, followLimits(), nil, r)
	if got.Active || got.Kw != -1.0 {
		t.Fatalf("surplus slot: %+v, want the plan's -1.0 untouched", got)
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

// Anti-flap, asymmetric like the trim: engaging is immediate, releasing needs
// the plan's OWN setpoint to comfortably cover the house for the dwell window.
func TestTheCorrectionDoesNotFlapWithTheSetpointCadence(t *testing.T) {
	f := NewLoadFollower()
	now := followBase()
	l := followLimits()
	r := pilstingNight()

	if got := f.Apply(now, -4.332, true, l, nil, r); !got.Active {
		t.Fatal("engaging must be immediate")
	}
	// The plan now covers the house on its own, but only just: still engaged
	// while the dwell runs.
	now = now.Add(10 * time.Second)
	deep := -(r.LoadKw - r.PvKw) - 0.5 // comfortably covering
	if got := f.Apply(now, deep, true, l, nil, r); !f.Engaged() {
		t.Fatalf("released after one tick (%+v) - the dwell must hold it", got)
	}
	// Still inside the dwell.
	now = now.Add(30 * time.Second)
	f.Apply(now, deep, true, l, nil, r)
	if !f.Engaged() {
		t.Fatal("released before the dwell elapsed")
	}
	// Past the dwell it lets go.
	now = now.Add(FollowReleaseDwell)
	f.Apply(now, deep, true, l, nil, r)
	if f.Engaged() {
		t.Fatal("the correction must release after the dwell")
	}
	// A load step back re-engages immediately (money must not be bought while a
	// dwell runs down).
	if got := f.Apply(now.Add(time.Second), -1.0, true, l, nil, r); !got.Active {
		t.Fatal("a fresh deficit must re-engage at once")
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
