package lastmgmt

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/anteile"
)

// ungeregelt_hinter_abgang.draht of verbund-anteile-mqtt-vectors.json (NW-1,
// Go side of the Java producer VerbundAnteileUngeregeltVectorsTest): the box
// reads the optional field, and the co-controlling Box Verwaltung of R3 hands
// the charge park the share minus reserve minus that maximum blind (before its
// first sample) and share − (feeder − charging) with 50 kW building load
// behind a fresh feeder.
func TestNW1UngeregeltHinterAbgangDraht(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/verbund-anteile-mqtt-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Kennungen  map[string]string `json:"kennungen"`
		Ungeregelt struct {
			Draht []struct {
				Name            string       `json:"name"`
				Box             string       `json:"box"`
				Rolle           string       `json:"rolle"`
				UngeregeltBezug *json.Number `json:"ungeregelt_bezug"`
				ReserveBezug    *json.Number `json:"reserve_bezug"`
				Erwartet        struct {
					Gelesen         bool         `json:"gelesen"`
					UngeregeltBezug *json.Number `json:"ungeregelt_bezug"`
					BlindKw         *float64     `json:"ladebudget_blind_kw"`
					FrischKw        *float64     `json:"ladebudget_frisch_kw"`
				} `json:"erwartet"`
			} `json:"draht"`
		} `json:"ungeregelt_hinter_abgang"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	k := v.Kennungen
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	for _, c := range v.Ungeregelt.Draht {
		dok := map[string]any{"schema_version": "1.0", "tenant_id": k["tenant"], "site_id": k["site"], "device_id": c.Box,
			"epoche": 1, "revision": 1, "schritt": "ziel", "rolle": c.Rolle,
			"verteilbar": map[string]any{"einspeisung": json.Number("100.0"), "bezug": json.Number("77.0")},
			"anteile": map[string]any{
				"einspeisung": map[string]any{k["E-1"]: json.Number("40.0"), k["E-4"]: json.Number("60.0")},
				"bezug":       map[string]any{k["E-1"]: json.Number("0.0"), k["E-4"]: json.Number("77.0")}},
			"published_at": "2027-10-20T09:00:00Z"}
		if c.UngeregeltBezug != nil {
			dok["ungeregelt_hinter_abgang"] = map[string]any{"bezug": *c.UngeregeltBezug}
		}
		if c.ReserveBezug != nil {
			dok["reserve_verbraucher"] = map[string]any{"bezug": *c.ReserveBezug}
		}
		payload, _ := json.Marshal(dok)
		g, err := anteile.Lesen(anteile.Identitaet{Mandant: k["tenant"], Anlage: k["site"], Box: c.Box}, payload)
		if !c.Erwartet.Gelesen {
			if !errors.Is(err, anteile.ErrUnlesbar) {
				t.Fatalf("%s: %v, want unreadable", c.Name, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		h := anteile.Halten(g)
		want := json.Number("")
		if c.Erwartet.UngeregeltBezug != nil {
			want = *c.Erwartet.UngeregeltBezug
		}
		if h.UngeregeltBezugKw != want {
			t.Fatalf("%s: held maximum %q, want %q", c.Name, h.UngeregeltBezugKw, want)
		}
		// the same mapping as agent.bezugAnteil
		an := BezugAnteil{Fuehrt: h.Rolle == "fuehrt"}
		an.AnteilKw, _ = h.AnteilKw["bezug"].Float64()
		if r, err := h.ReserveBezugKw.Float64(); err == nil && r > 0 {
			an.ReserveKw = r
		}
		if u, err := h.UngeregeltBezugKw.Float64(); err == nil && u > 0 {
			an.UngeregeltKw = u
		}
		if b := NewBudgetTracker().BudgetAnteil(t0, verwaltungSet(), an); b.Kw != *c.Erwartet.BlindKw {
			t.Fatalf("%s: blind charging budget %.3f kW, want %.1f", c.Name, b.Kw, *c.Erwartet.BlindKw)
		}
		frisch := NewBudgetTracker()
		abgang(frisch, t0, 0) // 50 kW building behind the feeder, the park stands
		if b := frisch.BudgetAnteil(t0.Add(5*time.Second), verwaltungSet(), an); b.Kw != *c.Erwartet.FrischKw {
			t.Fatalf("%s: fresh charging budget %.3f kW, want %.1f", c.Name, b.Kw, *c.Erwartet.FrischKw)
		}
	}
	if len(v.Ungeregelt.Draht) != 5 {
		t.Fatalf("ungeregelt_hinter_abgang.draht: %d Faelle - Vektor-Datei gewachsen, Zwilling pruefen", len(v.Ungeregelt.Draht))
	}
}
