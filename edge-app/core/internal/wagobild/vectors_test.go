package wagobild

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func repo(t *testing.T, teile ...string) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(append([]string{filepath.Dir(here), "..", "..", "..", ".."}, teile...)...)
}

func ladeJSON(t *testing.T, pfad string, v any) {
	t.Helper()
	raw, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("%s: %v", pfad, err)
	}
}

func alsJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

func gleich(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && (x == y || math.IsNaN(x) && math.IsNaN(y))
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if w, ok := y[k]; !ok || !gleich(v, w) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !gleich(x[i], y[i]) {
				return false
			}
		}
		return true
	}
	return reflect.DeepEqual(a, b)
}

// teilGleich: every key the expectation names has the same value (the
// contract file names the fields the contract reads, not every field).
func teilGleich(got, want any) bool {
	w, ok := want.(map[string]any)
	if !ok {
		if wl, ok := want.([]any); ok {
			gl, ok := got.([]any)
			if !ok || len(gl) != len(wl) {
				return false
			}
			for i := range wl {
				if !teilGleich(gl[i], wl[i]) {
					return false
				}
			}
			return true
		}
		return gleich(got, want)
	}
	g, ok := got.(map[string]any)
	if !ok {
		return false
	}
	for k, v := range w {
		if !teilGleich(g[k], v) {
			return false
		}
	}
	return true
}

type vektorParameter struct {
	Basisadresse  int    `json:"basisadresse"`
	Funktionscode int    `json:"funktionscode"`
	Wortfolge     string `json:"wortfolge"`
}

func (v vektorParameter) parameter() Parameter {
	return Parameter{Basisadresse: v.Basisadresse, Funktionscode: v.Funktionscode, Wortfolge: v.Wortfolge}
}

func TestContractCasesV1toV13(t *testing.T) {
	var v struct {
		Faelle []struct {
			Name  string `json:"name"`
			Input struct {
				Parameter vektorParameter `json:"parameter"`
				Soll      *Soll           `json:"soll"`
				Woerter   []uint16        `json:"woerter"`
			} `json:"input"`
			Expected any `json:"expected"`
		} `json:"faelle"`
	}
	ladeJSON(t, repo(t, "docs", "contracts", "v2", "wago-registerbild-vectors.json"), &v)
	if len(v.Faelle) != 13 {
		t.Fatalf("%d Faelle", len(v.Faelle))
	}
	for _, c := range v.Faelle {
		got := alsJSON(t, LiesRegisterbild(c.Input.Woerter, c.Input.Parameter.parameter(), c.Input.Soll))
		want := c.Expected.(map[string]any)
		// anfragen_mindestens is about the request plan of the image, not the reading.
		if n, ok := want["anfragen_mindestens"].(float64); ok {
			delete(want, "anfragen_mindestens")
			kartenzahl := 0
			if k, ok := want["kopf"].(map[string]any); ok {
				kartenzahl = int(k["kartenzahl"].(float64))
			}
			anfragen, err := PlaneAnfragen(Parameter{Basisadresse: c.Input.Parameter.Basisadresse, Kartenzahl: kartenzahl})
			if want["ergebnis"] == "erkannt" && (err != nil || float64(len(anfragen)) < n) {
				t.Errorf("%s: %d Anfragen, Vertrag mindestens %v (%v)", c.Name, len(anfragen), n, err)
			}
		}
		if !teilGleich(got, want) {
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(c.Expected)
			t.Errorf("%s:\n Go %s\n Vertrag %s", c.Name, g, w)
		}
	}
}

type wagoVektoren struct {
	Planung []struct {
		Parameter struct {
			Basisadresse      int `json:"basisadresse"`
			Kartenzahl        int `json:"kartenzahl"`
			Kopflaenge        int `json:"kopflaenge"`
			Kartenblocklaenge int `json:"kartenblocklaenge"`
			MaxWoerter        int `json:"maxWoerter"`
		} `json:"parameter"`
		Anfragen []Anfrage `json:"anfragen"`
		Error    bool      `json:"error"`
	} `json:"planung"`
	Werte []struct {
		Woerter   []uint16 `json:"woerter"`
		Wortfolge string   `json:"wortfolge"`
		Datentyp  *string  `json:"datentyp"`
		Roh       float64  `json:"roh"`
		Wert      *float64 `json:"wert"`
	} `json:"werte"`
	Berichte []struct {
		Woerter     []uint16 `json:"woerter"`
		Wortfolge   string   `json:"wortfolge"`
		Typenschild []uint16 `json:"typenschild"`
		Bericht     any      `json:"bericht"`
	} `json:"berichte"`
	Typenschilder []struct {
		Woerter []uint16 `json:"woerter"`
		Text    *string  `json:"text"`
	} `json:"typenschilder"`
	Folgen []struct {
		Name      string          `json:"name"`
		Parameter vektorParameter `json:"parameter"`
		Soll      *Soll           `json:"soll"`
		Lesungen  []struct {
			Woerter    []uint16 `json:"woerter"`
			Gelesen    any      `json:"gelesen"`
			Ereignisse []struct {
				Topic   string `json:"topic"`
				Payload any    `json:"payload"`
			} `json:"ereignisse"`
			Qualitaet any `json:"qualitaet"`
		} `json:"lesungen"`
	} `json:"folgen"`
}

