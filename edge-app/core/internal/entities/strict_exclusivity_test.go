package entities

import (
	"math"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// MiSpeL MP-45 on the v2 write path: the v1 plan's strict posture rides in on
// the `extra` limits (agent EnvLimits) and composes into the entity's guard
// chain - strict if either side demands it, the smaller tolerance wins.
func TestClampCommandsComposesStrictExclusivity(t *testing.T) {
	e := batteryEntity(10, 8, nil) // D-8: solar-only (FK3)
	r := guards.Reading{SocPct: 50, PvKw: 3, LoadKw: 4, GridLimitKw: guards.Unknown()}
	wish := 20.0
	open := guards.Limits{MaxChargeKw: math.Inf(1), MaxDischargeKw: math.Inf(1),
		SocMinPct: math.Inf(-1), SocMaxPct: math.Inf(1)}

	// Without the strict posture: FK3 charges the measured PV while the
	// house imports - byte-for-byte as before.
	granted, _ := e.ClampCommandsTraced(Commands{SetpointKw: &wish}, &open, false, r)
	if granted.SetpointKw == nil || *granted.SetpointKw != 3 {
		t.Fatalf("FK3 without strict: want 3, got %+v", granted.SetpointKw)
	}

	strict := open
	strict.StrictExclusivity = true
	granted, stages := e.ClampCommandsTraced(Commands{SetpointKw: &wish}, &strict, false, r)
	if granted.SetpointKw == nil || *granted.SetpointKw != 0 {
		t.Fatalf("strict: no charge while importing, got %+v", granted.SetpointKw)
	}
	found := false
	for _, s := range stages {
		found = found || s.Stage == guards.StageStrictExclusivity
	}
	if !found {
		t.Fatalf("the strict stage must be named: %+v", stages)
	}

	// Tolerance 1 kW: pv 3 - load 3.5 + 1 = 0.5 kW.
	r.LoadKw = 3.5
	strict.StrictToleranceKw = 1
	granted, _ = e.ClampCommandsTraced(Commands{SetpointKw: &wish}, &strict, false, r)
	if granted.SetpointKw == nil || *granted.SetpointKw != 0.5 {
		t.Fatalf("strict with 1 kW tolerance: want 0.5, got %+v", granted.SetpointKw)
	}
}

func TestTightenLimitsStrictMostRestrictiveWins(t *testing.T) {
	off := guards.Limits{StrictToleranceKw: 0.1}
	on := func(tol float64) guards.Limits {
		return guards.Limits{StrictExclusivity: true, StrictToleranceKw: tol}
	}
	cases := []struct {
		a, b    guards.Limits
		strict  bool
		tolKw   float64
		comment string
	}{
		{off, off, false, 0, "neither side strict"},
		{on(2), off, true, 2, "a strict: its own tolerance"},
		{off, on(1), true, 1, "b strict: its own tolerance, not the off side's"},
		{on(2), on(0.5), true, 0.5, "both strict: the smaller tolerance"},
	}
	for _, c := range cases {
		got := tightenLimits(c.a, c.b)
		if got.StrictExclusivity != c.strict || got.StrictToleranceKw != c.tolKw {
			t.Fatalf("%s: got strict=%v tol=%v", c.comment, got.StrictExclusivity, got.StrictToleranceKw)
		}
	}
}
