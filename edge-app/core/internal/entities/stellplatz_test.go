package entities

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

func fp(v float64) *float64 { return &v }

// An Anlagensteuerung with released Stellplätze (koppelbild.md §15): each
// command stays inside its Stellplatz band and nothing else guards it; its
// category stays measure-only, so no consumer, producer or storage path ever
// takes it.
func TestStellplaetzeDerAnlagensteuerung(t *testing.T) {
	e := Entity{ID: "as", Type: TypeAnlagensteuerung, Capabilities: Capabilities{Actuate: []ActuateCap{
		{Command: CmdLimitKw, Min: fp(0), Max: fp(265), Platz: 1},
		{Command: CmdSetpointKw, Min: fp(-50), Max: fp(50), Platz: 2},
		{Command: CmdOnOff, Platz: 3},
		{Command: CmdMode, Modes: []string{"1", "2", "3"}, Platz: 4},
		{Command: CmdSetpointC, Min: fp(40), Max: fp(80), Step: fp(0.1), Platz: 5},
	}}, Guards: Guards{Failsafe: Failsafe{Behavior: "release"}}}
	if e.Category() != CategoryMeasureOnly {
		t.Fatalf("Kategorie %s", e.Category())
	}
	on := true
	got, stages := e.ClampCommandsTraced(Commands{LimitKw: fp(300), SetpointKw: fp(-80), OnOff: &on, Mode: "2",
		SetpointC: fp(90), LimitPct: fp(40)}, nil, false, guards.Reading{})
	if *got.LimitKw != 265 || *got.SetpointKw != -50 || !*got.OnOff || got.Mode != "2" || *got.SetpointC != 80 {
		t.Fatalf("%+v", got)
	}
	if got.LimitPct != nil {
		t.Fatal("limit_pct ohne Stellplatz durchgelassen")
	}
	n := 0
	for _, s := range stages {
		if s.Stage == guards.StageStellplatzBand {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("Stufen %+v", stages)
	}
	if got, _ := e.ClampCommandsTraced(Commands{Mode: "7"}, nil, false, guards.Reading{}); got.Mode != "" {
		t.Fatal("Betriebsart außerhalb des Angebots")
	}
	ohne := Entity{ID: "as", Type: TypeAnlagensteuerung, Capabilities: Capabilities{Actuate: []ActuateCap{
		{Command: CmdLimitKw, Platz: 1}}}}
	if got, _ := ohne.ClampCommandsTraced(Commands{LimitKw: fp(10)}, nil, false, guards.Reading{}); got.LimitKw != nil {
		t.Fatal("ohne Band ein Befehl")
	}
}
