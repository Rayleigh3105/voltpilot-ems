package kostaldxs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY
// PATH: moving the file breaks this test deliberately.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "kostal", "kostal-dxs-vectors.json")
}

type jsChannel struct {
	V *float64 `json:"v"`
	A *float64 `json:"a"`
	P *float64 `json:"p"`
}

type jsReading struct {
	PvPowerKw *float64 `json:"pv_power_kw"`
}

type jsMeta struct {
	AcKw            *float64 `json:"ac_kw"`
	DcKw            *float64 `json:"dc_kw"`
	DC1V            *float64 `json:"dc1_v"`
	DC1A            *float64 `json:"dc1_a"`
	DC1W            *float64 `json:"dc1_w"`
	DC2V            *float64 `json:"dc2_v"`
	DC2A            *float64 `json:"dc2_a"`
	DC2W            *float64 `json:"dc2_w"`
	DC3V            *float64 `json:"dc3_v"`
	DC3A            *float64 `json:"dc3_a"`
	DC3W            *float64 `json:"dc3_w"`
	L1V             *float64 `json:"l1_v"`
	L1A             *float64 `json:"l1_a"`
	L1W             *float64 `json:"l1_w"`
	L2V             *float64 `json:"l2_v"`
	L2A             *float64 `json:"l2_a"`
	L2W             *float64 `json:"l2_w"`
	L3V             *float64 `json:"l3_v"`
	L3A             *float64 `json:"l3_a"`
	L3W             *float64 `json:"l3_w"`
	FreqHz          *float64 `json:"freq_hz"`
	CosPhi          *float64 `json:"cos_phi"`
	LimitationPct   *float64 `json:"limitation_pct"`
	Status          *float64 `json:"status"`
	StatusText      *string  `json:"status_text"`
	EnergyTotalKwh  *float64 `json:"energy_total_kwh"`
	EnergyTodayKwh  *float64 `json:"energy_today_kwh"`
	OperatingHoursH *float64 `json:"operating_hours_h"`
	Type            *string  `json:"type"`
	Serial          *string  `json:"serial"`
	Name            *string  `json:"name"`
	FwVersion       *string  `json:"fw_version"`
	HwVersion       *string  `json:"hw_version"`
	UiVersion       *string  `json:"ui_version"`
	ParVersion      *string  `json:"par_version"`
}

type jsDecode struct {
	Reading jsReading `json:"reading"`
	Meta    jsMeta    `json:"meta"`
}

type vectorFile struct {
	Constants struct {
		DefaultPort  int               `json:"default_port"`
		DxsPath      string            `json:"dxs_path"`
		Dxs          map[string]int    `json:"dxs"`
		StatusLabels map[string]string `json:"status_labels"`
		FastIDs      []int             `json:"fast_ids"`
		SlowIDs      []int             `json:"slow_ids"`
		IdentityIDs  []int             `json:"identity_ids"`
		PollIDs      []int             `json:"poll_ids"`
		AllIDs       []int             `json:"all_ids"`
	} `json:"constants"`
	DxsURL []struct {
		Scheme string `json:"scheme"`
		Host   string `json:"host"`
		Port   int    `json:"port"`
		Ids    []int  `json:"ids"`
		URL    string `json:"url"`
	} `json:"dxs_url"`
	Cases []struct {
		Name   string    `json:"name"`
		Raw    string    `json:"raw"`
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
	if len(v.Cases) < 15 {
		t.Fatalf("zu wenige Faelle: %d", len(v.Cases))
	}
	return v
}

func TestConstantsMatchTheJSModule(t *testing.T) {
	c := loadVectors(t).Constants
	if c.DefaultPort != DefaultPort || c.DxsPath != DxsPath {
		t.Fatalf("Port/Pfad weichen ab: %+v", c)
	}
	want := map[string]int{
		"AC_POWER_W": DxsACPowerW, "DC_POWER_TOTAL_W": DxsDCPowerTotalW,
		"DC1_A": DxsDC1A, "DC1_V": DxsDC1V, "DC1_W": DxsDC1W,
		"DC2_A": DxsDC2A, "DC2_V": DxsDC2V, "DC2_W": DxsDC2W,
		"DC3_A": DxsDC3A, "DC3_V": DxsDC3V, "DC3_W": DxsDC3W,
		"L1_A": DxsL1A, "L1_V": DxsL1V, "L1_W": DxsL1W,
		"L2_A": DxsL2A, "L2_V": DxsL2V, "L2_W": DxsL2W,
		"L3_A": DxsL3A, "L3_V": DxsL3V, "L3_W": DxsL3W,
		"FREQ_HZ": DxsFreqHz, "COS_PHI": DxsCosPhi, "LIMITATION_PCT": DxsLimitationPct, "STATUS": DxsStatus,
		"ENERGY_TOTAL_KWH": DxsEnergyTotalKwh, "ENERGY_TODAY_WH": DxsEnergyTodayWh, "OPERATING_HOURS_H": DxsOperatingHoursH,
		"TYPE": DxsType, "SERIAL": DxsSerial, "NAME": DxsName,
		"FW_VERSION": DxsFwVersion, "HW_VERSION": DxsHwVersion, "UI_VERSION": DxsUiVersion, "PAR_VERSION": DxsParVersion,
	}
	for name, id := range want {
		if c.Dxs[name] != id {
			t.Errorf("dxs id %s: Go %d, JS %d", name, id, c.Dxs[name])
		}
	}
	if !reflect.DeepEqual(c.FastIDs, FastIDs) {
		t.Errorf("FastIDs: Go %v, JS %v", FastIDs, c.FastIDs)
	}
	if !reflect.DeepEqual(c.SlowIDs, SlowIDs) {
		t.Errorf("SlowIDs: Go %v, JS %v", SlowIDs, c.SlowIDs)
	}
	if !reflect.DeepEqual(c.IdentityIDs, IdentityIDs) {
		t.Errorf("IdentityIDs: Go %v, JS %v", IdentityIDs, c.IdentityIDs)
	}
	if !reflect.DeepEqual(c.PollIDs, PollIDs) {
		t.Errorf("PollIDs: Go %v, JS %v", PollIDs, c.PollIDs)
	}
	if !reflect.DeepEqual(c.AllIDs, AllIDs) {
		t.Errorf("AllIDs: Go %v, JS %v", AllIDs, c.AllIDs)
	}
	for code, label := range c.StatusLabels {
		n, err := strconv.Atoi(code)
		if err != nil {
			continue
		}
		if StatusLabels[n] != label {
			t.Errorf("status label %s: Go %q, JS %q", code, StatusLabels[n], label)
		}
	}
}

func TestDxsURLMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).DxsURL {
		if got := DxsURL(c.Scheme, c.Host, c.Port, c.Ids); got != c.URL {
			t.Errorf("DxsURL(%q,%q,%d,%v) = %q, JS %q", c.Scheme, c.Host, c.Port, c.Ids, got, c.URL)
		}
	}
}

