package deyedecode

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "deye", "deye-decode-vectors.json")
}

type sparseBlock struct {
	Start int               `json:"start"`
	Count int               `json:"count"`
	Set   map[string]uint16 `json:"set"`
}

type jsConfig struct {
	Family          string   `json:"family"`
	InvertGridSign  bool     `json:"invert_grid_sign"`
	InvertBattSign  bool     `json:"invert_batt_sign"`
	AllowMissingSoc bool     `json:"allow_missing_soc"`
	PowerScale      float64  `json:"power_scale"`
	SocFromVoltage  *jsRange `json:"soc_from_voltage"`
}

type jsRange struct {
	VEmpty float64 `json:"v_empty"`
	VFull  float64 `json:"v_full"`
}

type jsResult struct {
	Reading map[string]any `json:"reading"`
	BattKw  *float64       `json:"batt_kw"`
	Drop    *Drop          `json:"drop"`
}

type vectorFile struct {
	PlanReads    map[string][]ReadSpec `json:"plan_reads"`
	SocPlausible []struct {
		Value     float64 `json:"value"`
		Plausible bool    `json:"plausible"`
	} `json:"soc_plausible"`
	Cases []struct {
		Name    string        `json:"name"`
		Blocks  []sparseBlock `json:"blocks"`
		Config  jsConfig      `json:"config"`
		Decode  *jsResult     `json:"decode"`
		Verbose *jsResult     `json:"verbose"`
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
	return v
}

// expandBlocks is the Go twin of deye-decode-vectors.gen.js expandBlocks.
func expandBlocks(t *testing.T, in []sparseBlock) []Block {
	t.Helper()
	out := make([]Block, 0, len(in))
	for _, b := range in {
		regs := make([]uint16, b.Count)
		for k, v := range b.Set {
			a, err := strconv.ParseInt(k, 0, 32)
			if err != nil {
				t.Fatalf("Registeradresse %q: %v", k, err)
			}
			regs[int(a)-b.Start] = v
		}
		out = append(out, Block{Start: b.Start, Regs: regs})
	}
	return out
}

func toConfig(c jsConfig) Config {
	cfg := Config{
		Family: c.Family, InvertGridSign: c.InvertGridSign, InvertBattSign: c.InvertBattSign,
		AllowMissingSoc: c.AllowMissingSoc, PowerScale: c.PowerScale,
	}
	if c.SocFromVoltage != nil {
		cfg.SocFromVoltage = &VoltRange{VEmpty: c.SocFromVoltage.VEmpty, VFull: c.SocFromVoltage.VFull}
	}
	return cfg
}

// sameFloat compares bit-for-bit (the point of the twin), treating -0 == 0
// like JSON does.
func sameFloat(a, b float64) bool { return a == b || (math.IsNaN(a) && math.IsNaN(b)) }

func compareReading(t *testing.T, name string, got map[string]float64, gotSource string, want map[string]any) {
	t.Helper()
	wantNums := map[string]float64{}
	wantSource := ""
	for k, v := range want {
		switch x := v.(type) {
		case float64:
			wantNums[k] = x
		case string:
			if k != "soc_source" {
				t.Errorf("%s: unerwartetes Textfeld %s", name, k)
			}
			wantSource = x
		}
	}
	if gotSource != wantSource {
		t.Errorf("%s: soc_source Go %q, JS %q", name, gotSource, wantSource)
	}
	keys := func(m map[string]float64) []string {
		ks := make([]string, 0, len(m))
		for k := range m {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		return ks
	}
	if !reflect.DeepEqual(keys(got), keys(wantNums)) {
		t.Errorf("%s: Kanaele Go %v, JS %v", name, keys(got), keys(wantNums))
		return
	}
	for k, w := range wantNums {
		if !sameFloat(got[k], w) {
			t.Errorf("%s: %s Go %v, JS %v", name, k, got[k], w)
		}
	}
}

func compareBatt(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case got == nil && want == nil:
	case got == nil || want == nil:
		t.Errorf("%s: batt_kw Go %v, JS %v", name, got, want)
	case !sameFloat(*got, *want):
		t.Errorf("%s: batt_kw Go %v, JS %v", name, *got, *want)
	}
}

func TestSharedVectorsDecode(t *testing.T) {
	v := loadVectors(t)
	if len(v.Cases) < 20 {
		t.Fatalf("nur %d Faelle - Vektordatei unvollstaendig?", len(v.Cases))
	}
	for _, c := range v.Cases {
		blocks := expandBlocks(t, c.Blocks)
		cfg := toConfig(c.Config)

		got := Decode(blocks, cfg)
		if (got == nil) != (c.Decode == nil) {
			t.Errorf("%s: decode Go %v, JS %v", c.Name, got != nil, c.Decode != nil)
		} else if got != nil {
			compareReading(t, c.Name+" [decode]", got.Reading, got.SocSource, c.Decode.Reading)
			compareBatt(t, c.Name+" [decode]", got.BattKw, c.Decode.BattKw)
		}

		vb, ok := DecodeVerbose(blocks, cfg)
		if ok != (c.Verbose != nil) {
			t.Errorf("%s: decodeVerbose Go %v, JS %v", c.Name, ok, c.Verbose != nil)
			continue
		}
		if !ok {
			continue
		}
		compareReading(t, c.Name+" [verbose]", vb.Reading, "", c.Verbose.Reading)
		compareBatt(t, c.Name+" [verbose]", vb.BattKw, c.Verbose.BattKw)
		gotDrop, _ := json.Marshal(vb.Drop)
		wantDrop, _ := json.Marshal(c.Verbose.Drop)
		if string(gotDrop) != string(wantDrop) {
			t.Errorf("%s: drop Go %s, JS %s", c.Name, gotDrop, wantDrop)
		}
	}
}

func TestSharedVectorsPlanReads(t *testing.T) {
	v := loadVectors(t)
	for fam, want := range v.PlanReads {
		if got := PlanReads(fam); !reflect.DeepEqual(got, want) {
			t.Errorf("PlanReads(%s) Go %+v, JS %+v", fam, got, want)
		}
	}
}

func TestSharedVectorsSocPlausible(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.SocPlausible {
		if got := SocPlausible(c.Value); got != c.Plausible {
			t.Errorf("SocPlausible(%v) Go %v, JS %v", c.Value, got, c.Plausible)
		}
	}
}

// jsRound must be Math.round, not math.Round: they differ on negative ties.
func TestJSRoundIsHalfTowardsPositiveInfinity(t *testing.T) {
	for in, want := range map[float64]float64{2.5: 3, -2.5: -2, -0.5: 0, 0.49: 0, -1.5: -1} {
		if got := jsRound(in); got != want {
			t.Errorf("jsRound(%v) = %v, want %v", in, got, want)
		}
	}
}
