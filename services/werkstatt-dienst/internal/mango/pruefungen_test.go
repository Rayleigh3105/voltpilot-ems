package mango_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
)

// Dritter Leser des Vektors neben WerkstattPruefungen.java und werkstatt.ts:
// Die Übergabe nennt für jede Prüfung der Werkstatt-Regel ihren Beleg.
func TestPruefungenWieImVektor(t *testing.T) {
	b, err := os.ReadFile("../../../../docs/contracts/werkstatt-pruefungen.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Pruefungen []struct {
			ID string `json:"id"`
		} `json:"pruefungen"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, p := range v.Pruefungen {
		ids = append(ids, p.ID)
	}
	if strings.Join(ids, " ") != strings.Join(mango.Pruefungen, " ") {
		t.Fatalf("Vektor %v, Dienst %v", ids, mango.Pruefungen)
	}
}
