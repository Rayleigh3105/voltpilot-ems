package cloud

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// AP-07 IP-18b Box-Schritt, Entscheid firstmate 23.09.2026: the shared point is
// built on the box (measurements.geteiltePunkte, measurement-planner.js), but
// the box must NOT report measurement_config_per_component yet. Without the
// word the cloud keeps sending the merged plan, so the box step stays dormant
// even after the box release until point state, per-component status in the
// cloud, revision push and the summing guard exist. Switching it on is its own
// package - and changes this test on purpose.
func TestGeteilterPunktIstGebautAberDieBoxMeldetDasWortNicht(t *testing.T) {
	if slices.Contains(BuiltSupports(), "measurement_config_per_component") {
		t.Fatal("measurement_config_per_component advertised before its follow-ups exist")
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
			if c.Advertised {
				t.Fatal("vector advertises measurement_config_per_component")
			}
		}
	}
	if !gefunden {
		t.Fatal("measurement_config_per_component missing from the vector")
	}
}
