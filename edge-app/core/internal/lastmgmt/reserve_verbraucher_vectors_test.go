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

// reserve_verbraucher.draht of verbund-anteile-mqtt-vectors.json (NW-1, Go
// side of the Java producer VerbundAnteileReserveVectorsTest): the box reads
// the optional field and hands the charge park max(0, share − reserve) where
// the share binds - here the co-controlling Box Verwaltung of R3 before its
// first sample.
func TestNW1ReserveVerbraucherDraht(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/verbund-anteile-mqtt-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Kennungen map[string]string `json:"kennungen"`
		Reserve   struct {
			Draht []struct {
				Name         string       `json:"name"`
				Box          string       `json:"box"`
				Rolle        string       `json:"rolle"`
				ReserveBezug *json.Number `json:"reserve_bezug"`
				Erwartet     struct {
					Gelesen      bool         `json:"gelesen"`
					ReserveBezug *json.Number `json:"reserve_bezug"`
					LadebudgetKw *float64     `json:"ladebudget_kw"`
				} `json:"erwartet"`
			} `json:"draht"`
		} `json:"reserve_verbraucher"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	k := v.Kennungen
	for _, c := range v.Reserve.Draht {
		dok := map[string]any{"schema_version": "1.0", "tenant_id": k["tenant"], "site_id": k["site"], "device_id": c.Box,
			"epoche": 1, "revision": 1, "schritt": "ziel", "rolle": c.Rolle,
			"verteilbar": map[string]any{"einspeisung": json.Number("100.0"), "bezug": json.Number("77.0")},
			"anteile": map[string]any{
				"einspeisung": map[string]any{k["E-1"]: json.Number("40.0"), k["E-4"]: json.Number("60.0")},
				"bezug":       map[string]any{k["E-1"]: json.Number("0.0"), k["E-4"]: json.Number("77.0")}},
			"published_at": "2027-10-20T09:00:00Z"}
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
		if c.Erwartet.ReserveBezug != nil {
			want = *c.Erwartet.ReserveBezug
		}
		if h.ReserveBezugKw != want {
			t.Fatalf("%s: held reserve %q, want %q", c.Name, h.ReserveBezugKw, want)
		}
		an := BezugAnteil{Fuehrt: h.Rolle == "fuehrt"}
		an.AnteilKw, _ = h.AnteilKw["bezug"].Float64()
		if r, err := h.ReserveBezugKw.Float64(); err == nil {
			an.ReserveKw = r
		}
		b := NewBudgetTracker().BudgetAnteil(time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC), verwaltungSet(), an)
		if b.Kw != *c.Erwartet.LadebudgetKw {
			t.Fatalf("%s: charging budget %.3f kW, want %.1f", c.Name, b.Kw, *c.Erwartet.LadebudgetKw)
		}
	}
	if len(v.Reserve.Draht) != 5 {
		t.Fatalf("reserve_verbraucher.draht: %d Faelle - Vektor-Datei gewachsen, Zwilling pruefen", len(v.Reserve.Draht))
	}
}
