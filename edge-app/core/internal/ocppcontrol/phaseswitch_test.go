package ocppcontrol

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"testing"
)

func switchingPolicy(maxA float64, limits []float64) Policy {
	return Policy{Revision: 1, Authorization: Authorization{Mode: "free"}, PhaseLimitsA: limits, Electrical: []Electrical{
		{ChargePointID: "goe", ConnectorID: 1, VoltageV: 230, Phases: []int{1, 2, 3}, MaxCurrentA: maxA, PhaseSwitching: true},
	}}
}

func TestPhaseSwitchingNeedsThreeWiredPhases(t *testing.T) {
	p := switchingPolicy(16, []float64{16, 16, 16})
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	p.Electrical[0].Phases = []int{1}
	if p.Validate() == nil {
		t.Fatal("a one-phase connector cannot switch from three phases")
	}
}

func TestSwitchRangesFollowTheSamePerPhaseCeiling(t *testing.T) {
	r, ok := switchingPolicy(16, []float64{16, 16, 16}).SwitchRanges("goe", 1)
	if !ok || len(r) != 2 {
		t.Fatalf("ranges=%v ok=%v", r, ok)
	}
	want := []PhaseRange{{1, 1.38, 3.68}, {3, 4.14, 11.04}}
	for i := range want {
		if r[i] != want[i] {
			t.Fatalf("range %d = %+v, want %+v", i, r[i], want[i])
		}
	}
	// A circuit share below the connector maximum binds BOTH bands: one-phase
	// charging uses one of the same phases.
	r, _ = switchingPolicy(16, []float64{10, 16, 16}).SwitchRanges("goe", 1)
	if r[0].MaxKw != 2.3 || r[1].MaxKw != 6.9 {
		t.Fatalf("share not applied: %+v", r)
	}
	if _, ok := switchingPolicy(16, []float64{5, 16, 16}).SwitchRanges("goe", 1); ok {
		t.Fatal("a ceiling below 6 A has no charging band")
	}
	plain := switchingPolicy(16, []float64{16, 16, 16})
	plain.Electrical[0].PhaseSwitching = false
	if _, ok := plain.SwitchRanges("goe", 1); ok {
		t.Fatal("switching is opt-in")
	}
}

func TestSwitchAmpereNeverOvershootsAndKeepsTheBandMinimum(t *testing.T) {
	p := switchingPolicy(16, []float64{16, 16, 16})
	for _, phases := range []int{1, 3} {
		for _, kw := range []float64{0, 1.38, 2, 3.68, 4.14, 7.5, 11.04, 50} {
			a, ok := p.SwitchAmpere("goe", 1, kw, phases)
			if !ok || a > 16 || a*230*float64(phases)/1000 > kw+1e-6 {
				t.Fatalf("phases=%d kw=%v -> %v A", phases, kw, a)
			}
		}
	}
	if a, _ := p.SwitchAmpere("goe", 1, 1.38, 1); a != 6 {
		t.Fatalf("1.38 kW on one phase = %v A, want 6", a)
	}
	if a, _ := p.SwitchAmpere("goe", 1, 4.14, 3); a != 6 {
		t.Fatalf("4.14 kW on three phases = %v A, want 6", a)
	}
	if _, ok := p.SwitchAmpere("goe", 1, 2, 2); ok {
		t.Fatal("only one or three phases")
	}
}

// The switch must not change the safety key: toggling it neither rewrites a
// safety profile nor moves a reserved share, and every existing box keeps the
// key it already commissioned with.
func TestPhaseSwitchingLeavesThePhaseKeyUnchanged(t *testing.T) {
	on := switchingPolicy(16, []float64{16, 16, 16})
	off := switchingPolicy(16, []float64{16, 16, 16})
	off.Electrical[0].PhaseSwitching = false
	if on.PhaseKey() != off.PhaseKey() {
		t.Fatal("phase switching changed the phase key")
	}
	type legacyElectrical struct {
		ChargePointID string  `json:"charge_point_id"`
		ConnectorID   int     `json:"connector_id"`
		VoltageV      float64 `json:"voltage_v"`
		Phases        []int   `json:"phases"`
		MaxCurrentA   float64 `json:"max_current_a"`
	}
	for _, p := range []Policy{off, {Revision: 1}, {Revision: 1, Electrical: []Electrical{}}} {
		var legacy []legacyElectrical
		if p.Electrical != nil {
			legacy = []legacyElectrical{}
		}
		for _, e := range p.Electrical {
			legacy = append(legacy, legacyElectrical{e.ChargePointID, e.ConnectorID, e.VoltageV, e.Phases, e.MaxCurrentA})
		}
		raw, _ := json.Marshal(struct {
			Electrical []legacyElectrical
			Limits     []float64
		}{legacy, p.PhaseLimitsA})
		if want := fmt.Sprintf("%x", sha256.Sum256(raw)); p.PhaseKey() != want {
			t.Fatalf("phase key moved for %+v", p)
		}
	}
	if kw := on.PhaseCaps("goe", 1, 100); math.Abs(kw-11.04) > 1e-9 {
		t.Fatalf("three-phase cap = %v", kw)
	}
}
