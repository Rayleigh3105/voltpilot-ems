package referenz

import (
	"encoding/json"
	"os"
	"testing"
)

// Der Vektor gilt für alle Leser (docs/contracts/edge-ref-vectors.json).
func TestVektor(t *testing.T) {
	b, err := os.ReadFile("../../../../docs/contracts/edge-ref-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Alphabet      string `json:"alphabet"`
		Praefix       string `json:"praefix"`
		KoerperLaenge int    `json:"koerper_laenge"`
		Gueltig       []string
		Ungueltig     []struct {
			Kennung string `json:"kennung"`
			Grund   string `json:"grund"`
		}
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if v.Alphabet != Alphabet || v.Praefix != Praefix || v.KoerperLaenge != KoerperLaenge {
		t.Fatalf("Vektor und Zwilling weichen ab: %+v", v)
	}
	if len(v.Gueltig) == 0 || len(v.Ungueltig) == 0 {
		t.Fatal("Vektor leer")
	}
	for _, r := range v.Gueltig {
		if !Gueltig(r) {
			t.Errorf("%s: gültig im Vektor, hier nicht", r)
		}
	}
	for _, u := range v.Ungueltig {
		if Gueltig(u.Kennung) {
			t.Errorf("%s (%s): ungültig im Vektor, hier gültig", u.Kennung, u.Grund)
		}
	}
}
