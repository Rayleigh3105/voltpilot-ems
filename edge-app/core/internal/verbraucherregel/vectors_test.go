package verbraucherregel

// The Go twin against the shared vectors
// (docs/contracts/v2/verbraucherregel-vectors.json): the file is generated
// from the JS reference the Docker box's node runs
// (vp-palette/test/verbraucherregel-vectors.gen.js); at every step the twin
// must reach the same verdict and publish the same desired.

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

const vectorsPath = "../../../../docs/contracts/v2/verbraucherregel-vectors.json"

type vectorFile struct {
	SchemaVersion string `json:"schema_version"`
	Szenarien     []struct {
		Name     string         `json:"name"`
		Start    string         `json:"start"`
		Knoten   map[string]any `json:"knoten"`
		Schritte []struct {
			TS        int64          `json:"t_s"`
			Art       string         `json:"art"`
			Nachricht any            `json:"nachricht"`
			Erwartet  map[string]any `json:"erwartet"`
		} `json:"schritte"`
	} `json:"szenarien"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	var f vectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if f.SchemaVersion != "1.0" || len(f.Szenarien) == 0 {
		t.Fatalf("unexpected vector file (schema %q, %d scenarios)", f.SchemaVersion, len(f.Szenarien))
	}
	return f
}

// roundTrip turns a Go value into its JSON form, as the bus would carry it.
func roundTrip(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestVektoren(t *testing.T) {
	f := loadVectors(t)
	steps := 0
	for _, sz := range f.Szenarien {
		t.Run(sz.Name, func(t *testing.T) {
			start, err := time.Parse(time.RFC3339, sz.Start)
			if err != nil {
				t.Fatal(err)
			}
			rt := NewRuntime(Config(sz.Knoten))
			for _, st := range sz.Schritte {
				now := start.UnixMilli() + st.TS*1000
				var got Step
				switch st.Art {
				case "site":
					got = rt.OnSite(st.Nachricht, now)
				case "entity":
					got = rt.OnEntity(st.Nachricht, now)
				case "takt":
					got = rt.OnTrigger(now)
				default:
					t.Fatalf("unknown step kind %q", st.Art)
				}
				steps++
				r := got.Result
				have := map[string]any{
					"aktiv":       r.Active,
					"gehalten":    r.Held,
					"unbekannt":   r.AnyUnknown,
					"unbrauchbar": got.Unusable,
					"wunsch":      got.Publish,
				}
				if r.Active {
					have["must_run"] = r.MustRun
					have["wert"] = r.Value
					have["anforderungen"] = r.RequirementIDs
				}
				if !reflect.DeepEqual(roundTrip(t, have), roundTrip(t, st.Erwartet)) {
					hj, _ := json.Marshal(have)
					ej, _ := json.Marshal(st.Erwartet)
					t.Fatalf("t=%ds %s:\n got  %s\n want %s", st.TS, st.Art, hj, ej)
				}
			}
		})
	}
	if steps < 40 {
		t.Fatalf("only %d steps checked", steps)
	}
}

func TestJSZahlen(t *testing.T) {
	// Expected strings from node: (v).toString(). a+b is computed at run
	// time (a Go constant expression would be exact).
	a, b := 0.1, 0.2
	cases := []struct {
		in   float64
		want string
	}{
		{11, "11"}, {4.2, "4.2"}, {a + b, "0.30000000000000004"}, {-3, "-3"},
		{1e21, "1e+21"}, {1.5e-7, "1.5e-7"}, {0.000001, "0.000001"},
		{123456789012345680000, "123456789012345680000"}, {-2.5e-8, "-2.5e-8"},
	}
	for _, c := range cases {
		if got := jsNumberString(c.in); got != c.want {
			t.Errorf("jsNumberString(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}
