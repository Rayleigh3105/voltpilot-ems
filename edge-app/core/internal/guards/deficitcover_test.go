package guards

import (
	"math"
	"testing"
	"time"
)

func deficitGood() DeficitCoverInput {
	floor := 35.0
	// The live case: 92 % storage, PV 1.3 kW, house 2.7 kW, plan command 0.
	return DeficitCoverInput{
		Eligible: true, MeasurementsFresh: true, CommandKw: 0,
		SocPct: 92, EffectiveFloorPct: &floor, PvKw: 1.3, LoadKw: 2.7,
	}
}

func TestCoverDeficitAuthorizesTheReportedIdleSlotPurchase(t *testing.T) {
	d := CoverDeficit(deficitGood())
	if !d.Active || d.FloorPct == nil || *d.FloorPct != 35 {
		t.Fatalf("92%% storage buying 1.4 kW must be covered down to the reserve: %+v", d)
	}
}

func TestCoverDeficitEngagesAtEveryStateOfChargeAboveTheReserve(t *testing.T) {
	// The band the retired top-band relief could never reach.
	for _, soc := range []float64{35.01, 50, 70, 89.9, 92, 99} {
		in := deficitGood()
		in.SocPct = soc
		if !CoverDeficit(in).Active {
			t.Fatalf("SoC %.2f%% above the 35%% reserve must be covered", soc)
		}
	}
}

func TestCoverDeficitNeverSpendsTheReserveStack(t *testing.T) {
	for _, soc := range []float64{35, 34.9, 0} {
		in := deficitGood()
		in.SocPct = soc
		if CoverDeficit(in).Active {
			t.Fatalf("SoC %.2f%% is at/below the reserve and must refuse", soc)
		}
	}
}

func TestCoverDeficitRefusesEveryAmbiguousOrTradingCase(t *testing.T) {
	nan := math.NaN()
	cases := map[string]func(*DeficitCoverInput){
		"caller found a hold reason":  func(i *DeficitCoverInput) { i.Eligible = false },
		"measurements are stale":      func(i *DeficitCoverInput) { i.MeasurementsFresh = false },
		"planned charge":              func(i *DeficitCoverInput) { i.CommandKw = 5 },
		"planned sale past the house": func(i *DeficitCoverInput) { i.CommandKw = -27 },
		"purchase inside meter noise": func(i *DeficitCoverInput) { i.LoadKw = 1.32 },
		"real surplus, no deficit":    func(i *DeficitCoverInput) { i.PvKw = 11.4 },
		"no reserve stack known":      func(i *DeficitCoverInput) { i.EffectiveFloorPct = nil },
		"unknown SoC":                 func(i *DeficitCoverInput) { i.SocPct = nan },
		"unknown PV":                  func(i *DeficitCoverInput) { i.PvKw = nan },
		"unknown load":                func(i *DeficitCoverInput) { i.LoadKw = nan },
		"unknown command":             func(i *DeficitCoverInput) { i.CommandKw = nan },
		"unknown floor":               func(i *DeficitCoverInput) { f := nan; i.EffectiveFloorPct = &f },
	}
	for name, mutate := range cases {
		in := deficitGood()
		mutate(&in)
		if d := CoverDeficit(in); d.Active || d.FloorPct != nil {
			t.Fatalf("%s must refuse: %+v", name, d)
		}
	}
}

// The decision knows nothing about time (Captain decision A, 2026-10-13): the
// hold is the follower's, for every authority alike. A deficit seen for the
// first time arms the rule exactly like one that has stood for an hour - WHEN
// the cover may begin is decided where the discharge is made
// (TestTheHold... in loadfollow_hold_test.go).
func TestCoverDeficitIsAPlainDecisionWithoutAClock(t *testing.T) {
	// Herzogau 2026-10-10 17:03:15: the trim has taken the planned charge back
	// to 0, PV 4,69 kW, house 6,83 kW.
	floor := 5.0
	in := DeficitCoverInput{
		Eligible: true, MeasurementsFresh: true, CommandKw: 0,
		SocPct: 37, EffectiveFloorPct: &floor, PvKw: 4.69, LoadKw: 6.83,
	}
	if d := CoverDeficit(in); !d.Active || d.FloorPct == nil || *d.FloorPct != 5 {
		t.Fatalf("the rule is armed on the measured deficit, down to the reserve: %+v", d)
	}
	// A charge that still stands is a different intent - with or without a clock.
	in.CommandKw = 0.7
	if d := CoverDeficit(in); d.Active {
		t.Fatalf("a standing charge is never reinterpreted: %+v", d)
	}
}

