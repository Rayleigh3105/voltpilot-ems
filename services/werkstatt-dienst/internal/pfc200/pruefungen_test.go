package pfc200_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/pfc200"
)

// Die Prüfungen des PFC200 sind die des Vektors (geraete.pfc200), den auch API
// und Portal lesen; eine eigene Liste hier wäre eine zweite Wahrheit.
func TestPruefungenWieImVektor(t *testing.T) {
	t.Parallel()
	b, err := os.ReadFile("../../../../docs/contracts/werkstatt-pruefungen.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Geraete map[string]struct {
			Pruefungen []struct {
				ID string `json:"id"`
			} `json:"pruefungen"`
		} `json:"geraete"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, p := range v.Geraete["pfc200"].Pruefungen {
		ids = append(ids, p.ID)
	}
	if len(ids) == 0 || !reflect.DeepEqual(ids, pfc200.Pruefungen) {
		t.Fatalf("Vektor %v, Dienst %v", ids, pfc200.Pruefungen)
	}
}
