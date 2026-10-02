package guards

import (
	"math"
	"testing"
)

// MiSpeL MP-45 (Kasten W1 = D, Option B held ready): the strict reading of the
// EEG Ausschliesslichkeit - „kein Verbrauch im Stromspeicher ..., waehrend es
// gleichzeitig einen Netzbezug gibt" (Festlegung MiSpeL, Anlage 1 S. 11). The
// clamp holds charge to the MEASURED surplus pv - load (+ tolerance), on top of
// the FK3 clamp, and never charges blind.

func strictLimits(tolKw float64) Limits {
	l := limits
	l.SolarOnlyCharge = true
	l.StrictExclusivity = true
	l.StrictToleranceKw = tolKw
	return l
}

func TestStrictExclusivityClampsChargeToMeasuredSurplus(t *testing.T) {
	cases := []struct {
		name         string
		cmd, pv, ld  float64
		tolKw        float64
		want         float64
		strictBiting bool
	}{
		// FK3 alone would charge the full 3 kW PV while the house imports 1 kW.
		{"cloudy: pv below load, no charge", 3, 3, 4, 0, 0, true},
		{"surplus caps the charge", 5, 8, 4, 0, 4, true},
		{"command below the surplus passes", 2, 8, 4, 0, 2, false},
		{"tolerance 1 kW (0.25 kWh per quarter hour)", 2, 3, 3.5, 1, 0.5, true},
		{"negative tolerance counts as 0", 2, 3, 3.5, -1, 0, true},
		{"NaN tolerance counts as 0", 2, 3, 3.5, math.NaN(), 0, true},
		{"discharge is never touched", -3, 0, 4, 0, -3, false},
		{"unknown load: no charge (never blind)", 3, 8, math.NaN(), 0, 0, true},
		{"unknown pv: no charge (never blind)", 3, math.NaN(), 1, 0, 0, false}, // FK3 bites first
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := Reading{SocPct: 50, PvKw: c.pv, LoadKw: c.ld, GridLimitKw: math.NaN()}
			got, stages := ClampTraced(c.cmd, strictLimits(c.tolKw), r)
			if got != c.want {
				t.Fatalf("Clamp(%v) = %v, want %v (stages %+v)", c.cmd, got, c.want, stages)
			}
			bit := false
			for _, s := range stages {
				if s.Stage == StageStrictExclusivity {
					bit = true
				}
			}
			if bit != c.strictBiting {
				t.Fatalf("strict stage reported = %v, want %v (stages %+v)", bit, c.strictBiting, stages)
			}
		})
	}
}

// Without the switch the chain is byte-for-byte FK3: the same cloudy reading
// charges the full measured PV while the house imports.
func TestStrictExclusivityOffIsFK3(t *testing.T) {
	l := limits
	l.SolarOnlyCharge = true
	l.StrictToleranceKw = 5 // ignored without StrictExclusivity
	r := Reading{SocPct: 50, PvKw: 3, LoadKw: 4, GridLimitKw: math.NaN()}
	if got := Clamp(3, l, r); got != 3 {
		t.Fatalf("FK3 must charge the produced PV, got %v", got)
	}
}

// With the clamp on, the predicted grid power of a charging setpoint never
// shows an import beyond the tolerance - also after the §14a export
// correction, which may RAISE a charge but only to pv - load - limit.
func TestStrictExclusivityNeverImportsWhileCharging(t *testing.T) {
	for _, pv := range []float64{0, 1.5, 3, 4, 6, 10} {
		for _, ld := range []float64{0.5, 2, 4, 7} {
			for _, limit := range []float64{math.NaN(), 3} {
				for _, cmd := range []float64{0.5, 2, 5, 20} {
					r := Reading{SocPct: 50, PvKw: pv, LoadKw: ld, GridLimitKw: limit}
					got := Clamp(cmd, strictLimits(0), r)
					if got > 0 && ld+got-pv > 1e-9 {
						t.Fatalf("pv %v load %v limit %v cmd %v: charge %v imports %v kW",
							pv, ld, limit, cmd, got, ld+got-pv)
					}
				}
			}
		}
	}
}
