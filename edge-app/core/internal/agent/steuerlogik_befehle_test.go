package agent

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
)

func TestLogikBefehle(t *testing.T) {
	on := true
	c := logikBefehle(logik.Ausgang{HatEin: true, Ein: &on,
		HatSollwert: true, Sollwert: &logik.Wert{Art: logik.WertZahl, V: 23.5, D: logik.GroesseTemp},
		HatBetriebsart: true, Betriebsart: "cool"})
	if c.OnOff == nil || !*c.OnOff || c.SetpointC == nil || *c.SetpointC != 23.5 || c.Mode != "cool" || c.SetpointKw != nil {
		t.Fatalf("Klima: %+v", c)
	}
	c = logikBefehle(logik.Ausgang{HatSollwert: true, Sollwert: &logik.Wert{Art: logik.WertZahl, V: 2, D: logik.GroesseKW}})
	if c.SetpointKw == nil || *c.SetpointKw != 2 || c.SetpointC != nil {
		t.Fatalf("kW: %+v", c)
	}
	// No wish (unknown) is no command: the rest value applies.
	if c := logikBefehle(logik.Ausgang{HatEin: true, HatSollwert: true, HatBetriebsart: true}); !c.Empty() {
		t.Fatalf("no wish: %+v", c)
	}
}
