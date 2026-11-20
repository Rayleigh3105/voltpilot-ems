package messwerte

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// The planning costs of a measurement plan are the shared contract
// docs/contracts/v2/measurement-budget-vectors.json (AP-07 E10/A16); the
// packaging tool copies it byte for byte next to the catalog of both box types.

//go:embed measurement-budget-vectors.json
var budgetJSON []byte

type budgetFamilie struct {
	RequestCostMs   float64 `json:"request_cost_ms"`
	UnitsPerRequest float64 `json:"units_per_request"`
	Inbound         bool    `json:"inbound"`
}

type budgetVertrag struct {
	Limits struct {
		SamplesSoft float64 `json:"samples_soft"`
		SamplesHard float64 `json:"samples_hard"`
		Requests    float64 `json:"requests"`
		DutyPct     float64 `json:"duty_pct"`
	} `json:"limits"`
	DefaultFamily   string                   `json:"default_family"`
	FamilyOverrides map[string]string        `json:"family_overrides"`
	Aliases         map[string]string        `json:"aliases"`
	Families        map[string]budgetFamilie `json:"families"`
}

var budget = func() budgetVertrag {
	var v budgetVertrag
	if err := json.Unmarshal(budgetJSON, &v); err != nil {
		panic(fmt.Sprintf("messwerte: Budget-Vertrag unlesbar: %v", err))
	}
	return v
}()

// Grenzen are the hard limits of a plan and of the running window.
var Grenzen = struct {
	SamplesPerMinute, RequestsPerMinute, DutyPercent float64
}{budget.Limits.SamplesHard, budget.Limits.Requests, budget.Limits.DutyPct}

func costFamily(family, sourceKind string) budgetFamilie {
	key := budget.DefaultFamily
	if k, ok := budget.FamilyOverrides[family]; ok {
		key = k
	} else if k, ok := budget.Aliases[sourceKind]; ok {
		key = k
	} else if strings.HasPrefix(sourceKind, "modbus") {
		key = "modbus"
	}
	return budget.Families[key]
}

// RequestCostMs is the planned bus time of one request.
func RequestCostMs(family, sourceKind string) float64 {
	return costFamily(family, sourceKind).RequestCostMs
}

// requestsForUnits is how many requests units of a family take (inbound: 0).
func requestsForUnits(family, sourceKind string, units int) int {
	row := costFamily(family, sourceKind)
	if row.Inbound {
		return 0
	}
	return int(math.Ceil(float64(units) / row.UnitsPerRequest))
}

// Metriken are a plan's load per minute.
type Metriken struct {
	SamplesPerMinute  float64 `json:"samplesPerMinute"`
	RequestsPerMinute float64 `json:"requestsPerMinute"`
	DutyPercent       float64 `json:"dutyPercent"`
	Warning           *string `json:"warning"` // null when below the soft limit
}

// budgetMetrics judges samples, requests and bus time per minute: the reason
// a plan is refused ("" = within budget) and the metrics.
func budgetMetrics(samples, requests, dutyMs float64) (string, Metriken) {
	duty := dutyMs / 600
	m := Metriken{SamplesPerMinute: samples, RequestsPerMinute: requests, DutyPercent: duty}
	if samples >= budget.Limits.SamplesSoft-1e-9 {
		w := "budget_warning_samples"
		m.Warning = &w
	}
	switch {
	case samples > Grenzen.SamplesPerMinute+1e-9:
		return "budget_samples", m
	case requests > Grenzen.RequestsPerMinute+1e-9:
		return "budget_requests", m
	case duty > Grenzen.DutyPercent+1e-9:
		return "budget_duty_cycle", m
	}
	return "", m
}
