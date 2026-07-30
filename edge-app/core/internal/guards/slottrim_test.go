package guards

// The price-aware in-slot trim (2026-07-30): each test states a property the
// limitation must have - the cheap slot stays untouched, the expensive one is
// held at the MEASURED surplus, the compliance bounds survive, and the state
// cannot flap with the ~10 s setpoint cadence.

import (
	"math"
	"testing"
	"time"
)

func trimBase() time.Time { return time.Date(2026, 7, 30, 14, 44, 0, 0, time.UTC) }

// pilsting is the live reading behind the whole feature: PV 15.3 kW, house
// 7.6 kW -> 7.7 kW surplus, plan setpoint 10.8 kW (so 3.1 kW would come from
// the grid).
func pilsting() Reading {
	return Reading{SocPct: 92, PvKw: 15.3, LoadKw: 7.6, GridLimitKw: Unknown()}
}

func TestCheapSlotLeavesThePlanSetpointUntouched(t *testing.T) {
	tr := NewPriceTrimmer()
	got := tr.Apply(trimBase(), 10.8, false, pilsting())
	if got.Kw != 10.8 || got.Active {
		t.Fatalf("cheap slot: %+v, want the plan setpoint 10.8 untouched", got)
	}
	if tr.Engaged() {
		t.Fatal("a cheap slot must never engage the trim")
	}
}

func TestExpensiveSlotHoldsTheChargeAtTheMeasuredSurplus(t *testing.T) {
	tr := NewPriceTrimmer()
	got := tr.Apply(trimBase(), 10.8, true, pilsting())
	if !got.Active {
		t.Fatal("expensive slot with a 3.1 kW grid draw must engage the trim")
	}
	if math.Abs(got.Kw-7.7) > 1e-9 {
		t.Fatalf("trimmed setpoint = %v, want the surplus 7.7", got.Kw)
	}
	if got.CommandedKw != 10.8 {
		t.Fatalf("commanded = %v, want the pre-trim 10.8 (the card names it)", got.CommandedKw)
	}
	// The point of the whole feature: the battery causes NO grid import.
	predictedGrid := 7.6 + got.Kw - 15.3
	if predictedGrid > 1e-9 {
		t.Fatalf("predicted grid = %v kW, want <= 0 (no import for the battery)", predictedGrid)
	}
}

func TestNoSurplusAtAllStopsTheChargeInsteadOfBuying(t *testing.T) {
	tr := NewPriceTrimmer()
	r := Reading{SocPct: 50, PvKw: 1.0, LoadKw: 6.0, GridLimitKw: Unknown()}
	got := tr.Apply(trimBase(), 8.0, true, r)
	if !got.Active || got.Kw != 0 {
		t.Fatalf("no surplus: %+v, want charge 0 (never buy for the battery)", got)
	}
}

func TestACommandThatAlreadyFitsTheSurplusIsNotTouched(t *testing.T) {
	tr := NewPriceTrimmer()
	r := Reading{SocPct: 50, PvKw: 12.0, LoadKw: 2.0, GridLimitKw: Unknown()}
	got := tr.Apply(trimBase(), 5.0, true, r) // surplus 10 >> 5
	if got.Active || got.Kw != 5.0 {
		t.Fatalf("%+v, want untouched - there is nothing to limit", got)
	}
}

func TestDischargeAndIdleAreNeverAffected(t *testing.T) {
	tr := NewPriceTrimmer()
	r := Reading{SocPct: 50, PvKw: 0, LoadKw: 9.0, GridLimitKw: Unknown()}
	for _, kw := range []float64{-9.0, 0.0} {
		got := tr.Apply(trimBase(), kw, true, r)
		if got.Active || got.Kw != kw {
			t.Fatalf("kw=%v: %+v, want untouched (the trim caps CHARGE only)", kw, got)
		}
	}
}

func TestUnknownMeasurementsNeverRegulateBlind(t *testing.T) {
	tr := NewPriceTrimmer()
	for _, r := range []Reading{
		{SocPct: 50, PvKw: Unknown(), LoadKw: 7.6, GridLimitKw: Unknown()},
		{SocPct: 50, PvKw: 15.3, LoadKw: Unknown(), GridLimitKw: Unknown()},
	} {
		got := tr.Apply(trimBase(), 10.8, true, r)
		if got.Active || got.Kw != 10.8 {
			t.Fatalf("%+v, want untouched (economic guards never regulate blind)", got)
		}
		if !math.IsNaN(got.SurplusKw) {
			t.Fatalf("surplus = %v, want NaN when a measurement is missing", got.SurplusKw)
		}
	}
}

// FK3 stays the regulatory upper bound: the economic trim is TIGHTER than
// "charge <= measured PV production", so it can never widen the EEG clamp.
func TestTheTrimIsTighterThanTheFk3SolarOnlyClamp(t *testing.T) {
	l := Limits{MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 5, SocMaxPct: 95, SolarOnlyCharge: true}
	r := pilsting()
	clamped := Clamp(10.8, l, r) // FK3 permits up to the full 15.3 kW production
	if clamped != 10.8 {
		t.Fatalf("FK3 clamp = %v, want the command 10.8 (production 15.3 allows it)", clamped)
	}
	tr := NewPriceTrimmer()
	got := tr.Apply(trimBase(), clamped, true, r)
	if got.Kw > clamped {
		t.Fatalf("trimmed %v > FK3-clamped %v - the trim must only ever LOWER", got.Kw, clamped)
	}
	if got.Kw > math.Max(r.PvKw, 0) {
		t.Fatalf("trimmed %v exceeds the measured production %v", got.Kw, r.PvKw)
	}
}

