package goeapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "goe", "goe-api-vectors.json")
}

type jsResult struct {
	Reading  map[string]float64 `json:"reading"`
	CarState string             `json:"carState"`
	Charging bool               `json:"charging"`
	Allowed  *bool              `json:"allowed"`
}

type vectorFile struct {
	Constants struct {
		StatusPath       string            `json:"status_path"`
		StatusFilter     string            `json:"status_filter"`
		NrgTotalPowerIdx int               `json:"nrg_total_power_idx"`
		Families         []string          `json:"families"`
		CarStates        map[string]string `json:"car_states"`
	} `json:"constants"`
	CarState []struct {
		Car   json.RawMessage `json:"car"`
		State string          `json:"state"`
	} `json:"car_state"`
	StatusURL []struct {
		Host string `json:"host"`
		Port *int   `json:"port"`
		URL  string `json:"url"`
	} `json:"status_url"`
	Cases []struct {
		Name       string          `json:"name"`
		Body       string          `json:"body"`
		ParseError bool            `json:"parse_error"`
		Decode     json.RawMessage `json:"decode"`
	} `json:"cases"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("gemeinsame Vektoren nicht lesbar: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren kaputt: %v", err)
	}
	if len(v.Cases) < 30 {
		t.Fatalf("zu wenige Faelle: %d", len(v.Cases))
	}
	return v
}

func TestConstantsMatchTheJSModule(t *testing.T) {
	v := loadVectors(t)
	c := v.Constants
	if c.StatusPath != StatusPath || c.StatusFilter != StatusFilter || c.NrgTotalPowerIdx != NrgTotalPowerIdx {
		t.Fatalf("Konstanten weichen ab: %+v", c)
	}
	if len(c.Families) != 1 || c.Families[0] != Family {
		t.Fatalf("Familien weichen ab: %v", c.Families)
	}
	if len(c.CarStates) != len(CarStates) {
		t.Fatalf("CAR_STATES: %v", c.CarStates)
	}
	keys := make([]string, 0, len(c.CarStates))
	for k := range c.CarStates {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		var code int
		if err := json.Unmarshal([]byte(k), &code); err != nil || CarStates[code] != c.CarStates[k] {
			t.Errorf("CAR_STATES[%s] = %q, Go %q", k, c.CarStates[k], CarStates[code])
		}
	}
}

func TestCarStateMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).CarState {
		v, err := parseJS(c.Car)
		if err != nil {
			t.Fatalf("car %s: %v", c.Car, err)
		}
		if got := CarState(v); got != c.State {
			t.Errorf("carState(%s) = %q, JS %q", c.Car, got, c.State)
		}
	}
}

func TestStatusURLMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).StatusURL {
		port := 0
		if c.Port != nil {
			port = *c.Port
		}
		if got := StatusURL(c.Host, port); got != c.URL {
			t.Errorf("statusUrl(%s, %v) = %q, JS %q", c.Host, c.Port, got, c.URL)
		}
	}
}

func TestDecodeMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, err := Decode([]byte(c.Body))
			if c.ParseError {
				if err == nil {
					t.Fatalf("JSON.parse wirft, Go las %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Go: %v, JS las die Antwort", err)
			}
			var want *jsResult
			if err := json.Unmarshal(c.Decode, &want); err != nil {
				t.Fatal(err)
			}
			if want == nil {
				if got != nil {
					t.Fatalf("JS: null, Go: %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("JS: %+v, Go: nil", want)
			}
			wantLoad, has := want.Reading["load_kw"]
			if len(want.Reading) > 1 {
				t.Fatalf("unerwartete Messwerte im Vektor: %v", want.Reading)
			}
			switch {
			case has && got.LoadKw == nil:
				t.Errorf("load_kw: JS %v, Go abwesend", wantLoad)
			case !has && got.LoadKw != nil:
				t.Errorf("load_kw: JS abwesend, Go %v", *got.LoadKw)
			case has && *got.LoadKw != wantLoad:
				t.Errorf("load_kw: JS %v, Go %v", wantLoad, *got.LoadKw)
			}
			if got.CarState != want.CarState || got.Charging != want.Charging {
				t.Errorf("Zustand: JS %q/%v, Go %q/%v", want.CarState, want.Charging, got.CarState, got.Charging)
			}
			switch {
			case (want.Allowed == nil) != (got.Allowed == nil):
				t.Errorf("allowed: JS %v, Go %v", want.Allowed, got.Allowed)
			case want.Allowed != nil && *want.Allowed != *got.Allowed:
				t.Errorf("allowed: JS %v, Go %v", *want.Allowed, *got.Allowed)
			}
		})
	}
}

func TestJSRoundIsHalfTowardsPositiveInfinity(t *testing.T) {
	for in, want := range map[float64]float64{0.5: 1, 1.5: 2, 2.5: 3, -0.5: 0, -1.5: -1, -2.5: -2} {
		if got := jsRound(in); got != want {
			t.Errorf("jsRound(%v) = %v, Math.round %v", in, got, want)
		}
	}
}
