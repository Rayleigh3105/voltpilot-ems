package guards

import (
	"math"
	"testing"
)

// ClampTraced must report exactly the stages that changed the value, with the
// contract's stage vocabulary, and its value must equal Clamp's (Clamp
// delegates, so this pins the delegation stays in place).
func TestClampTracedStageAttribution(t *testing.T) {
	cases := []struct {
		name    string
		command float64
		l       Limits
		r       Reading
		want    float64
		stages  []string
	}{
		{
			name: "within band, nothing bites",
			command: 10, l: limits, r: reading(50, 20, 5, 100),
			want: 10, stages: nil,
		},
		{
			name: "rated band clamps charge",
			command: 120, l: limits, r: reading(50, 20, 5, 100),
			want: 50, stages: []string{StageRatedBand},
		},
		{
			name: "soc window blocks charge at ceiling",
			command: 30, l: limits, r: reading(95, 20, 5, 100),
			want: 0, stages: []string{StageSocWindow},
		},
		{
			name: "solar-only caps at measured pv",
			command: 30,
			l:       Limits{MaxChargeKw: 50, MaxDischargeKw: 40, SocMinPct: 5, SocMaxPct: 95, SolarOnlyCharge: true},
			r:       reading(50, 6.2, 1, 100),
			want:    6.2, stages: []string{StageSolarOnlyCharge},
		},
		{
			name: "grid limit caps import",
			command: 30, l: limits, r: reading(50, 0, 0, 11),
			want: 11, stages: []string{StageGridLimit14a},
		},
		{
			name: "band clamps then solar-only bites too",
			command: 120,
			l:       Limits{MaxChargeKw: 50, MaxDischargeKw: 40, SocMinPct: 5, SocMaxPct: 95, SolarOnlyCharge: true},
			r:       reading(50, 6.2, 1, 100),
			want:    6.2, stages: []string{StageRatedBand, StageSolarOnlyCharge},
		},
		{
			name: "non-finite command reports rated band",
			command: math.NaN(), l: limits, r: reading(50, 20, 5, 100),
			want: 0, stages: []string{StageRatedBand},
		},
	}
	for _, c := range cases {
		got, trace := ClampTraced(c.command, c.l, c.r)
		if got != c.want {
			t.Errorf("%s: value %v, want %v", c.name, got, c.want)
		}
		if plain := Clamp(c.command, c.l, c.r); !(math.IsNaN(c.command) && plain == got) && plain != got {
			t.Errorf("%s: Clamp %v != ClampTraced %v", c.name, plain, got)
		}
		var stages []string
		for _, s := range trace {
			stages = append(stages, s.Stage)
		}
		if len(stages) != len(c.stages) {
			t.Errorf("%s: stages %v, want %v", c.name, stages, c.stages)
			continue
		}
		for i := range stages {
			if stages[i] != c.stages[i] {
				t.Errorf("%s: stages %v, want %v", c.name, stages, c.stages)
			}
		}
	}
}

// A dense sweep pins that Clamp and ClampTraced can never diverge - the traced
// chain IS the chain (Clamp delegates), and this guards a future refactor that
// forks the two.
func TestClampTracedEquivalenceSweep(t *testing.T) {
	lims := []Limits{
		limits,
		{MaxChargeKw: 2, MaxDischargeKw: 2, SocMinPct: 5, SocMaxPct: 95, SolarOnlyCharge: true},
		{MaxChargeKw: 50, MaxDischargeKw: 40, SocMinPct: 20, SocMaxPct: 80},
	}
	readings := []Reading{
		reading(50, 20, 5, 100),
		reading(95, 0, 10, 11),
		reading(5, 6.2, 1, 3),
		{SocPct: Unknown(), PvKw: Unknown(), LoadKw: Unknown(), GridLimitKw: Unknown()},
	}
	for _, l := range lims {
		for _, r := range readings {
			for kw := -130.0; kw <= 130.0; kw += 1.3 {
				plain := Clamp(kw, l, r)
				traced, _ := ClampTraced(kw, l, r)
				if plain != traced {
					t.Fatalf("divergence at kw=%v l=%+v r=%+v: %v != %v", kw, l, r, plain, traced)
				}
			}
		}
	}
}
