package guards

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// The shared contract vectors of the grid-side throttling slot
// (docs/contracts/v2/grid-target-vectors.json). The words, bounds and German
// sentences in that file are what Layer 1, the api and the portal bind to, so
// this side asserts that the rule in gridtarget.go IS the one written there.
type gridTargetVectors struct {
	Woerter map[string]string  `json:"woerter"`
	Grenzen map[string]float64 `json:"grenzen"`
	Gruende map[string]string  `json:"gruende"`
	Regel   struct {
		Gesund map[string]any `json:"gesund"`
		Faelle []struct {
			Name     string `json:"name"`
			Schritte []struct {
				NachS    float64        `json:"nach_s"`
				Slot     int            `json:"slot"`
				Aendern  map[string]any `json:"aendern"`
				Erwartet struct {
					Engage    bool     `json:"engage"`
					Proven    bool     `json:"proven"`
					Reason    string   `json:"reason"`
					TargetKw  *float64 `json:"target_kw"`
					Following *bool    `json:"following"`
					Hint      string   `json:"hint"`
					Ended     string   `json:"ended"`
				} `json:"erwartet"`
			} `json:"schritte"`
		} `json:"faelle"`
	} `json:"regel"`
}

func loadGridTargetVectors(t *testing.T) gridTargetVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2", "grid-target-vectors.json"))
	if err != nil {
		t.Fatalf("contract vectors: %v", err)
	}
	var v gridTargetVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("contract vectors: %v", err)
	}
	if len(v.Regel.Faelle) == 0 || len(v.Gruende) == 0 {
		t.Fatal("the contract vectors carry no cases")
	}
	return v
}

// gridTargetVocabulary is every code this file can put on a surface.
var gridTargetVocabulary = []string{
	GridTargetEngaged, GridTargetPending, GridTargetOff, GridTargetNoCurtailment, GridTargetPlanStale,
	GridTargetPlanDischarges, GridTargetNoLever, GridTargetOtherMode, GridTargetSharedControl, GridTargetForeignHolder,
	GridTargetNotAuthorized, GridTargetNoFloor, GridTargetSocOutside, GridTargetFloorReached,
	GridTargetStaleMeasurement, GridTargetNoReadback, GridTargetUnproven, GridTargetNotFollowing,
	GridTargetSlotEnd, GridTargetHintExhausted,
}

func TestGridTargetWordsBoundsAndSentencesMatchTheContract(t *testing.T) {
	v := loadGridTargetVectors(t)
	if v.Woerter["hebel"] != GridTargetLever || v.Woerter["battery_mode"] != GridTargetLever {
		t.Fatalf("the lever / battery_mode word: %v", v.Woerter)
	}
	bounds := map[string]float64{
		"ziel_kw":             GridTargetNullExportKw,
		"ziel_max_kw":         GridTargetMaxKw,
		"folge_band_kw":       GridTargetFollowBandKw,
		"folge_frist_s":       GridTargetFollowHold.Seconds(),
		"nachweis_frist_s":    gridTargetDefaultGrace.Seconds(),
		"reserve_abstand_pct": GridTargetFloorMarginPct,
		"lade_obergrenze_pct": GridTargetChargeCeilingPct,
	}
	for k, want := range bounds {
		if got, ok := v.Grenzen[k]; !ok || got != want {
			t.Errorf("grenzen.%s = %v, the rule uses %v", k, got, want)
		}
	}
	// The vocabulary is CLOSED on both sides: every code has the contract's
	// sentence, and the contract names no code this rule cannot produce.
	var got []string
	for code, text := range v.Gruende {
		got = append(got, code)
		if GridTargetReasonText(code) != text {
			t.Errorf("gruende.%s:\n contract %q\n     rule %q", code, text, GridTargetReasonText(code))
		}
	}
	want := append([]string{}, gridTargetVocabulary...)
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("vocabulary differs:\n contract %v\n     rule %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("vocabulary differs:\n contract %v\n     rule %v", got, want)
		}
	}
}

func gridTargetVectorInput(t *testing.T, base, change map[string]any) GridTargetInput {
	t.Helper()
	m := map[string]any{}
	for k, v := range base {
		m[k] = v
	}
	for k, v := range change {
		m[k] = v
	}
	num := func(k string) float64 {
		if m[k] == nil {
			return math.NaN()
		}
		f, ok := m[k].(float64)
		if !ok {
			t.Fatalf("%s is not a number: %v", k, m[k])
		}
		return f
	}
	flag := func(k string) bool {
		b, ok := m[k].(bool)
		if !ok {
			t.Fatalf("%s is not a boolean: %v", k, m[k])
		}
		return b
	}
	in := GridTargetInput{
		Enabled: flag("enabled"), PlanFresh: flag("plan_fresh"), CurtailmentWanted: flag("curtailment_wanted"),
		PlannedKw: num("planned_kw"), Lever: flag("lever"), OtherModeActive: flag("other_mode_active"),
		SharedControl: flag("shared_control"),
		HolderExempt:  flag("holder_exempt"), Authorized: flag("authorized"),
		MeasurementsFresh: flag("measurements_fresh"), ReadbackHealthy: flag("readback_healthy"),
		SocPct: num("soc_pct"), SocMinPct: num("soc_min_pct"), Proven: flag("proven"),
		GridKw: num("grid_kw"), BatteryKw: num("battery_kw"), OwnPvKw: num("own_pv_kw"),
	}
	if m["floor_pct"] != nil {
		f := num("floor_pct")
		in.FloorPct = &f
	}
	if s, ok := m["leader_refusal"].(string); ok {
		in.LeaderRefusal = s
	}
	return in
}

func TestGridTargetDecisionsMatchTheContractVectors(t *testing.T) {
	v := loadGridTargetVectors(t)
	for _, c := range v.Regel.Faelle {
		t.Run(c.Name, func(t *testing.T) {
			g := NewGridTargetMode(time.Duration(v.Grenzen["nachweis_frist_s"]) * time.Second)
			for i, s := range c.Schritte {
				slot := slotA.Add(time.Duration(s.Slot) * 15 * time.Minute)
				in := gridTargetVectorInput(t, v.Regel.Gesund, s.Aendern)
				in.SlotStart = slot
				d := g.Decide(slot.Add(time.Duration(s.NachS*float64(time.Second))), in)
				e := s.Erwartet
				if d.Engage != e.Engage || d.Proven != e.Proven || d.Reason != e.Reason || d.Ended != e.Ended || d.Hint != e.Hint {
					t.Fatalf("step %d: got engage=%v proven=%v reason=%q ended=%q hint=%q, want %+v",
						i, d.Engage, d.Proven, d.Reason, d.Ended, d.Hint, e)
				}
				if e.TargetKw != nil && d.TargetKw != *e.TargetKw {
					t.Fatalf("step %d: target %v, want %v", i, d.TargetKw, *e.TargetKw)
				}
				if e.Following != nil && (d.Following == nil || *d.Following != *e.Following) {
					t.Fatalf("step %d: following %v, want %v", i, d.Following, *e.Following)
				}
				if d.Text == "" || (d.Ended != "" && d.EndedText == "") {
					t.Fatalf("step %d: every outcome carries its sentence: %+v", i, d)
				}
			}
		})
	}
}
