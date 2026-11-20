package froniusapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type vektoren struct {
	PowerFlowPath string   `json:"power_flow_path"`
	Families      []string `json:"families"`
	URLs          []struct {
		Scheme *string `json:"scheme"`
		Host   string  `json:"host"`
		Port   int     `json:"port"`
		URL    string  `json:"url"`
	} `json:"urls"`
	Cases []struct {
		Name           string `json:"name"`
		Raw            string `json:"raw"`
		InvertGridSign bool   `json:"invert_grid_sign"`
		Decode         *struct {
			Reading map[string]float64 `json:"reading"`
			BattKw  *float64           `json:"battKw"`
		} `json:"decode"`
	} `json:"cases"`
}

func laden(t *testing.T) vektoren {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "fronius", "solar-api-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSharedVectors(t *testing.T) {
	v := laden(t)
	if v.PowerFlowPath != PowerFlowPath || !reflect.DeepEqual(v.Families, []string{Family}) {
		t.Fatalf("Pfad/Familien: %s %v", v.PowerFlowPath, v.Families)
	}
	for _, u := range v.URLs {
		scheme := ""
		if u.Scheme != nil {
			scheme = *u.Scheme
		}
		if got := PowerFlowURL(scheme, u.Host, u.Port); got != u.URL {
			t.Errorf("URL %v: %s statt %s", u, got, u.URL)
		}
	}
	if len(v.Cases) < 40 {
		t.Fatalf("%d Faelle", len(v.Cases))
	}
	for _, c := range v.Cases {
		got := DecodeBody([]byte(c.Raw), Options{InvertGridSign: c.InvertGridSign})
		switch {
		case c.Decode == nil && got == nil:
		case c.Decode == nil || got == nil:
			t.Errorf("%s (%v): Go %+v, JS %+v", c.Name, c.InvertGridSign, got, c.Decode)
		case !reflect.DeepEqual(got.Reading, c.Decode.Reading) || !reflect.DeepEqual(got.BattKw, c.Decode.BattKw):
			t.Errorf("%s (%v): Go %v %v, JS %v %v", c.Name, c.InvertGridSign, got.Reading, got.BattKw, c.Decode.Reading, c.Decode.BattKw)
		}
	}
}
