package guards

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// intentVectors is docs/contracts/v2/native-intent-window-vectors.json. Read BY
// PATH on purpose: moving the file must break this test, not skip it.
type intentVectors struct {
	Limits struct {
		MaxChargeKw    float64 `json:"max_charge_kw"`
		MaxDischargeKw float64 `json:"max_discharge_kw"`
		SocMinPct      float64 `json:"soc_min_pct"`
		SocMaxPct      float64 `json:"soc_max_pct"`
	} `json:"limits"`
	Faelle []struct {
		Name            string   `json:"name"`
		PlannedKw       float64  `json:"planned_kw"`
		Flags           []string `json:"flags"`
		SolarOnlyCharge bool     `json:"solar_only_charge"`
		FloorPct        *float64 `json:"effective_floor_soc_pct"`
		Kind            string   `json:"kind"`
		Word            string   `json:"word"`
		NeedsWindow     bool     `json:"needs_window"`
		PlanMinKw       float64  `json:"plan_min_kw"`
		PlanMaxKw       float64  `json:"plan_max_kw"`
		Reading         struct {
			SocPct      *float64 `json:"soc_pct"`
			PvKw        *float64 `json:"pv_kw"`
			LoadKw      *float64 `json:"load_kw"`
			GridLimitKw *float64 `json:"grid_limit_kw"`
		} `json:"reading"`
		WindowMinKw float64 `json:"window_min_kw"`
		WindowMaxKw float64 `json:"window_max_kw"`
	} `json:"faelle"`
}

func loadIntentVectors(t *testing.T) intentVectors {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"native-intent-window-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("contract vectors: %v", err)
	}
	var v intentVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("contract vectors: %v", err)
	}
	if len(v.Faelle) == 0 {
		t.Fatal("the contract vectors carry no cases")
	}
	return v
}

func vecFlags(t *testing.T, names []string) IntentFlags {
	t.Helper()
	var f IntentFlags
	for _, n := range names {
		switch n {
		case "charge_from_surplus_only":
			f.ChargeFromSurplusOnly = true
		case "charge_surplus_to_battery":
			f.ChargeSurplusToBattery = true
		case "cover_load_from_battery":
			f.CoverLoadFromBattery = true
		case "limit_discharge_to_load":
			f.LimitDischargeToLoad = true
		case "unplanned_load_discharge":
			f.UnplannedLoadDischarge = true
		case "deficit_cover":
			f.DeficitCover = true
		default:
			t.Fatalf("unknown flag %q in the vectors", n)
		}
	}
	return f
}

func orNaN(p *float64) float64 {
	if p == nil {
		return math.NaN()
	}
	return *p
}

// TestIntentVectors drives every contract case through the REAL functions.
func TestIntentVectors(t *testing.T) {
	v := loadIntentVectors(t)
	kinds := map[string]bool{}
	for _, c := range v.Faelle {
		t.Run(c.Name, func(t *testing.T) {
			in := IntentFor(c.PlannedKw, vecFlags(t, c.Flags), v.Limits.MaxChargeKw, v.Limits.MaxDischargeKw)
			if in.Kind != c.Kind || in.Word != c.Word || in.NeedsWindow != c.NeedsWindow {
				t.Fatalf("intent = %+v, want kind %s word %q needs_window %v", in, c.Kind, c.Word, c.NeedsWindow)
			}
			if in.MinKw != c.PlanMinKw || in.MaxKw != c.PlanMaxKw {
				t.Fatalf("plan window = [%v ; %v], want [%v ; %v]", in.MinKw, in.MaxKw, c.PlanMinKw, c.PlanMaxKw)
			}
			l := Limits{MaxChargeKw: v.Limits.MaxChargeKw, MaxDischargeKw: v.Limits.MaxDischargeKw,
				SocMinPct: v.Limits.SocMinPct, SocMaxPct: v.Limits.SocMaxPct, SolarOnlyCharge: c.SolarOnlyCharge}
			r := Reading{SocPct: orNaN(c.Reading.SocPct), PvKw: orNaN(c.Reading.PvKw),
				LoadKw: orNaN(c.Reading.LoadKw), GridLimitKw: orNaN(c.Reading.GridLimitKw)}
			w := ClipWindow(in, l, r, c.FloorPct)
			if w.MinKw != c.WindowMinKw || w.MaxKw != c.WindowMaxKw {
				t.Fatalf("clipped window = [%v ; %v], want [%v ; %v]", w.MinKw, w.MaxKw, c.WindowMinKw, c.WindowMaxKw)
			}
		})
		kinds[c.Kind] = true
	}
	for _, k := range []string{IntentKindSelfConsumption, IntentKindSurplusCharge, IntentKindCoverLoad,
		IntentKindThrottled, IntentKindGridCharge, IntentKindHold, IntentKindSell} {
		if !kinds[k] {
			t.Errorf("the vectors never reach kind %s", k)
		}
	}
}

// A window is only as safe as the chain that clipped it: for any plan window and
// any reading, each clipped bound lies inside what Clamp allows for a setpoint
// on the device side, and the window never inverts.
func TestClipWindowNeverEscapesTheRatedBandOrInverts(t *testing.T) {
	l := Limits{MaxChargeKw: 10, MaxDischargeKw: 8, SocMinPct: 5, SocMaxPct: 95, SolarOnlyCharge: true}
	floor := 20.0
	for _, planned := range []float64{-30, -8, -3, 0, 2, 9, 30} {
		for _, f := range []IntentFlags{{}, {ChargeFromSurplusOnly: true, ChargeSurplusToBattery: true},
			{CoverLoadFromBattery: true}, {ChargeSurplusToBattery: true}, {LimitDischargeToLoad: true},
			{ChargeFromSurplusOnly: true, ChargeSurplusToBattery: true, CoverLoadFromBattery: true}} {
			for _, soc := range []float64{3, 19, 50, 96, math.NaN()} {
				in := IntentFor(planned, f, l.MaxChargeKw, l.MaxDischargeKw)
				w := ClipWindow(in, l, Reading{SocPct: soc, PvKw: 4, LoadKw: 2, GridLimitKw: math.NaN()}, &floor)
				if w.MinKw > w.MaxKw || w.MinKw < -8 || w.MaxKw > 10 {
					t.Fatalf("planned %v flags %+v soc %v -> window %+v escapes", planned, f, soc, w)
				}
				if soc >= 95 && w.MaxKw > 0 {
					t.Fatalf("a full battery may not keep an open charge side: %+v", w)
				}
				if soc <= floor && w.MinKw < 0 {
					t.Fatalf("at the platform floor the discharge side must close: %+v", w)
				}
			}
		}
	}
}

func TestNativeLeversHas(t *testing.T) {
	var none *NativeLevers
	if none.Has(NativeIntentCoverLoad) {
		t.Fatal("an unreported lever set has nothing")
	}
	l := &NativeLevers{Intents: []string{NativeIntentSurplusCharge}}
	if !l.Has(NativeIntentSurplusCharge) || l.Has(NativeIntentSelfConsumption) {
		t.Fatalf("Has: %+v", l)
	}
}
