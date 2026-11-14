package entities

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

func f(v float64) *float64 { return &v }

func readingNone() guards.Reading {
	return guards.Reading{SocPct: guards.Unknown(), PvKw: guards.Unknown(), LoadKw: guards.Unknown(),
		GridLimitKw: guards.Unknown()}
}

func TestRoundSetpointC(t *testing.T) {
	half := 0.5
	cases := []struct {
		v, min, max float64
		step        *float64
		want        float64
	}{
		{21.26, 16, 30, &half, 21.5},
		{21.24, 16, 30, &half, 21},
		{21.25, 16, 30, &half, 21.5}, // halves up
		{9, 16, 30, &half, 16},
		{31, 16, 30, &half, 30},
		{3.7, 3, 8, &half, 3.5},
		{22.37, 16, 30, nil, 22.37},
	}
	for _, c := range cases {
		if got := RoundSetpointC(c.v, c.min, c.max, c.step); got != c.want {
			t.Errorf("RoundSetpointC(%v, %v, %v): %v, want %v", c.v, c.min, c.max, got, c.want)
		}
	}
}

func TestSetpointCClampAndRest(t *testing.T) {
	e := Entity{ID: "k", Type: "modbus-device",
		Capabilities: Capabilities{Actuate: []ActuateCap{
			{Command: CmdSetpointC, Min: f(16), Max: f(30), Step: f(0.5), Rest: json.RawMessage("24")},
			{Command: CmdMode, Modes: []string{"cool"}, Rest: json.RawMessage(`"cool"`)},
			{Command: CmdOnOff, Rest: json.RawMessage("false")},
		}},
		Guards: Guards{Limits: GuardLimits{MinChangeIntervalSeconds: f(120)}, Failsafe: Failsafe{Behavior: "rest"}},
	}
	sp := 40.0
	out := e.ClampCommands(Commands{SetpointC: &sp, Mode: "heat"}, readingNone())
	if out.SetpointC == nil || *out.SetpointC != 30 || out.Mode != "" {
		t.Fatalf("clamp: %+v", out)
	}
	rest := e.RestCommands()
	if *rest.SetpointC != 24 || rest.Mode != "cool" || rest.OnOff == nil || *rest.OnOff {
		t.Fatalf("rest: %+v", rest)
	}
	if e.ChangeInterval() != 2*time.Minute {
		t.Fatalf("interval: %v", e.ChangeInterval())
	}
	// Without both ends of the band nothing is commanded (fail-closed).
	e.Capabilities.Actuate[0].Max = nil
	if out := e.ClampCommands(Commands{SetpointC: &sp}, readingNone()); out.SetpointC != nil {
		t.Fatalf("open band commanded: %+v", out)
	}
}
