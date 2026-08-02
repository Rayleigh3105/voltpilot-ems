package guards

// In-slot surplus absorption (2026-08-02), the charge-side counterpart that
// RAISES. Each test states a property the correction must have: the un-marked
// slot is untouched, the marked one RAISES the charge to the MEASURED surplus,
// it never creates an import and never flips a direction, the authoritative
// guard chain still binds (rated band, SoC ceiling, EEG solar-only charge, §14a
// envelope - because this is the only guard that raises, that is the whole
// safety argument), unknown measurements never regulate blind, and the state
// cannot flap with the ~10 s setpoint cadence.

import (
	"math"
	"testing"
	"time"
)

func absorbBase() time.Time { return time.Date(2026, 8, 2, 8, 41, 0, 0, time.UTC) }

func absorbLimits() Limits {
	return Limits{MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 5, SocMaxPct: 95}
}

// pilstingMorning is the live reading behind the whole feature (scout report
// vp-pilsting-abregeln, captain observation 2026-08-02 ~10:41): PV 23.9 kW,
// house 4.3 kW, battery at 7 % SoC - and 16.6 kW leaving the site at a NEGATIVE
// spot price, because the plan commanded a charge its PV forecast sized.
func pilstingMorning() Reading {
	return Reading{SocPct: 7, PvKw: 23.9, LoadKw: 4.3, GridLimitKw: Unknown()}
}

func TestUnmarkedSlotLeavesThePlannedChargeUntouched(t *testing.T) {
	c := NewSurplusCharger()
	got := c.Apply(absorbBase(), 3.0, false, absorbLimits(), pilstingMorning())
	if got.Kw != 3.0 || got.Active {
		t.Fatalf("unmarked slot: %+v, want the plan setpoint 3.0 untouched", got)
	}
	if c.Engaged() {
		t.Fatal("an unmarked slot must never engage the correction")
	}
}

// THE money case: the plan commands nothing (its PV forecast never saw the
// surplus), so the measured surplus is charged instead of being exported at a
// negative price.
func TestMarkedSlotRaisesTheChargeToTheMeasuredSurplus(t *testing.T) {
	c := NewSurplusCharger()
	got := c.Apply(absorbBase(), 0.0, true, absorbLimits(), pilstingMorning())
	if !got.Active {
		t.Fatal("a marked slot with 19.6 kW of unabsorbed surplus must engage")
	}
	want := 23.9 - 4.3 // pv - load
	if math.Abs(got.Kw-want) > 1e-3 {
		t.Fatalf("absorbed setpoint = %v, want the measured surplus %v", got.Kw, want)
	}
	if got.CommandedKw != 0.0 {
		t.Fatalf("commanded = %v, want the pre-correction 0.0 (the card names it)", got.CommandedKw)
	}
	if math.Abs(got.SurplusKw-19.6) > 1e-3 {
		t.Fatalf("surplus = %v, want 19.6", got.SurplusKw)
	}
	// The point of the whole feature: nothing is exported any more.
	predictedGrid := 4.3 + got.Kw - 23.9
	if math.Abs(predictedGrid) > 1e-3 {
		t.Fatalf("predicted grid = %v kW, want 0 (the surplus is stored)", predictedGrid)
	}
}

// The plan already absorbing (its forecast was right) needs no correction.
func TestAPlanThatAlreadyAbsorbsTheSurplusIsNotTouched(t *testing.T) {
	c := NewSurplusCharger()
	r := Reading{SocPct: 40, PvKw: 12.0, LoadKw: 2.0, GridLimitKw: Unknown()}
	got := c.Apply(absorbBase(), 10.0, true, absorbLimits(), r)
	if got.Active || got.Kw != 10.0 {
		t.Fatalf("already-absorbing slot: %+v, want untouched", got)
	}
}

// THE safety invariant: bounded by the measured surplus, the correction can
// never create or raise a grid IMPORT - it only ever moves an export toward
// zero. So the §14a import bound and the peak quarter-hour target that ran
// before it stay valid, and the export side is only ever relieved.
func TestTheCorrectionNeverPushesTheSiteIntoImport(t *testing.T) {
	for _, tc := range []struct{ pv, load, kw float64 }{
		{23.9, 4.3, 0.0}, // the observed morning
		{12.0, 2.0, 1.0}, // a trickle charge under a real surplus
		{6.0, 5.9, 0.0},  // a hairline surplus
		{4.0, 9.0, 0.0},  // no surplus at all: nothing to absorb
		{30.0, 0.0, 0.0}, // a big surplus, small house
		{9.0, 3.0, 8.0},  // the plan already overshoots the surplus
	} {
		c := NewSurplusCharger()
		r := Reading{SocPct: 40, PvKw: tc.pv, LoadKw: tc.load, GridLimitKw: Unknown()}
		got := c.Apply(absorbBase(), tc.kw, true, absorbLimits(), r)
		if got.Kw < tc.kw-1e-9 {
			t.Fatalf("%+v: the correction LOWERED the setpoint to %v", tc, got.Kw)
		}
		before := tc.load + tc.kw - tc.pv
		after := tc.load + got.Kw - tc.pv
		// It only ever moves the predicted grid power TOWARD zero from the
		// EXPORT side, and never past it: an import the PLAN already intended is
		// left exactly as it is (there is no surplus to absorb then), and no
		// import can ever be created or raised.
		if after < before-1e-9 {
			t.Fatalf("%+v: predicted grid moved away from zero, %v -> %v", tc, before, after)
		}
		if after > math.Max(before, 0)+1e-6 {
			t.Fatalf("%+v: predicted grid = %v kW, want <= max(%v, 0) (never a new import)", tc, after, before)
		}
	}
}