func TestWagoVectors(t *testing.T) {
	var v wagoVektoren
	ladeJSON(t, repo(t, "edge-app", "nodered", "measurements", "wago-vectors.json"), &v)
	for _, c := range v.Planung {
		p := c.Parameter
		got, err := PlaneAnfragen(Parameter{Basisadresse: p.Basisadresse, Kartenzahl: p.Kartenzahl, Kopflaenge: p.Kopflaenge,
			Kartenblocklaenge: p.Kartenblocklaenge, MaxWoerter: p.MaxWoerter})
		switch {
		case c.Error != (err != nil):
			t.Errorf("Planung %+v: Go Fehler %v, JS Fehler %v", p, err, c.Error)
		case !c.Error && !reflect.DeepEqual(got, c.Anfragen):
			t.Errorf("Planung %+v:\n Go %+v\n JS %+v", p, got, c.Anfragen)
		}
	}
	for _, c := range v.Werte {
		roh := Wert32(c.Woerter, 0, c.Wortfolge)
		typ := ""
		if c.Datentyp != nil {
			typ = *c.Datentyp
		}
		w, ok := Deute32(roh, typ)
		if float64(roh) != c.Roh || ok != (c.Wert != nil) || (ok && w != *c.Wert) {
			t.Errorf("Wert %v %s %s: Go %d %v %v, JS %v %v", c.Woerter, c.Wortfolge, typ, roh, w, ok, c.Roh, c.Wert)
		}
	}
	for _, c := range v.Berichte {
		got := alsJSON(t, BerichteKopf(c.Woerter, c.Wortfolge, c.Typenschild))
		if !gleich(got, c.Bericht) {
			t.Errorf("Bericht %v %s %v:\n Go %v\n JS %v", c.Woerter, c.Wortfolge, c.Typenschild, got, c.Bericht)
		}
	}
	for _, c := range v.Typenschilder {
		got := liesTypenschild(c.Woerter)
		if (got == nil) != (c.Text == nil) || (got != nil && *got != *c.Text) {
			t.Errorf("Typenschild %v: Go %v, JS %v", c.Woerter, got, c.Text)
		}
	}
	t0 := time.Date(2026, 11, 20, 8, 0, 0, 0, time.UTC)
	for _, f := range v.Folgen {
		wacht := &HerzschlagWacht{}
		ev := &Ereignisse{}
		for i, l := range f.Lesungen {
			g := PruefeLesung(l.Woerter, "source:sps", f.Parameter.parameter(), f.Soll, wacht)
			if got := alsJSON(t, g); !teilGleich(got, l.Gelesen) || !teilGleich(l.Gelesen, got) {
				gj, _ := json.Marshal(got)
				wj, _ := json.Marshal(l.Gelesen)
				t.Errorf("%s Lesung %d:\n Go %s\n JS %s", f.Name, i, gj, wj)
			}
			events, q := ev.Lesung(g, "DQ-W", "source:sps", func(_ Karte, index int) string { return "ek-" + itoa(index+1) },
				t0.Add(time.Duration(i)*time.Minute))
			var want []any
			for _, e := range l.Ereignisse {
				if e.Topic != EreignisTopic {
					t.Errorf("%s: Thema %s", f.Name, e.Topic)
				}
				want = append(want, e.Payload)
			}
			if !gleich(alsJSON(t, events), alsJSON(t, want)) {
				t.Errorf("%s Lesung %d Ereignisse:\n Go %v\n JS %v", f.Name, i, alsJSON(t, events), want)
			}
			if !gleich(alsJSON(t, q), l.Qualitaet) {
				t.Errorf("%s Lesung %d Qualitaet:\n Go %v\n JS %v", f.Name, i, alsJSON(t, q), l.Qualitaet)
			}
		}
	}
}