// A §14a EXPORT bound can force Clamp to RAISE charge. The trim must not undo
// that - and by construction it cannot: a command that satisfies an export cap
// is already below the surplus, so the trim does not bite.
func TestTheTrimCannotReViolateThe14aExportBound(t *testing.T) {
	l := Limits{MaxChargeKw: 30, MaxDischargeKw: 30, SocMinPct: 5, SocMaxPct: 95}
	// PV 20, house 2 -> 18 kW would be exported; a 10 kW envelope forces the
	// battery to absorb 8 kW.
	r := Reading{SocPct: 50, PvKw: 20, LoadKw: 2, GridLimitKw: 10}
	clamped := Clamp(0, l, r)
	if math.Abs(clamped-8) > 1e-9 {
		t.Fatalf("§14a export correction = %v, want a forced 8 kW charge", clamped)
	}
	tr := NewPriceTrimmer()
	got := tr.Apply(trimBase(), clamped, true, r)
	if got.Active || got.Kw != clamped {
		t.Fatalf("%+v, want the §14a-forced charge untouched", got)
	}
	predicted := r.LoadKw + got.Kw - r.PvKw
	if predicted < -r.GridLimitKw-1e-9 {
		t.Fatalf("predicted grid %v breaches the -%v envelope", predicted, r.GridLimitKw)
	}
}

// --- anti-flap ---------------------------------------------------------------

func TestTheLimitationDoesNotFlapWithTheSetpointCadence(t *testing.T) {
	tr := NewPriceTrimmer()
	now := trimBase()
	// A cloud drops the surplus: the trim engages at once (that is the point).
	if got := tr.Apply(now, 10.8, true, pilsting()); !got.Active {
		t.Fatal("engage must be immediate")
	}
	// The sun comes back for a couple of 10 s ticks - the plan setpoint fits
	// again, but the limitation must NOT be dropped yet.
	sunny := Reading{SocPct: 92, PvKw: 20.0, LoadKw: 7.6, GridLimitKw: Unknown()}
	for i := 1; i <= 3; i++ {
		now = now.Add(10 * time.Second)
		tr.Apply(now, 10.8, true, sunny)
		if !tr.Engaged() {
			t.Fatalf("tick %d: released after %v - must hold for the dwell", i, 10*time.Duration(i)*time.Second)
		}
	}
	// ... and it is not BITING while it fits, so nothing is wrongly limited.
	if got := tr.Apply(now, 10.8, true, sunny); got.Active || got.Kw != 10.8 {
		t.Fatalf("%+v, want the full setpoint while it fits inside the surplus", got)
	}
	// After the dwell the limitation lets go.
	now = now.Add(TrimReleaseDwell)
	tr.Apply(now, 10.8, true, sunny)
	if tr.Engaged() {
		t.Fatal("must release once the setpoint has comfortably fit for the dwell")
	}
}

func TestASurplusWiggleDoesNotMoveTheWrittenSetpoint(t *testing.T) {
	tr := NewPriceTrimmer()
	now := trimBase()
	first := tr.Apply(now, 10.8, true, pilsting())
	if !first.Active {
		t.Fatal("expected the trim to engage")
	}
	// Surplus wiggles UP by 0.1 kW (below TrimStepKw): the written value stays.
	now = now.Add(10 * time.Second)
	wiggle := Reading{SocPct: 92, PvKw: 15.4, LoadKw: 7.6, GridLimitKw: Unknown()}
	second := tr.Apply(now, 10.8, true, wiggle)
	if second.Kw != first.Kw {
		t.Fatalf("cap moved %v -> %v on a 0.1 kW wiggle - register writes must stay stable", first.Kw, second.Kw)
	}
	// A REAL growth (>= step) is followed.
	now = now.Add(10 * time.Second)
	grown := Reading{SocPct: 92, PvKw: 16.0, LoadKw: 7.6, GridLimitKw: Unknown()}
	third := tr.Apply(now, 10.8, true, grown)
	if math.Abs(third.Kw-8.4) > 1e-9 {
		t.Fatalf("cap = %v, want the grown surplus 8.4", third.Kw)
	}
	// A SHRINKING surplus is followed IMMEDIATELY - grid import is never allowed
	// to slip through a step deadband.
	now = now.Add(10 * time.Second)
	shrunk := Reading{SocPct: 92, PvKw: 15.35, LoadKw: 7.6, GridLimitKw: Unknown()}
	fourth := tr.Apply(now, 10.8, true, shrunk)
	if math.Abs(fourth.Kw-7.75) > 1e-9 {
		t.Fatalf("cap = %v, want the shrunk surplus 7.75 (followed at once)", fourth.Kw)
	}
}

func TestASlotFlippingToCheapReleasesTheLimitationAtOnce(t *testing.T) {
	tr := NewPriceTrimmer()
	now := trimBase()
	tr.Apply(now, 10.8, true, pilsting())
	if !tr.Engaged() {
		t.Fatal("expected the trim to engage")
	}
	// The next quarter hour is cheap: the plan's economics govern again
	// immediately (a slot boundary is a real change, not flap noise).
	got := tr.Apply(now.Add(10*time.Second), 10.8, false, pilsting())
	if got.Active || got.Kw != 10.8 || tr.Engaged() {
		t.Fatalf("%+v engaged=%v, want an immediate release", got, tr.Engaged())
	}
}

func TestReleaseClearsTheStateForTheSetpointPathsEarlyExits(t *testing.T) {
	tr := NewPriceTrimmer()
	tr.Apply(trimBase(), 10.8, true, pilsting())
	tr.Release()
	if tr.Engaged() {
		t.Fatal("Release must drop the engaged state")
	}
}