// A commanded DISCHARGE is never raised into a charge: an economic guard does
// not flip a direction (and this is what keeps it disjoint from the follower).
func TestACommandedDischargeIsNeverFlippedIntoACharge(t *testing.T) {
	c := NewSurplusCharger()
	r := Reading{SocPct: 40, PvKw: 20.0, LoadKw: 2.0, GridLimitKw: Unknown()}
	got := c.Apply(absorbBase(), -5.0, true, absorbLimits(), r)
	if got.Active || got.Kw != -5.0 {
		t.Fatalf("discharge: %+v, want untouched", got)
	}
	if c.Engaged() {
		t.Fatal("a direction change must release the hysteresis, not carry it")
	}
}

// The authoritative chain still binds, because the raised value goes back
// through Clamp: a full battery absorbs nothing.
func TestTheSocCeilingStillBinds(t *testing.T) {
	c := NewSurplusCharger()
	r := Reading{SocPct: 95, PvKw: 23.9, LoadKw: 4.3, GridLimitKw: Unknown()}
	got := c.Apply(absorbBase(), 0.0, true, absorbLimits(), r)
	if got.Active || got.Kw != 0.0 {
		t.Fatalf("at the SoC ceiling: %+v, want no charge", got)
	}
}

func TestTheRatedChargeBandStillBinds(t *testing.T) {
	c := NewSurplusCharger()
	l := absorbLimits()
	l.MaxChargeKw = 8
	got := c.Apply(absorbBase(), 0.0, true, l, pilstingMorning())
	if !got.Active {
		t.Fatal("a 19.6 kW surplus against an 8 kW charger must still absorb 8 kW")
	}
	if math.Abs(got.Kw-8.0) > 1e-9 {
		t.Fatalf("absorbed = %v, want the rated 8.0", got.Kw)
	}
}

// The EEG solar-only clamp is LOOSER than the surplus (charge <= measured PV
// production vs charge <= pv - load), so it can never be violated - but the
// raised value passes through it all the same, which is what makes the argument
// structural instead of arithmetic.
func TestTheEegSolarOnlyClampIsNeverWidened(t *testing.T) {
	c := NewSurplusCharger()
	l := absorbLimits()
	l.SolarOnlyCharge = true
	got := c.Apply(absorbBase(), 0.0, true, l, pilstingMorning())
	if got.Kw > 23.9 {
		t.Fatalf("absorbed %v kW past the measured PV production 23.9", got.Kw)
	}
	if math.Abs(got.Kw-19.6) > 1e-3 {
		t.Fatalf("absorbed = %v, want the surplus 19.6 (the clamp is looser)", got.Kw)
	}
}

// The §14a envelope binds too - and it binds on the RAISED value, since Clamp
// runs on it. Import is not affected (predicted grid <= 0 by construction), so
// the case that matters is a tight envelope on the EXPORT side, which the
// correction only ever relieves.
func TestTheGridEnvelopeStillBindsOnTheRaisedValue(t *testing.T) {
	c := NewSurplusCharger()
	// A 5 kW §14a envelope with a 19.6 kW surplus: executing the plan's 0 kW
	// would export 19.6 kW (way past the envelope); absorbing lands at 0 grid.
	r := Reading{SocPct: 40, PvKw: 23.9, LoadKw: 4.3, GridLimitKw: 5}
	got := c.Apply(absorbBase(), 0.0, true, absorbLimits(), r)
	if !got.Active {
		t.Fatal("the correction must engage")
	}
	predicted := 4.3 + got.Kw - 23.9
	if predicted < -5-1e-6 || predicted > 5+1e-6 {
		t.Fatalf("predicted grid = %v kW, outside the +/-5 kW envelope", predicted)
	}
}

// Never regulate blind (the economic-guard convention, cf. PeakShave).
func TestUnknownMeasurementsLeaveTheAbsorptionInactive(t *testing.T) {
	for _, r := range []Reading{
		{SocPct: 7, PvKw: Unknown(), LoadKw: 4.3, GridLimitKw: Unknown()},
		{SocPct: 7, PvKw: 23.9, LoadKw: Unknown(), GridLimitKw: Unknown()},
	} {
		c := NewSurplusCharger()
		got := c.Apply(absorbBase(), 0.0, true, absorbLimits(), r)
		if got.Active || got.Kw != 0.0 {
			t.Fatalf("blind reading %+v: %+v, want untouched", r, got)
		}
		if !math.IsNaN(got.SurplusKw) {
			t.Fatalf("surplus = %v, want NaN when it cannot be measured", got.SurplusKw)
		}
	}
}

