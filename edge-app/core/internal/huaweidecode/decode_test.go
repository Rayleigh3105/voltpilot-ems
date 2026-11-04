package huaweidecode

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "huawei", "huawei-decode-vectors.json")
}

type jsBlock struct {
	Start int      `json:"start"`
	Regs  []uint16 `json:"regs"`
}

type jsDecode struct {
	Reading map[string]float64 `json:"reading"`
	BattKw  *float64           `json:"battKw"`
	Meta    struct {
		ActivePowerW         *int32  `json:"active_power_w"`
		BatteryRunningStatus *uint16 `json:"battery_running_status"`
	} `json:"meta"`
}

type vectorFile struct {
	Constants struct {
		Reg           map[string]int `json:"reg"`
		DefaultPort   int            `json:"default_port"`
		DefaultUnitID int            `json:"default_unit_id"`
		Families      []string       `json:"families"`
	} `json:"constants"`
	PlanReads    map[string][][2]int `json:"plan_reads"`
	SocPlausible []struct {
		Soc json.RawMessage `json:"soc"`
		OK  bool            `json:"ok"`
	} `json:"soc_plausible"`
	Cases []struct {
		Name   string    `json:"name"`
		Blocks []jsBlock `json:"blocks"`
		Opts   struct {
			InvertGridSign bool `json:"invertGridSign"`
			InvertBattSign bool `json:"invertBattSign"`
		} `json:"opts"`
		Decode *jsDecode `json:"decode"`
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
	c := loadVectors(t).Constants
	want := map[string]int{
		"INPUT_POWER_W": RegInputPowerW, "ACTIVE_POWER_W": RegActivePowerW, "METER_ACTIVE_POWER_W": RegMeterActivePowerW,
		"BATTERY_RUNNING_STATUS": RegBatteryRunningStatus, "BATTERY_SOC_PCT_X10": RegBatterySocPctX10,
		"BATTERY_CHARGE_DISCHARGE_POWER_W": RegBatteryChargeDischargePowerW,
	}
	if !reflect.DeepEqual(c.Reg, want) {
		t.Fatalf("REG weicht ab: JS %v, Go %v", c.Reg, want)
	}
	if c.DefaultPort != DefaultPort || c.DefaultUnitID != DefaultUnitID {
		t.Fatalf("Vorgaben weichen ab: %+v", c)
	}
	if len(c.Families) != 1 || c.Families[0] != Family {
		t.Fatalf("Familien weichen ab: %v", c.Families)
	}
}

func TestPlanReadsMatchesTheJSModule(t *testing.T) {
	for family, want := range loadVectors(t).PlanReads {
		fam := family
		if fam == "ohne_familie" {
			fam = ""
		}
		got := PlanReads(fam)
		if len(got) != len(want) {
			t.Fatalf("planReads(%q): %v, JS %v", family, got, want)
		}
		for i, r := range got {
			if r.Start != want[i][0] || r.Count != want[i][1] {
				t.Errorf("planReads(%q)[%d] = %+v, JS %v", family, i, r, want[i])
			}
		}
	}
}

func TestSocPlausibleMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).SocPlausible {
		var v float64
		if err := json.Unmarshal(c.Soc, &v); err != nil {
			var s string
			_ = json.Unmarshal(c.Soc, &s)
			switch s {
			case "NaN":
				v = math.NaN()
			case "Infinity":
				v = math.Inf(1)
			default:
				t.Fatalf("soc %s", c.Soc)
			}
		}
		if got := SocPlausible(v); got != c.OK {
			t.Errorf("socPlausible(%s) = %v, JS %v", c.Soc, got, c.OK)
		}
	}
}

func TestDecodeMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			blocks := make([]Block, 0, len(c.Blocks))
			for _, b := range c.Blocks {
				blocks = append(blocks, Block{Start: b.Start, Regs: b.Regs})
			}
			got := Decode(blocks, Options{InvertGridSign: c.Opts.InvertGridSign, InvertBattSign: c.Opts.InvertBattSign})
			if c.Decode == nil {
				if got != nil {
					t.Fatalf("JS null, Go %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("JS %+v, Go nil", c.Decode)
			}
			if !reflect.DeepEqual(got.Reading, c.Decode.Reading) {
				t.Errorf("reading: Go %v, JS %v", got.Reading, c.Decode.Reading)
			}
			if !samePtr(got.BattKw, c.Decode.BattKw) {
				t.Errorf("battKw: Go %v, JS %v", deref(got.BattKw), deref(c.Decode.BattKw))
			}
			if (got.Meta.ActivePowerW == nil) != (c.Decode.Meta.ActivePowerW == nil) ||
				(got.Meta.ActivePowerW != nil && *got.Meta.ActivePowerW != *c.Decode.Meta.ActivePowerW) {
				t.Errorf("meta.active_power_w: Go %v, JS %v", got.Meta.ActivePowerW, c.Decode.Meta.ActivePowerW)
			}
			if (got.Meta.BatteryRunningStatus == nil) != (c.Decode.Meta.BatteryRunningStatus == nil) ||
				(got.Meta.BatteryRunningStatus != nil && *got.Meta.BatteryRunningStatus != *c.Decode.Meta.BatteryRunningStatus) {
				t.Errorf("meta.battery_running_status: Go %v, JS %v", got.Meta.BatteryRunningStatus, c.Decode.Meta.BatteryRunningStatus)
			}
			// The bus payload must read the same: no "-0" out of encoding/json.
			for k, v := range got.Reading {
				if v == 0 && math.Signbit(v) {
					t.Errorf("%s ist -0", k)
				}
			}
			if got.BattKw != nil && *got.BattKw == 0 && math.Signbit(*got.BattKw) {
				t.Error("battKw ist -0")
			}
		})
	}
}

func samePtr(a, b *float64) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	return a == nil || *a == *b
}

func deref(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func TestJSRoundIsHalfTowardsPositiveInfinity(t *testing.T) {
	for x, want := range map[float64]float64{0.5: 1, 1.5: 2, 2.5: 3, -0.5: 0, -1.5: -1, -2.5: -2} {
		if got := jsRound(x); got != want {
			t.Errorf("Math.round(%v) = %v, want %v", x, got, want)
		}
	}
}
