package guards

// AP-15 Folge (PV counted once): wherever a charge park runs, the solar-only
// branch of the grid-charge ceiling counts the park first. The examples of
// the finding in PR 1061, and the property that the rule only ever lowers.

import (
	"math/rand"
	"testing"
)

// Box Verwaltung co-controls at its own meter: share 57 kW, 20 kW of building
// load, 30 kW of PV. Cold start: the first sample shows −10 kW at the feeder,
// the park was granted 57 kW it does not draw yet - the battery may take
// 57 − (−10 − 0 + 57) = 10 kW of its PV, not all 30 (that was +20 kW over the
// share). Before the park decided (ParkOffen) nothing beyond the measured
// charge; with the vehicles at 45 kW drawn, the rest of 22 kW; a feeder that
// leaves more than the PV never lets it charge from the grid.
func TestPvEinmalAmEigenenZaehler(t *testing.T) {
	for name, tc := range map[string]struct {
		in   Netzladen
		want float64
	}{
		"Kaltstart, Park zugeteilt":  {Netzladen{Vorrang: true, Fresh: true, PlanableKw: 57, GridKw: -10, ReservedKw: 57, PvKw: 30}, 10},
		"Kaltstart, Park noch offen": {Netzladen{Vorrang: true, Fresh: true, ParkOffen: true, PlanableKw: 57, GridKw: -10, PvKw: 30}, 0},
		"der Rest":                   {Netzladen{Vorrang: true, Fresh: true, PlanableKw: 57, GridKw: 57, BattChargeKw: 22, PvKw: 30}, 22},
		"nie aus dem Netz":           {Netzladen{Vorrang: true, Fresh: true, PlanableKw: 57, GridKw: 0, PvKw: 30}, 30},
		"PV unbekannt":               {Netzladen{Vorrang: true, Fresh: true, PlanableKw: 57, GridKw: 0, PvKw: Unknown()}, 0},
		"ohne Vorrang wie vorher":    {Netzladen{Fresh: true, PlanableKw: 57, GridKw: -10, ReservedKw: 57, PvKw: 30}, 30},
	} {
		d := NetzladenDeckelFuer(tc.in)
		if d.DeckelKw != tc.want || d.Regelt {
			t.Fatalf("%s: %+v, want %.1f kW (solar-only stage)", name, d, tc.want)
		}
	}
}

// Blind, the loop keeps the last sample: Halle 1 leads behind 90 kW planable,
// the last sample showed 30 kW of building load, 70 kW of charge park and
// 10 kW of PV (90 kW at the connection point) - the park's figure counted the
// PV, so the battery takes none of it while the park holds that figure. Once
// the park's grant fell to 20 kW (its blind figure), the 50 kW it no longer
// draws are credited and the battery gets its PV back. Before the first
// sample there is nothing to keep: the PV, as before.
func TestPvEinmalBlindAufDerLetztenMessung(t *testing.T) {
	letzte := Netzladen{Vorrang: true, Fuehrt: true, Limit: true, Nachlauf: true, PlanableKw: 90, GridKw: 90, PvKw: 10}
	for name, tc := range map[string]struct {
		in   Netzladen
		want float64
	}{
		"Park haelt 70 kW":    {letzte, 0},
		"Park auf 20 kW":      {func() Netzladen { in := letzte; in.ParkUnterKw = 50; return in }(), 10},
		"Park auf 65 kW":      {func() Netzladen { in := letzte; in.ParkUnterKw = 5; return in }(), 5},
		"ohne Grenze":         {func() Netzladen { in := letzte; in.Limit = false; return in }(), 10},
		"vor der 1. Messung":  {func() Netzladen { in := letzte; in.Nachlauf = false; return in }(), 10},
		"mitsteuernd, Anteil": {Netzladen{Vorrang: true, Nachlauf: true, PlanableKw: 57, GridKw: 57, BattChargeKw: 22, ParkUnterKw: 8, PvKw: 30}, 30},
	} {
		d := NetzladenDeckelFuer(tc.in)
		if d.DeckelKw != tc.want || d.Regelt {
			t.Fatalf("%s: %+v, want %.1f kW", name, d, tc.want)
		}
	}
}

// V5: counting the park first only ever LOWERS the ceiling - never above
// the ceiling of the same input without it (the solar-only clamp, or the
// leading box's fresh loop, untouched), never below 0, never above the PV
// wherever the solar-only branch answers, never a different stage.
func TestEigenschaftPvEinmalSenktNur(t *testing.T) {
	rng := rand.New(rand.NewSource(1061))
	gesenkt := 0
	for i := 0; i < 20000; i++ {
		in := Netzladen{Fuehrt: rng.Intn(3) == 0, Fresh: rng.Intn(2) == 0, Limit: rng.Intn(4) > 0,
			PlanableKw: rng.Float64() * 500, GridKw: rng.Float64()*600 - 100, BattChargeKw: rng.Float64()*120 - 5,
			ReservedKw: rng.Float64()*80 - 5, ParkOffen: rng.Intn(4) == 0, PvKw: rng.Float64() * 100}
		if rng.Intn(5) == 0 {
			in.PvKw = Unknown()
		}
		heute := NetzladenDeckelFuer(in)
		in.Vorrang, in.Nachlauf, in.ParkUnterKw = true, rng.Intn(2) == 0, rng.Float64()*120-5
		d := NetzladenDeckelFuer(in)
		if d.DeckelKw > heute.DeckelKw || d.DeckelKw < 0 || d.Regelt != heute.Regelt {
			t.Fatalf("%+v: %.3f against %.3f", in, d.DeckelKw, heute.DeckelKw)
		}
		if !d.Regelt && known(in.PvKw) && d.DeckelKw > round3(in.PvKw) {
			t.Fatalf("%+v: %.3f above the PV", in, d.DeckelKw)
		}
		if d.DeckelKw < heute.DeckelKw {
			gesenkt++
		}
	}
	if gesenkt < 2000 {
		t.Fatalf("the park came first in only %d evaluations", gesenkt)
	}
}