// Hysteresis: engaging is immediate (a surplus exported at a negative price is
// exactly what must not be given away), releasing needs the plan's OWN value to
// reach the surplus for a dwell window - so the correction cannot switch on and
// off with the ~10 s setpoint cadence.
func TestTheAbsorptionDoesNotFlapWithTheSetpointCadence(t *testing.T) {
	c := NewSurplusCharger()
	now := absorbBase()
	r := Reading{SocPct: 40, PvKw: 12.0, LoadKw: 2.0, GridLimitKw: Unknown()}

	if got := c.Apply(now, 0.0, true, absorbLimits(), r); !got.Active {
		t.Fatal("engage must be immediate")
	}
	// The plan now commands the full surplus: engaged, but no longer biting...
	now = now.Add(10 * time.Second)
	if got := c.Apply(now, 10.0, true, absorbLimits(), r); got.Active {
		t.Fatalf("a command that reaches the surplus must not be raised: %+v", got)
	}
	if !c.Engaged() {
		t.Fatal("the correction must stay engaged inside the release dwell")
	}
	// ...and only after the dwell does it let go.
	now = now.Add(AbsorbReleaseDwell + time.Second)
	if got := c.Apply(now, 10.0, true, absorbLimits(), r); got.Active {
		t.Fatalf("released: %+v, want untouched", got)
	}
	if c.Engaged() {
		t.Fatal("after the dwell the correction must be released")
	}
}

// The applied level follows a SHRINKING surplus immediately (never charge into
// an import) and a growing one only in steps (stable register writes).
func TestTheAppliedLevelFollowsAShrinkingSurplusAtOnce(t *testing.T) {
	c := NewSurplusCharger()
	now := absorbBase()
	l := absorbLimits()

	big := Reading{SocPct: 40, PvKw: 20.0, LoadKw: 2.0, GridLimitKw: Unknown()}
	first := c.Apply(now, 0.0, true, l, big)
	if math.Abs(first.Kw-18.0) > 1e-9 {
		t.Fatalf("first = %v, want 18.0", first.Kw)
	}
	// A cloud passes: the surplus collapses and the level must follow AT ONCE.
	now = now.Add(10 * time.Second)
	small := Reading{SocPct: 40, PvKw: 6.0, LoadKw: 2.0, GridLimitKw: Unknown()}
	got := c.Apply(now, 0.0, true, l, small)
	if math.Abs(got.Kw-4.0) > 1e-9 {
		t.Fatalf("after the cloud = %v, want 4.0 (never charge into an import)", got.Kw)
	}
	// A sub-step wiggle upward keeps the level (stable register writes).
	now = now.Add(10 * time.Second)
	wiggle := Reading{SocPct: 40, PvKw: 6.1, LoadKw: 2.0, GridLimitKw: Unknown()}
	got = c.Apply(now, 0.0, true, l, wiggle)
	if math.Abs(got.Kw-4.0) > 1e-9 {
		t.Fatalf("sub-step wiggle = %v, want the held 4.0", got.Kw)
	}
	// Real growth is followed.
	now = now.Add(10 * time.Second)
	grown := Reading{SocPct: 40, PvKw: 9.0, LoadKw: 2.0, GridLimitKw: Unknown()}
	got = c.Apply(now, 0.0, true, l, grown)
	if math.Abs(got.Kw-7.0) > 1e-9 {
		t.Fatalf("grown surplus = %v, want 7.0", got.Kw)
	}
}

// Composition with the peak guard: the correction lands at predicted import 0,
// which is inside ANY allowance the peak guard can compute (>= 0), so running
// the peak guard after it changes nothing.
func TestThePeakGuardCannotUndoTheAbsorption(t *testing.T) {
	c := NewSurplusCharger()
	r := pilstingMorning()
	got := c.Apply(absorbBase(), 0.0, true, absorbLimits(), r)
	for _, allowed := range []float64{0, 3, 25} {
		if after := PeakShave(got.Kw, allowed, absorbLimits(), r); after != got.Kw {
			t.Fatalf("peak guard with allowance %v changed %v to %v", allowed, got.Kw, after)
		}
	}
}

// Release() clears the state for the setpoint path's early exits (no reading, a
// bounded calibration write), so an engaged correction is never carried across.
func TestReleaseClearsTheEngagedAbsorptionState(t *testing.T) {
	c := NewSurplusCharger()
	if got := c.Apply(absorbBase(), 0.0, true, absorbLimits(), pilstingMorning()); !got.Active {
		t.Fatal("setup: the correction must engage")
	}
	c.Release()
	if c.Engaged() {
		t.Fatal("Release must clear the engaged state")
	}
}
