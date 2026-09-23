package cloud

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// AP-07 IP-18b Einschalten, Entscheid firstmate 23.09.2026 A: the shared point
// is built on the box (measurements.geteiltePunkte, measurement-planner.js) and
// its cloud follow-ups exist - point state, per-component status, revision push
// and the summing guard at Bilanz, formula and Kennzahl, shown in the portal.
// So the box reports measurement_config_per_component, and the shared vector
// says so too. Until PR 1128 this test held the opposite (the word dormant).
func TestGeteilterPunktIstGebautUndDieBoxMeldetDasWort(t *testing.T) {
	if !slices.Contains(BuiltSupports(), "measurement_config_per_component") {
		t.Fatal("measurement_config_per_component built but not advertised")
	}
	raw, err := os.ReadFile("../../../../docs/contracts/v2/edge-supports-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Capabilities []struct {
			Name       string
			Advertised bool
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	gefunden := false
	for _, c := range vectors.Capabilities {
		if c.Name == "measurement_config_per_component" {
			gefunden = true
			if !c.Advertised {
				t.Fatal("vector does not advertise measurement_config_per_component")
			}
		}
	}
	if !gefunden {
		t.Fatal("measurement_config_per_component missing from the vector")
	}
}
