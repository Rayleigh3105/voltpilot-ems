package guards

import (
	"math"
	"testing"
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
		followBase(), 0, false, false, true, false, &floor, true, followLimits(), r)
	if got.Active || got.Kw != 0 {
		t.Fatalf("below the follower engage margin nothing is written: %+v", got)
	}
}
