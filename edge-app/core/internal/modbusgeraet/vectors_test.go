package modbusgeraet

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

const vektorPfad = "../../../../docs/contracts/v2/modbus-geraet-vectors.json"
const woerterPfad = "../../../../docs/contracts/v2/steuerlogik-woerter.json"

type vektoren struct {
	SchemaVersion string                     `json:"schema_version"`
	Geraete       map[string]json.RawMessage `json:"geraete"`
	Definitionen  []struct {
		Name    string         `json:"name"`
		Geraet  string         `json:"geraet"`
		Aendere map[string]any `json:"aendere"`
		Fehler  []string       `json:"fehler"`
	} `json:"definitionen"`
	Roh []struct {
		Geraet string `json:"geraet"`
		Slug   string `json:"slug"`
		Wert   any    `json:"wert"`
		Roh    int    `json:"roh"`
	} `json:"roh"`
	Plan []struct {
		Name     string            `json:"name"`
		Geraet   string            `json:"geraet"`
		Befehle  entities.Commands `json:"befehle"`
		Tor      bool              `json:"tor"`
		Stoerung bool              `json:"stoerung"`
		Grund    string            `json:"grund"`
		Writes   []struct {
			Slug    string `json:"slug"`
			Address int    `json:"address"`
			FC      int    `json:"fc"`
			Raw     int    `json:"raw"`
			Rest    bool   `json:"rest"`
		} `json:"writes"`
	} `json:"plan"`
	Dekodieren []struct {
		Register Register `json:"register"`
		Regs     []uint16 `json:"regs"`
		Bits     []bool   `json:"bits"`
		Scale    float64  `json:"scale"`
		Offset   float64  `json:"offset"`
		Wert     *float64 `json:"wert"`
	} `json:"dekodieren"`
	Rueckmeldung []struct {
		Geraet string   `json:"geraet"`
		Slug   string   `json:"slug"`
		Regs   []uint16 `json:"regs"`
		Bits   []bool   `json:"bits"`
		Ist    Ist      `json:"ist"`
	} `json:"rueckmeldung"`
}

func lies(t *testing.T) vektoren {
	t.Helper()
	roh, err := os.ReadFile(vektorPfad)
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	if v.SchemaVersion != "1.0" {
		t.Fatalf("schema_version %q", v.SchemaVersion)
	}
	return v
}

func (v vektoren) geraet(t *testing.T, name string) Definition {
	t.Helper()
	d, fehler := Lies(v.Geraete[name])
	if len(fehler) > 0 {
		t.Fatalf("Gerät %s: %v", name, fehler)
	}
	return d
}

var pfadTeil = regexp.MustCompile(`^([a-z_]+)(?:\[(\d+)\])?$`)

// setze changes one value of a generic JSON tree along a path like
// "controls.values[1].min" (the vectors' "aendere").
func setze(t *testing.T, baum map[string]any, pfad string, wert any) {
	t.Helper()
	teile := strings.Split(pfad, ".")
	var knoten any = baum
	for i, teil := range teile {
		m := pfadTeil.FindStringSubmatch(teil)
		if m == nil {
			t.Fatalf("Pfad %s", pfad)
		}
		obj := knoten.(map[string]any)
		letzter := i == len(teile)-1
		if m[2] == "" {
			if letzter {
				obj[m[1]] = wert
				return
			}
			knoten = obj[m[1]]
			continue
		}
		n, _ := strconv.Atoi(m[2])
		liste := obj[m[1]].([]any)
		if letzter {
			liste[n] = wert
			return
		}
		knoten = liste[n]
	}
}

func TestDefinitionen(t *testing.T) {
	v := lies(t)
	for _, f := range v.Definitionen {
		var baum map[string]any
		if err := json.Unmarshal(v.Geraete[f.Geraet], &baum); err != nil {
			t.Fatal(err)
		}
		for pfad, wert := range f.Aendere {
			setze(t, baum, pfad, wert)
		}
		roh, _ := json.Marshal(baum)
		_, fehler := Lies(roh)
		var codes []string
		for _, e := range fehler {
			codes = append(codes, e.Code)
		}
		sort.Strings(codes)
		soll := append([]string(nil), f.Fehler...)
		sort.Strings(soll)
		if len(codes) == 0 {
			codes = []string{}
		}
		if len(soll) == 0 {
			soll = []string{}
		}
		if !reflect.DeepEqual(codes, soll) {
			t.Errorf("%s: Fehler %v, erwartet %v (%v)", f.Name, codes, soll, fehler)
		}
	}
}

