package kostalrtu

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY
// PATH: moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "kostal", "kostal-piko-rtu-vectors.json")
}

type jsBlock struct {
	Start int      `json:"start"`
	Regs  []uint16 `json:"regs"`
}

type jsChannel struct {
	VV *float64 `json:"vV"`
	AA *float64 `json:"aA"`
	PW *float64 `json:"pW"`
}

type jsDecode struct {
	Reading struct {
		PvPowerKw *float64 `json:"pv_power_kw"`
	} `json:"reading"`
}

type jsVerbose struct {
	PvPowerKw      *float64    `json:"pvPowerKw"`
	AcKw           *float64    `json:"acKw"`
	DcKw           *float64    `json:"dcKw"`
	Strings        []jsChannel `json:"strings"`
	Phases         []jsChannel `json:"phases"`
	FrequencyHz    *float64    `json:"frequencyHz"`
	CosPhi         *float64    `json:"cosPhi"`
	RatedW         *float64    `json:"ratedW"`
	EnergyTotalKwh *float64    `json:"energyTotalKwh"`
	EnergyTodayKwh *float64    `json:"energyTodayKwh"`
	OperatingHours *float64    `json:"operatingHours"`
	Name           *string     `json:"name"`
	Serial         *string     `json:"serial"`
}

type vectorFile struct {
	Constants struct {
		DefaultPort   int            `json:"default_port"`
		DefaultUnitID int            `json:"default_unit_id"`
		MinUnitID     int            `json:"min_unit_id"`
		MaxUnitID     int            `json:"max_unit_id"`
		Reg           map[string]int `json:"reg"`
	} `json:"constants"`
	Cases []struct {
		Name          string    `json:"name"`
		Blocks        []jsBlock `json:"blocks"`
		Decode        *jsDecode `json:"decode"`
		DecodeVerbose jsVerbose `json:"decode_verbose"`
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
	if len(v.Cases) < 6 {
		t.Fatalf("zu wenige Faelle: %d", len(v.Cases))
	}
	return v
}

func TestConstantsMatchTheJSModule(t *testing.T) {
	c := loadVectors(t).Constants
	if c.DefaultPort != DefaultPort || c.DefaultUnitID != DefaultUnitID || c.MinUnitID != MinUnitID || c.MaxUnitID != MaxUnitID {
		t.Fatalf("Konstanten weichen ab: %+v", c)
	}
	want := map[string]int{
		"DC1_V": RegDC1V, "DC1_A": RegDC1A, "DC1_W": RegDC1W,
		"DC2_V": RegDC2V, "DC2_A": RegDC2A, "DC2_W": RegDC2W,
		"DC3_V": RegDC3V, "DC3_A": RegDC3A, "DC3_W": RegDC3W,
		"L1_V": RegL1V, "L1_A": RegL1A, "L1_W": RegL1W,
		"L2_V": RegL2V, "L2_A": RegL2A, "L2_W": RegL2W,
		"L3_V": RegL3V, "L3_A": RegL3A, "L3_W": RegL3W,
		"DC_TOTAL_W": RegDCTotalW, "AC_TOTAL_W": RegACTotalW,
		"COS_PHI": RegCosPhi, "FREQUENCY": RegFrequency, "RATED_W": RegRatedW,
		"ENERGY_TOTAL_HI": RegEnergyTotalHi, "ENERGY_TOTAL_LO": RegEnergyTotalLo,
		"OPERATING_HOURS": RegOperatingHours, "ENERGY_TODAY_WH": RegEnergyTodayWh,
		"NAME_START": RegNameStart, "NAME_COUNT": RegNameCount,
		"SERIAL_START": RegSerialStart, "SERIAL_COUNT": RegSerialCount,
	}
	for name, addr := range want {
		if c.Reg[name] != addr {
			t.Errorf("REG.%s: Go %d, JS %d", name, addr, c.Reg[name])
		}
	}
}

func toBlocks(in []jsBlock) []Block {
	out := make([]Block, len(in))
	for i, b := range in {
		out[i] = Block{Start: b.Start, Regs: b.Regs}
	}
	return out
}

func eqp(got, want *float64) bool {
	if got == nil || want == nil {
		return got == nil && want == nil
	}
	return *got == *want
}

func eqChannel(got Channel, want jsChannel) bool {
	return eqp(got.VoltageV, want.VV) && eqp(got.CurrentA, want.AA) && eqp(got.PowerW, want.PW)
}

func eqStr(got string, want *string) bool {
	if want == nil {
		return got == ""
	}
	return got == *want
}

func TestDecodeMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			blocks := toBlocks(c.Blocks)
			got := Decode(blocks)
			if c.Decode == nil {
				if got != nil {
					t.Fatalf("JS null, Go %+v", got)
				}
			} else {
				if got == nil {
					t.Fatalf("JS %+v, Go nil", c.Decode)
				}
				gotPv, has := got.Reading["pv_power_kw"]
				want := c.Decode.Reading.PvPowerKw
				if (want == nil) != !has || (want != nil && gotPv != *want) {
					t.Errorf("pv_power_kw: Go %v (%v), JS %v", gotPv, has, want)
				}
			}
		})
	}
}

func TestDecodeVerboseMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			v := DecodeVerbose(toBlocks(c.Blocks))
			w := c.DecodeVerbose
			if !eqp(v.PvPowerKw, w.PvPowerKw) || !eqp(v.AcKw, w.AcKw) || !eqp(v.DcKw, w.DcKw) {
				t.Errorf("AC/DC: Go pv=%v ac=%v dc=%v, JS pv=%v ac=%v dc=%v", v.PvPowerKw, v.AcKw, v.DcKw, w.PvPowerKw, w.AcKw, w.DcKw)
			}
			for i := 0; i < 3; i++ {
				if len(w.Strings) > i && !eqChannel(v.Strings[i], w.Strings[i]) {
					t.Errorf("strings[%d]: Go %+v, JS %+v", i, v.Strings[i], w.Strings[i])
				}
				if len(w.Phases) > i && !eqChannel(v.Phases[i], w.Phases[i]) {
					t.Errorf("phases[%d]: Go %+v, JS %+v", i, v.Phases[i], w.Phases[i])
				}
			}
			if !eqp(v.FrequencyHz, w.FrequencyHz) || !eqp(v.CosPhi, w.CosPhi) || !eqp(v.RatedW, w.RatedW) {
				t.Errorf("freq/cos/rated: Go %v %v %v, JS %v %v %v", v.FrequencyHz, v.CosPhi, v.RatedW, w.FrequencyHz, w.CosPhi, w.RatedW)
			}
			if !eqp(v.EnergyTotalKwh, w.EnergyTotalKwh) || !eqp(v.EnergyTodayKwh, w.EnergyTodayKwh) || !eqp(v.OperatingHours, w.OperatingHours) {
				t.Errorf("energy/hours: Go %v %v %v, JS %v %v %v", v.EnergyTotalKwh, v.EnergyTodayKwh, v.OperatingHours, w.EnergyTotalKwh, w.EnergyTodayKwh, w.OperatingHours)
			}
			if !eqStr(v.Name, w.Name) || !eqStr(v.Serial, w.Serial) {
				t.Errorf("name/serial: Go %q/%q, JS %v/%v", v.Name, v.Serial, w.Name, w.Serial)
			}
		})
	}
}
