package ocppcontrol

import (
	"math"
	"testing"
	"time"
)

func TestPerPhaseSharesReserveDisconnectedConnectors(t *testing.T) {
	p := Policy{Revision: 1, Authorization: Authorization{Mode: "free"}, PhaseLimitsA: []float64{32, 16, 16}, Electrical: []Electrical{
		{ChargePointID: "A", ConnectorID: 1, VoltageV: 230, Phases: []int{1}, MaxCurrentA: 32},
		{ChargePointID: "B", ConnectorID: 1, VoltageV: 230, Phases: []int{1}, MaxCurrentA: 32},
		{ChargePointID: "C", ConnectorID: 1, VoltageV: 230, Phases: []int{2, 3}, MaxCurrentA: 32},
	}}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	var amps [3]float64
	for _, e := range p.Electrical {
		kw := p.PhaseCaps(e.ChargePointID, e.ConnectorID, 100)
		current := kw * 1000 / (e.VoltageV * float64(len(e.Phases)))
		for _, phase := range e.Phases {
			amps[phase-1] += current
		}
	}
	for i, a := range amps {
		if a > p.PhaseLimitsA[i]+1e-9 {
			t.Fatalf("phase %d exceeds its budget: %v", i+1, amps)
		}
	}
	// No online-state input exists: an absent neighbour retains its reservation.
	if kw := p.PhaseCaps("A", 1, 100); math.Abs(kw-3.68) > 1e-9 {
		t.Fatalf("L1 share=%v", kw)
	}
}

func TestDeclaredVoltageAndPhaseCountBoundAmpereConversion(t *testing.T) {
	for _, phases := range [][]int{{1}, {1, 2, 3}} {
		e := Electrical{VoltageV: 253, Phases: phases, MaxCurrentA: 32}
		for _, kw := range []float64{0, 1.4, 7.4, 11, 100} {
			amps := e.AmpereCeiling(kw)
			if amps > 32 || amps*253*float64(len(phases))/1000 > kw+1e-9 {
				t.Fatalf("overshot: kw=%v amps=%v", kw, amps)
			}
		}
	}
}

func TestManualLimitExpiresLocallyAndBoundsTheWireDuration(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	p := Policy{Revision: 1, Authorization: Authorization{Mode: "free"}, Limits: []Limit{{"A", 1, 0, now, now.Add(time.Minute)}}}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if p.LimitKw("A", 1, now, 11) != 0 || p.LimitKw("B", 1, now, 11) != 11 || p.LimitKw("A", 1, now.Add(time.Minute), 11) != 11 {
		t.Fatal("target or expiry incorrect")
	}
	if d := p.ProfileDuration("A", 1, now.Add(55*time.Second), 120*time.Second); d != 5*time.Second {
		t.Fatalf("profile outlives request: %v", d)
	}
	p.Test = &TestRequest{"A", 1, 2, now}
	p.Limits = nil
	for _, v := range []struct {
		seconds int
		want    float64
	}{{0, 2}, {59, 2}, {60, 0}, {119, 0}, {120, 2}, {179, 2}, {180, 11}} {
		if got := p.LimitKw("A", 1, now.Add(time.Duration(v.seconds)*time.Second), 11); got != v.want {
			t.Fatalf("test second%d=%v", v.seconds, got)
		}
	}
}

func TestAccessPolicyIsIndependentFromEconomyAndSurvivesClone(t *testing.T) {
	tag := "tagref_1234567890abcdef12345678"
	p := Policy{Revision: 1, Authorization: Authorization{Mode: "allowlist", AllowedTags: []string{tag}}}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if !p.Clone().Allows(tag) || p.Allows("") || p.Allows("unknown") {
		t.Fatal("wrong access decision")
	}
	p.Authorization.AllowedTags = nil
	if p.Allows(tag) {
		t.Fatal("revoked card still allowed")
	}
	p.Authorization.Mode = "free"
	if !p.Allows("") {
		t.Fatal("free charging lost")
	}
}