func TestDecodeMatchesTheJSModule(t *testing.T) {
	for _, c := range loadVectors(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Decode([]byte(c.Raw))
			if c.Decode == nil {
				if got != nil {
					t.Fatalf("JS null, Go %+v", got)
				}
				return
			}
			if got == nil {
				t.Fatalf("JS %+v, Go nil", c.Decode)
			}
			wantPv := c.Decode.Reading.PvPowerKw
			gotPv, hasPv := got.Reading["pv_power_kw"]
			switch {
			case wantPv == nil && hasPv:
				t.Errorf("pv_power_kw: JS abwesend, Go %v", gotPv)
			case wantPv != nil && (!hasPv || gotPv != *wantPv):
				t.Errorf("pv_power_kw: Go %v (%v), JS %v", gotPv, hasPv, *wantPv)
			}
			checkMeta(t, got.Meta, c.Decode.Meta)
		})
	}
}

func eqp(got *float64, want *float64) bool {
	if got == nil || want == nil {
		return got == nil && want == nil
	}
	return *got == *want
}

func eqs(got string, want *string) bool {
	if want == nil {
		return got == ""
	}
	return got == *want
}

func checkMeta(t *testing.T, m Meta, w jsMeta) {
	t.Helper()
	checks := []struct {
		name string
		ok   bool
	}{
		{"ac_kw", eqp(m.AcKw, w.AcKw)},
		{"dc_kw", eqp(m.DcKw, w.DcKw)},
		{"dc1_v", eqp(m.DC1.VoltageV, w.DC1V)}, {"dc1_a", eqp(m.DC1.CurrentA, w.DC1A)}, {"dc1_w", eqp(m.DC1.PowerW, w.DC1W)},
		{"dc2_v", eqp(m.DC2.VoltageV, w.DC2V)}, {"dc2_a", eqp(m.DC2.CurrentA, w.DC2A)}, {"dc2_w", eqp(m.DC2.PowerW, w.DC2W)},
		{"dc3_v", eqp(m.DC3.VoltageV, w.DC3V)}, {"dc3_a", eqp(m.DC3.CurrentA, w.DC3A)}, {"dc3_w", eqp(m.DC3.PowerW, w.DC3W)},
		{"l1_v", eqp(m.L1.VoltageV, w.L1V)}, {"l1_a", eqp(m.L1.CurrentA, w.L1A)}, {"l1_w", eqp(m.L1.PowerW, w.L1W)},
		{"l2_v", eqp(m.L2.VoltageV, w.L2V)}, {"l2_a", eqp(m.L2.CurrentA, w.L2A)}, {"l2_w", eqp(m.L2.PowerW, w.L2W)},
		{"l3_v", eqp(m.L3.VoltageV, w.L3V)}, {"l3_a", eqp(m.L3.CurrentA, w.L3A)}, {"l3_w", eqp(m.L3.PowerW, w.L3W)},
		{"freq_hz", eqp(m.FreqHz, w.FreqHz)}, {"cos_phi", eqp(m.CosPhi, w.CosPhi)},
		{"limitation_pct", eqp(m.LimitationPct, w.LimitationPct)}, {"status", eqp(m.Status, w.Status)},
		{"energy_total_kwh", eqp(m.EnergyTotalKwh, w.EnergyTotalKwh)}, {"energy_today_kwh", eqp(m.EnergyTodayKwh, w.EnergyTodayKwh)},
		{"operating_hours_h", eqp(m.OperatingHoursH, w.OperatingHoursH)},
		{"type", eqs(m.Type, w.Type)}, {"serial", eqs(m.Serial, w.Serial)}, {"name", eqs(m.Name, w.Name)},
		{"fw_version", eqs(m.FwVersion, w.FwVersion)}, {"hw_version", eqs(m.HwVersion, w.HwVersion)},
		{"ui_version", eqs(m.UiVersion, w.UiVersion)}, {"par_version", eqs(m.ParVersion, w.ParVersion)},
		{"status_text", eqs(m.StatusText, w.StatusText)},
	}
	for _, c := range checks {
		if !c.ok {
			t.Errorf("meta.%s weicht ab: Go %+v, JS %+v", c.name, m, w)
		}
	}
}
