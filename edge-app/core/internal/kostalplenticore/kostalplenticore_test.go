package kostalplenticore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type vektoren struct {
	Families      []string   `json:"families"`
	DefaultPort   int        `json:"default_port"`
	DefaultUnitID int        `json:"default_unit_id"`
	Plan          []ReadSpec `json:"plan"`
	PlanUnknown   []ReadSpec `json:"plan_unknown"`
	Cases         []struct {
		Name   string `json:"name"`
		Blocks []struct {
			Start int      `json:"start"`
			Regs  []uint16 `json:"regs"`
		} `json:"blocks"`
		Opts struct {
			InvertGridSign bool   `json:"invertGridSign"`
			InvertBattSign bool   `json:"invertBattSign"`
			ByteOrder      string `json:"byteOrder"`
		} `json:"opts"`
		Decode *struct {
			Reading map[string]float64 `json:"reading"`
			BattKw  *float64           `json:"battKw"`
			Meta    Meta               `json:"meta"`
		} `json:"decode"`
	} `json:"cases"`
}

func TestSharedVectors(t *testing.T) {
	_, here, _, _ := runtime.Caller(0)
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "kostal", "kostal-decode-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(v.Families, []string{Family}) || v.DefaultPort != DefaultPort || v.DefaultUnitID != DefaultUnitID {
		t.Fatalf("Familien/Vorgaben: %v %d %d", v.Families, v.DefaultPort, v.DefaultUnitID)
	}
	if !reflect.DeepEqual(PlanReads(Family), v.Plan) || len(PlanReads("kostal_piko")) != len(v.PlanUnknown) {
		t.Fatalf("Leseplan: %v statt %v", PlanReads(Family), v.Plan)
	}
	if len(v.Cases) < 40 {
		t.Fatalf("%d Faelle", len(v.Cases))
	}
	for _, c := range v.Cases {
		var blocks []Block
		for _, b := range c.Blocks {
			blocks = append(blocks, Block{Start: b.Start, Regs: b.Regs})
		}
		got := Decode(blocks, Options{InvertGridSign: c.Opts.InvertGridSign, InvertBattSign: c.Opts.InvertBattSign, ByteOrder: c.Opts.ByteOrder})
		switch {
		case c.Decode == nil && got == nil:
		case c.Decode == nil || got == nil:
			t.Errorf("%s %+v: Go %+v, JS %+v", c.Name, c.Opts, got, c.Decode)
		case !reflect.DeepEqual(got.Reading, c.Decode.Reading) || !reflect.DeepEqual(got.BattKw, c.Decode.BattKw) ||
			!reflect.DeepEqual(got.Meta, c.Decode.Meta):
			g, _ := json.Marshal(got)
			w, _ := json.Marshal(c.Decode)
			t.Errorf("%s %+v:\n Go %s\n JS %s", c.Name, c.Opts, g, w)
		}
	}
}