func TestRoh(t *testing.T) {
	v := lies(t)
	for _, f := range v.Roh {
		d := v.geraet(t, f.Geraet)
		var c *Control
		for i := range d.Controls.Values {
			if d.Controls.Values[i].Slug == f.Slug {
				c = &d.Controls.Values[i]
			}
		}
		var got int
		switch w := f.Wert.(type) {
		case float64:
			raw, ok := c.rawSetpoint(w)
			if !ok {
				t.Fatalf("%s.%s %v: nicht darstellbar", f.Geraet, f.Slug, w)
			}
			got = int(raw)
		case string:
			got = c.Modes[w]
		case bool:
			got = *c.OffValue
			if w {
				got = *c.OnValue
			}
		}
		if got != f.Roh {
			t.Errorf("%s.%s %v: roh %d, erwartet %d", f.Geraet, f.Slug, f.Wert, got, f.Roh)
		}
	}
}

func TestPlan(t *testing.T) {
	v := lies(t)
	for _, f := range v.Plan {
		d := v.geraet(t, f.Geraet)
		writes, grund := Plan(d, f.Befehle, Lage{Gate: f.Tor, Fault: f.Stoerung})
		if grund != f.Grund {
			t.Errorf("%s: Grund %q, erwartet %q", f.Name, grund, f.Grund)
		}
		if len(writes) != len(f.Writes) {
			t.Errorf("%s: %d Schreibvorgänge, erwartet %d: %+v", f.Name, len(writes), len(f.Writes), writes)
			continue
		}
		for i, w := range writes {
			s := f.Writes[i]
			if w.Slug != s.Slug || w.Address != s.Address || w.FC != s.FC || int(w.Raw) != s.Raw || w.Rest != s.Rest {
				t.Errorf("%s: %+v, erwartet %+v", f.Name, w, s)
			}
		}
	}
}

func TestDekodieren(t *testing.T) {
	v := lies(t)
	for i, f := range v.Dekodieren {
		got, ok := Decode(f.Register, f.Regs, f.Bits, f.Scale, f.Offset)
		switch {
		case f.Wert == nil && ok:
			t.Errorf("Fall %d: %v statt keines Werts", i, got)
		case f.Wert != nil && (!ok || math.Abs(got-*f.Wert) > 1e-9):
			t.Errorf("Fall %d: %v/%v, erwartet %v", i, got, ok, *f.Wert)
		}
	}
}

func TestRueckmeldung(t *testing.T) {
	v := lies(t)
	for _, f := range v.Rueckmeldung {
		d := v.geraet(t, f.Geraet)
		var ist Ist
		for _, c := range d.Controls.Values {
			if c.Slug == f.Slug {
				c.Interpret(f.Regs, f.Bits, &ist)
			}
		}
		if !reflect.DeepEqual(ist, f.Ist) {
			t.Errorf("%s.%s: %+v, erwartet %+v", f.Geraet, f.Slug, ist, f.Ist)
		}
	}
}

// Die Signale sind die der Steuerlogik-Wortliste: ein Kanal, den eine Logik als
// <gerät>.<signal> liest, muss dort stehen.
func TestSignaleWieWortliste(t *testing.T) {
	roh, err := os.ReadFile(woerterPfad)
	if err != nil {
		t.Fatal(err)
	}
	var w struct {
		Abschnitte map[string]any    `json:"abschnitte"`
		Signal     map[string]string `json:"signal"`
	}
	if err := json.Unmarshal(roh, &w); err != nil {
		t.Fatal(err)
	}
	var liste []string
	for _, en := range w.Signal {
		liste = append(liste, en)
	}
	sort.Strings(liste)
	eigene := append([]string(nil), Signals...)
	sort.Strings(eigene)
	if !reflect.DeepEqual(liste, eigene) {
		t.Fatalf("Signale %v, Wortliste %v", eigene, liste)
	}
}
