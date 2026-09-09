package guards

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// Die WAECHTER-Haelfte des Schutz-/Grenzbausteins (P5c, Konzept
// vp-deye-diybms-luecke-l5 §3.2b/§3.3): die BMS-Huelle als Kappe ueber der
// ganzen Guard-Kette.
//
// Die Faelle stehen in docs/contracts/v2/limit-protection-vectors.json (Block
// `waechter`) und werden hier PER PFAD gelesen, nicht abgeschrieben - dieselbe
// Datei, aus der die Node-RED-Seite ihre Treppen faehrt. So kann der Waechter
// keine andere Grenze klemmen, als die Box meldet.

type bmsVectorFile struct {
	Waechter []bmsVector `json:"waechter"`
}

type bmsVector struct {
	Name      string  `json:"name"`
	Why       string  `json:"why"`
	CommandKw float64 `json:"befehl_kw"`
	Band      struct {
		MaxChargeKw    float64 `json:"max_charge_kw"`
		MaxDischargeKw float64 `json:"max_discharge_kw"`
	} `json:"nennband"`
	Messung *struct {
		PvKw        float64 `json:"pv_kw"`
		LoadKw      float64 `json:"load_kw"`
		GridLimitKw float64 `json:"grid_limit_kw"`
	} `json:"messung"`
	Bms struct {
		ChargeLimitA     *float64 `json:"charge_limit_a"`
		DischargeLimitA  *float64 `json:"discharge_limit_a"`
		ChargeBlocked    bool     `json:"charge_blocked"`
		DischargeBlocked bool     `json:"discharge_blocked"`
		PackVoltageV     *float64 `json:"pack_voltage_v"`
	} `json:"bms"`
	ExpectedKw    float64 `json:"erwartet_kw"`
	ExpectedStage *string `json:"erwartet_stufe"`
}

func loadBmsVectors(t *testing.T) []bmsVector {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"limit-protection-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("shared vectors unreadable: %v", err)
	}
	var f bmsVectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("shared vectors unparseable: %v", err)
	}
	if len(f.Waechter) == 0 {
		t.Fatal("shared vectors declare no guard cases")
	}
	return f.Waechter
}

// TestBmsEnvelopeVectors drives every shared guard vector through the REAL
// chain. The amperes are converted with BmsKw, exactly as the agent does.
func TestBmsEnvelopeVectors(t *testing.T) {
	for _, v := range loadBmsVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			volt := math.NaN()
			if v.Bms.PackVoltageV != nil {
				volt = *v.Bms.PackVoltageV
			}
			amps := func(a *float64) float64 {
				if a == nil {
					return math.NaN()
				}
				return BmsKw(*a, volt)
			}
			l := Limits{
				MaxChargeKw:    v.Band.MaxChargeKw,
				MaxDischargeKw: v.Band.MaxDischargeKw,
				SocMinPct:      math.Inf(-1),
				SocMaxPct:      math.Inf(1),
				Bms: &BmsEnvelope{
					ChargeKw:         amps(v.Bms.ChargeLimitA),
					DischargeKw:      amps(v.Bms.DischargeLimitA),
					ChargeBlocked:    v.Bms.ChargeBlocked,
					DischargeBlocked: v.Bms.DischargeBlocked,
				},
			}
			r := Reading{SocPct: Unknown(), PvKw: Unknown(), LoadKw: Unknown(),
				GridLimitKw: Unknown()}
			if v.Messung != nil {
				r = Reading{SocPct: Unknown(), PvKw: v.Messung.PvKw,
					LoadKw: v.Messung.LoadKw, GridLimitKw: v.Messung.GridLimitKw}
			}

			got, stages := ClampTraced(v.CommandKw, l, r)
			if math.Abs(got-v.ExpectedKw) > 1e-6 {
				t.Fatalf("%s: got %.3f kW, want %.3f kW - %s",
					v.Name, got, v.ExpectedKw, v.Why)
			}
			last := ""
			if len(stages) > 0 {
				last = stages[len(stages)-1].Stage
			}
			want := ""
			if v.ExpectedStage != nil {
				want = *v.ExpectedStage
			}
			if last != want {
				t.Fatalf("%s: last stage %q, want %q - %s", v.Name, last, want, v.Why)
			}
		})
	}
}