var holdT0 = time.Date(2026, 10, 10, 15, 3, 15, 0, time.UTC)

func holdAt(s float64) time.Time { return holdT0.Add(time.Duration(s * float64(time.Second))) }

// The span runs from the tick that first judged the deficit to the newest
// MEASUREMENT that still shows it: one second short of the hold is not
// sustained, the full hold is.
func TestDeficitHoldCountsFromTheFirstJudgementToTheNewestMeasurement(t *testing.T) {
	h := NewDeficitHold()
	hold := DeficitCoverHold.Seconds()
	for s := 0.0; s < hold; s += 5 {
		if h.Observe(holdAt(s), holdAt(s), true, 4.69, 6.83) > 0 {
			t.Fatalf("%.0f s of deficit is not yet the hold time", s)
		}
	}
	if since, ok := h.Since(); !ok || !since.Equal(holdT0) {
		t.Fatalf("the count started with the first judgement: %v %v", since, ok)
	}
	if h.Observe(holdAt(hold), holdAt(hold), true, 4.69, 6.83) == 0 {
		t.Fatal("a measurement a full hold time after the first judgement proves a sustained deficit")
	}
}

// A consumer shorter than the hold can never release the rule, however the
// device reports: the count restarts with every measurement that shows no
// deficit, and a deficit that returns starts from nothing.
func TestDeficitHoldRestartsOnEveryMeasurementWithoutADeficit(t *testing.T) {
	h := NewDeficitHold()
	for s := 0.0; s <= 55; s += 5 {
		h.Observe(holdAt(s), holdAt(s), true, 4.69, 6.83)
	}
	if h.Observe(holdAt(60), holdAt(60), true, 4.68, 4.17) > 0 {
		t.Fatal("the consumer is off: nothing is sustained")
	}
	if _, ok := h.Since(); ok {
		t.Fatal("a measurement without a deficit ends the count")
	}
	// A deficit inside meter noise is none.
	if h.Observe(holdAt(65), holdAt(65), true, 4.68, 4.72) > 0 {
		t.Fatal("meter noise is not a deficit")
	}
	if _, ok := h.Since(); ok {
		t.Fatal("meter noise must not start the count")
	}
	for s := 70.0; s < 130; s += 5 {
		if h.Observe(holdAt(s), holdAt(s), true, 4.69, 6.83) > 0 {
			t.Fatalf("the second consumer started at 70 s; %.0f s is not sustained", s)
		}
	}
	if h.Observe(holdAt(130), holdAt(130), true, 4.69, 6.83) == 0 {
		t.Fatal("60 s after its own start the second deficit is sustained")
	}
}

// Ticks prove nothing, measurements do. A box that re-reads the measurement it
// already judged - a device that refreshes its registers rarely, or a control
// reading waiting for a settled pair - must not count the waiting as a deficit
// that lasted.
func TestDeficitHoldNeedsANewerMeasurementNotMoreTicks(t *testing.T) {
	h := NewDeficitHold()
	measured := holdAt(0)
	for s := 0.0; s <= 300; s += 10 {
		if h.Observe(holdAt(s), measured, true, 4.69, 6.83) > 0 {
			t.Fatalf("tick %.0f s re-read the measurement of 0 s - one measurement is never sustained", s)
		}
	}
	// A second measurement, but taken only 40 s after the first judgement.
	if h.Observe(holdAt(310), holdAt(40), true, 4.69, 6.83) > 0 {
		t.Fatal("the newest measurement is 40 s after the first judgement - not the hold time")
	}
	if h.Observe(holdAt(320), holdAt(60), true, 4.69, 6.83) == 0 {
		t.Fatal("a second measurement a full hold time after the first judgement is the proof")
	}
}

