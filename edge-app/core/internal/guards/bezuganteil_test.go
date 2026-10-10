package guards

// AP-15 IP-19: the battery's grid-charge ceiling with a share (V3) - the
// leading box's loop, the blind rule "laedt nicht aus dem Netz" and the
// property that the ceiling only ever lowers a charge.

import (
	"math/rand"
	"testing"
)

// R3 Schritt 2: Box Halle 1 blind (or without a known connection limit, or
// co-controlling) charges only from its own measured PV - without sun, and
// without a PV reading, nothing at all.
func TestR3FuehrendeBoxBlindLaedtNichtAusDemNetz(t *testing.T) {
	for name, tc := range map[string]struct {
		in   Netzladen
		want float64
	}{
		"fuehrt blind, keine Sonne":   {Netzladen{Fuehrt: true, Limit: true, PlanableKw: 495, GridKw: 367, PvKw: 0}, 0},
		"fuehrt blind, 45 kW Sonne":   {Netzladen{Fuehrt: true, Limit: true, PlanableKw: 495, GridKw: 367, PvKw: 45}, 45},
		"fuehrt blind, PV unbekannt":  {Netzladen{Fuehrt: true, Limit: true, PlanableKw: 495, GridKw: 367, PvKw: Unknown()}, 0},
		"fuehrt frisch ohne Grenze":   {Netzladen{Fuehrt: true, Fresh: true, GridKw: 100, PvKw: 12}, 12},
		"steuert mit, frisch":         {Netzladen{Fresh: true, Limit: true, PlanableKw: 495, GridKw: 100, PvKw: 7}, 7},
		"ohne Rolle wie steuert mit":  {Netzladen{Fresh: true, Limit: true, PlanableKw: 495, GridKw: 100, PvKw: Unknown()}, 0},
		"PV negativ (Eigenverbrauch)": {Netzladen{PvKw: -0.2}, 0},
	} {
		d := NetzladenDeckelFuer(tc.in)
		if d.DeckelKw != tc.want || d.Regelt {
			t.Fatalf("%s: %+v, want solar-only %.1f kW", name, d, tc.want)
		}
	}
}

// The leading box with a fresh sample regulates the charge against the
// connection limit: planable − (grid − measured charge + what the charge park
// was granted but does not draw yet). R3 at 10:00: 495 kW planable, 367 kW at
// the connection point, the battery idle, the charge park's 77 kW all drawn -
// 128 kW headroom; 30 kW charging already and 20 kW granted to cars not yet
// drawn: 495 − (367 − 30 + 20) = 138.
func TestFuehrendeBoxRegeltNetzladenGegenDieBezugsgrenze(t *testing.T) {
	for _, tc := range []struct {
		in   Netzladen
		want float64
	}{
		{Netzladen{Fuehrt: true, Fresh: true, Limit: true, PlanableKw: 495, GridKw: 367}, 128},
		{Netzladen{Fuehrt: true, Fresh: true, Limit: true, PlanableKw: 495, GridKw: 367, BattChargeKw: 30, ReservedKw: 20}, 138},
		{Netzladen{Fuehrt: true, Fresh: true, Limit: true, PlanableKw: 495, GridKw: 520}, 0},
		{Netzladen{Fuehrt: true, Fresh: true, Limit: true, PlanableKw: 495, GridKw: 300, BattChargeKw: -5, ReservedKw: -3}, 195},
	} {
		d := NetzladenDeckelFuer(tc.in)
		if d.DeckelKw != tc.want || !d.Regelt {
			t.Fatalf("%+v: %+v, want the loop %.1f kW", tc.in, d, tc.want)
		}
	}
}

// Mirror of V6: the ceiling only ever lowers a charge - it never discharges,
// never raises a charge, never touches a discharge or an idle battery.
func TestLowerChargeSenktNur(t *testing.T) {
	c := func(v float64) *float64 { return &v }
	for _, tc := range []struct {
		kw   float64
		ceil *float64
		want float64
	}{
		{60, c(40), 40},  // lowered to the ceiling
		{20, c(40), 20},  // below: untouched, never raised
		{-30, c(0), -30}, // a discharge passes unchanged
		{25, c(0), 0},    // no charge from the grid - not a discharge
		{0, c(0), 0},     // idle stays idle
		{60, nil, 60},    // no ceiling
		{60, c(-5), 0},   // a negative ceiling never turns into a discharge
	} {
		if got := LowerCharge(tc.kw, tc.ceil); got != tc.want {
			t.Fatalf("LowerCharge(%v, %v) = %v, want %v", tc.kw, tc.ceil, got, tc.want)
		}
	}
	rng := rand.New(rand.NewSource(19))
	for i := 0; i < 5000; i++ {
		kw := float64(rng.Intn(400) - 200)
		d := NetzladenDeckelFuer(Netzladen{Fuehrt: rng.Intn(2) == 0, Fresh: rng.Intn(2) == 0, Limit: rng.Intn(2) == 0,
			PlanableKw: float64(rng.Intn(600)), GridKw: float64(rng.Intn(800) - 200), BattChargeKw: float64(rng.Intn(100)),
			ReservedKw: float64(rng.Intn(80)), PvKw: float64(rng.Intn(150) - 10)})
		got := LowerCharge(kw, &d.DeckelKw)
		if got > kw || (kw <= 0 && got != kw) || (kw > 0 && got < 0) {
			t.Fatalf("LowerCharge(%v, %v) = %v - the guard widened, discharged or touched a discharge", kw, d.DeckelKw, got)
		}
	}
}