// TestBmsKwHonesty pins the conversion's two honest edges: no voltage means NO
// power cap (never a guessed nominal voltage), and zero amperes are zero
// kilowatts at any voltage.
func TestBmsKwHonesty(t *testing.T) {
	if got := BmsKw(22, math.NaN()); !math.IsNaN(got) {
		t.Fatalf("a limit without a measured pack voltage must stay unknown, got %v", got)
	}
	if got := BmsKw(22, 0); !math.IsNaN(got) {
		t.Fatalf("a zero pack voltage is not a measurement, got %v", got)
	}
	if got := BmsKw(0, math.NaN()); got != 0 {
		t.Fatalf("0 A are 0 kW at ANY voltage, got %v", got)
	}
	if got := BmsKw(22, 560); math.Abs(got-12.32) > 1e-9 {
		t.Fatalf("22 A at 560 V = 12.32 kW, got %v", got)
	}
	if got := BmsKw(math.NaN(), 560); !math.IsNaN(got) {
		t.Fatalf("an absent limit imposes no cap, got %v", got)
	}
}

// TestBmsEnvelopeSilenceChangesNothing is THE regression this pointer field
// exists for: a plant without a protection block - or one whose block went
// silent - must clamp exactly as it did before P5c. A zero value that read as
// "0 kW allowed" would shut down every such plant.
func TestBmsEnvelopeSilenceChangesNothing(t *testing.T) {
	l := Limits{MaxChargeKw: 10, MaxDischargeKw: 10, SocMinPct: 5, SocMaxPct: 95}
	r := Reading{SocPct: 50, PvKw: 8, LoadKw: 2, GridLimitKw: Unknown()}

	for _, tc := range []struct {
		name string
		bms  *BmsEnvelope
	}{
		{"nil envelope", nil},
		{"envelope that says nothing", &BmsEnvelope{
			ChargeKw: math.NaN(), DischargeKw: math.NaN()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			with := l
			with.Bms = tc.bms
			for _, cmd := range []float64{7, -7, 0, 99, -99} {
				want := Clamp(cmd, l, r)
				got, stages := ClampTraced(cmd, with, r)
				if got != want {
					t.Fatalf("command %.1f: %.3f with envelope vs %.3f without", cmd, got, want)
				}
				for _, s := range stages {
					if s.Stage == StageBmsLimit {
						t.Fatalf("command %.1f: a silent envelope must not report a stage", cmd)
					}
				}
			}
		})
	}
}

// TestBmsEnvelopeOnlyRestricts: the envelope is a CAP. It never raises a
// setpoint, never widens the rated band, and never releases a SoC bound.
func TestBmsEnvelopeOnlyRestricts(t *testing.T) {
	l := Limits{
		MaxChargeKw: 10, MaxDischargeKw: 10, SocMinPct: 5, SocMaxPct: 95,
		// 1000 kW in both directions - far beyond the rated band.
		Bms: &BmsEnvelope{ChargeKw: 1000, DischargeKw: 1000},
	}
	r := Reading{SocPct: 96, PvKw: Unknown(), LoadKw: Unknown(), GridLimitKw: Unknown()}

	if got := Clamp(50, l, r); got != 0 {
		t.Fatalf("a generous envelope must not release the SoC ceiling: %v", got)
	}
	r.SocPct = 50
	if got := Clamp(50, l, r); got != 10 {
		t.Fatalf("a generous envelope must not widen the rated band: %v", got)
	}
}

// TestBmsBlockIsZeroInBothDirections: a hard stop is a STATEMENT and binds,
// while the opposite direction stays untouched - a full pack may still
// discharge, an empty one may still charge.
func TestBmsBlockIsZeroInBothDirections(t *testing.T) {
	r := Reading{SocPct: 50, PvKw: Unknown(), LoadKw: Unknown(), GridLimitKw: Unknown()}
	base := Limits{MaxChargeKw: 10, MaxDischargeKw: 10, SocMinPct: 5, SocMaxPct: 95}

	chargeBlocked := base
	chargeBlocked.Bms = &BmsEnvelope{ChargeKw: math.NaN(), DischargeKw: math.NaN(),
		ChargeBlocked: true}
	if got := Clamp(8, chargeBlocked, r); got != 0 {
		t.Fatalf("a charge block is 0 kW, got %v", got)
	}
	if got := Clamp(-8, chargeBlocked, r); got != -8 {
		t.Fatalf("a charge block must not touch discharge, got %v", got)
	}

	dischargeBlocked := base
	dischargeBlocked.Bms = &BmsEnvelope{ChargeKw: math.NaN(), DischargeKw: math.NaN(),
		DischargeBlocked: true}
	if got := Clamp(-8, dischargeBlocked, r); got != 0 {
		t.Fatalf("a discharge block is 0 kW, got %v", got)
	}
	if got := Clamp(8, dischargeBlocked, r); got != 8 {
		t.Fatalf("a discharge block must not touch charge, got %v", got)
	}
}