// The count starts with the TICK, never with the measurement's own (older)
// time: a pair the device measured before the consumer even started must not
// lend the deficit time it did not have.
func TestDeficitHoldNeverStartsBeforeTheBoxSawTheDeficit(t *testing.T) {
	h := NewDeficitHold()
	// First judged at 0 s on a pair timed 25 s earlier (an unchanged half
	// counts as re-measured one Messtakt ago).
	h.Observe(holdAt(0), holdAt(-25), true, 4.69, 6.83)
	if h.Observe(holdAt(40), holdAt(40), true, 4.69, 6.83) > 0 {
		t.Fatal("65 s between the two pair times, but the box has watched for 40 s only")
	}
	if h.Observe(holdAt(60), holdAt(60), true, 4.69, 6.83) == 0 {
		t.Fatal("60 s after the first judgement the deficit is sustained")
	}
}

// Never count blind: a stale reading, an unknown value or a missing
// measurement time is a gap in the evidence, and a gap is not a deficit that
// lasted. Release forgets everything.
func TestDeficitHoldEndsTheCountOnEveryGapInTheEvidence(t *testing.T) {
	nan := math.NaN()
	gaps := map[string]func(h *DeficitHold) bool{
		"stale reading":       func(h *DeficitHold) bool { return h.Observe(holdAt(60), holdAt(60), false, 4.69, 6.83) > 0 },
		"unknown PV":          func(h *DeficitHold) bool { return h.Observe(holdAt(60), holdAt(60), true, nan, 6.83) > 0 },
		"unknown load":        func(h *DeficitHold) bool { return h.Observe(holdAt(60), holdAt(60), true, 4.69, nan) > 0 },
		"no measurement time": func(h *DeficitHold) bool { return h.Observe(holdAt(60), time.Time{}, true, 4.69, 6.83) > 0 },
	}
	for name, gap := range gaps {
		h := NewDeficitHold()
		for s := 0.0; s <= 55; s += 5 {
			h.Observe(holdAt(s), holdAt(s), true, 4.69, 6.83)
		}
		if gap(h) {
			t.Fatalf("%s: nothing may be sustained across it", name)
		}
		if _, ok := h.Since(); ok {
			t.Fatalf("%s must end the count", name)
		}
		if h.Observe(holdAt(65), holdAt(65), true, 4.69, 6.83) > 0 {
			t.Fatalf("%s: the count starts again from nothing", name)
		}
	}
	h := NewDeficitHold()
	h.Observe(holdAt(0), holdAt(0), true, 4.69, 6.83)
	h.Release()
	if _, ok := h.Since(); ok {
		t.Fatal("Release forgets the standing deficit")
	}
}

// The rule keys on the RESIDUAL purchase - what the command as it stands would
// still buy - not on the raw house load. A command that already covers the house
// leaves nothing to arm, and meter noise is not a purchase.
func TestCoverDeficitKeepsTheNoiseFloorOnTheResidualPurchase(t *testing.T) {
	in := deficitGood()
	in.CommandKw = -1.38 // 0.02 kW left: noise
	if CoverDeficit(in).Active {
		t.Fatal("a 0.02 kW residual reading must not arm the rule")
	}
	in.CommandKw = -1.0 // 0.4 kW left to buy
	if !CoverDeficit(in).Active {
		t.Fatal("a 0.4 kW residual purchase is material and must be covered")
	}
}

// The threshold that decides whether a WRITE happens is the follower's, and it
// owns the hysteresis: an armed rule below FollowEngageMarginKw changes nothing.
func TestASmallDeficitArmsTheRuleButNeverMovesTheSetpoint(t *testing.T) {
	// House 1.45, PV 1.3 -> 0.15 kW, below the follower's 0.2 kW engage margin.
	r := Reading{SocPct: 92, PvKw: 1.3, LoadKw: 1.45, GridLimitKw: Unknown()}
	floor := 35.0
	in := deficitGood()
	in.LoadKw = r.LoadKw
	if !CoverDeficit(in).Active {
		t.Fatal("a real 0.15 kW purchase arms the rule")
	}
	got := NewLoadFollower().ApplyAuthorized(
		followBase(), 0, false, false, true, false, allStood, &floor, true, followLimits(), r)
	if got.Active || got.Kw != 0 {
		t.Fatalf("below the follower engage margin nothing is written: %+v", got)
	}
}
