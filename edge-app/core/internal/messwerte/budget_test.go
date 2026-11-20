package messwerte

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func vertragsPfad(t *testing.T) string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "contracts", "v2", "measurement-budget-vectors.json")
}

func TestTheEmbeddedBudgetIsTheContract(t *testing.T) {
	raw, err := os.ReadFile(vertragsPfad(t))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, budgetJSON) {
		t.Fatal("measurement-budget-vectors.json weicht vom Vertrag ab - package_edge_runtime.py ausfuehren")
	}
}

// The shared A16 vectors with the arithmetic of estimateSources.
func TestBudgetContractCases(t *testing.T) {
	raw, _ := os.ReadFile(vertragsPfad(t))
	var v struct {
		Cases []struct {
			ID      string `json:"id"`
			Sources []struct {
				Channels int `json:"channels"`
				CadenceS int `json:"cadence_s"`
				Blocks   []struct {
					SourceKind string `json:"source_kind"`
					Units      int    `json:"units"`
					Family     string `json:"family"`
				} `json:"blocks"`
			} `json:"sources"`
			Expected struct {
				Samples  float64 `json:"samples_per_minute"`
				Requests float64 `json:"requests_per_minute"`
				Duty     float64 `json:"duty_cycle_percent"`
				Soft     bool    `json:"soft_warning"`
				Hard     bool    `json:"hard_rejected"`
			} `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Cases) == 0 {
		t.Fatalf("Vertrag: %v", err)
	}
	r3 := func(x float64) float64 { return math.Floor(float64(x*1000)+0.5) / 1000 }
	for _, c := range v.Cases {
		var samples, requests, duty float64
		for _, s := range c.Sources {
			cycles := 60 / float64(s.CadenceS)
			samples += float64(s.Channels) * cycles
			for _, b := range s.Blocks {
				n := float64(requestsForUnits(b.Family, b.SourceKind, b.Units))
				requests += n * cycles
				duty += n * cycles * RequestCostMs(b.Family, b.SourceKind)
			}
		}
		reason, m := budgetMetrics(samples, requests, duty)
		if r3(m.SamplesPerMinute) != c.Expected.Samples || r3(m.RequestsPerMinute) != c.Expected.Requests ||
			r3(m.DutyPercent) != c.Expected.Duty || (m.Warning != nil) != c.Expected.Soft || (reason != "") != c.Expected.Hard {
			t.Errorf("%s: Go %+v %q, Vertrag %+v", c.ID, m, reason, c.Expected)
		}
	}
}
