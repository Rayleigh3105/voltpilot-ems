package lastmgmt

// AP-15 Folge of IP-28 finding 1 on the import side: a standing value proves
// no headroom. The share path reads the twin (BudgetAnteil, Netzpunkt); on a
// sample that repeats the grid value bit for bit it reads the charging and
// the battery charge of the sample on which the value last moved, never more
// than now - the park and the battery follow each release while a frozen
// meter does not show it. Today's tracker is untouched.

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

var swT0 = time.Date(2027, 6, 13, 23, 10, 0, 0, time.UTC)

// The meter freezes in the dip of a probing adjustment of the charge park
// (-2.1 kW): the park is released back, then its draw keeps following what the
// loop gives. Today's loop - once its 60-s window has slid past the samples
// before the freeze - finds the same 2.1 kW again and again; the twin holds.
func TestZwillingStehenderWertGibtNichtFrei(t *testing.T) {
	set := Settings{GridLimitKw: 550}.WithDefaults()
	fahre := func(zwilling bool, leser func(tr *BudgetTracker, now time.Time) float64) (float64, *BudgetTracker) {
		tr := NewBudgetTracker()
		laden, netz := 55.0, 495.0 // the park on its budget: 495 planable - 440 rest
		tr.ObserveM(swT0, Measurement{GridKw: netz, ChargingKw: laden, Complete: true})
		tr.Budget(swT0, set)
		// the probing adjustment: the park 2.1 kW lower, the meter shows it and freezes
		laden -= 2.1
		frozen := netz - 2.1
		vor := 0.0
		for s := 2; s <= 240; s += 2 {
			now := swT0.Add(time.Duration(s) * time.Second)
			tr.ObserveM(now, Measurement{GridKw: frozen, ChargingKw: laden, Complete: true})
			kw := leser(tr, now)
			if zwilling && s > 2 && kw > vor+1e-9 {
				t.Fatalf("second %d: the twin released on a standing value: %.3f -> %.3f kW", s, vor, kw)
			}
			vor = kw
			// the park follows what it is given (at most 22 kW more per step)
			laden = math.Min(kw, laden+22)
		}
		return vor, tr
	}
	zwilling, tr := fahre(true, func(tr *BudgetTracker, now time.Time) float64 {
		tr.Budget(now, set)
		return tr.twin().Budget(now, set).Kw
	})
	heute, _ := fahre(false, func(tr *BudgetTracker, now time.Time) float64 { return tr.Budget(now, set).Kw })
	t.Logf("nach 240 s: Zwilling %.3f kW, heute %.3f kW (Ladepark folgt)", zwilling, heute)
	if zwilling > 55+1e-9 {
		t.Fatalf("the twin ends at %.3f kW, above what the last moved value proved (55 kW)", zwilling)
	}
	if heute <= zwilling+2 {
		t.Fatalf("today's loop must show the finding on the same samples: %.3f kW", heute)
	}
	n, _ := tr.Netzpunkt(swT0.Add(240*time.Second), set)
	if n.ChargingKw != 52.9 {
		t.Fatalf("Netzpunkt on a standing value: charging %.3f kW, want the 52.9 kW of the dip", n.ChargingKw)
	}
}

// The battery's grid-charge ceiling reads Netzpunkt (guards.NetzladenDeckelFuer:
// planable - (grid - battery charge + reserved)): the battery charged 22.1 kW
// at 495 kW on the meter, the probe took 2.1 kW off (meter 492.9, frozen), the
// loop gave them back - on the frozen dip the battery charge reads 20 kW, so
// the ceiling stays 22.1 kW; today's sample would read 22.1 and give 24.2.
func TestNetzpunktStehenderWertHaeltSpeicher(t *testing.T) {
	set := Settings{GridLimitKw: 550}.WithDefaults()
	tr := NewBudgetTracker()
	obs := func(s int, netz, batt float64) Netzpunkt {
		now := swT0.Add(time.Duration(s) * time.Second)
		tr.ObserveM(now, Measurement{GridKw: netz, ChargingKw: 0, Complete: true, HaveBattery: true, BatteryChargeKw: batt})
		n, _ := tr.Netzpunkt(now, set)
		return n
	}
	deckel := func(n Netzpunkt) float64 { return math.Round((n.PlanableKw-(n.GridKw-n.BattChargeKw))*1000) / 1000 }
	obs(0, 495, 22.1)
	if n := obs(2, 492.9, 20); deckel(n) != 22.1 {
		t.Fatalf("the dip moved: ceiling %.3f kW, want 22.1", deckel(n))
	}
	for s, batt := 4, 22.1; s <= 60; s, batt = s+2, batt+2.1 {
		if n := obs(s, 492.9, batt); n.BattChargeKw != 20 || deckel(n) != 22.1 {
			t.Fatalf("second %d: standing value, battery %.3f kW read as %.3f, ceiling %.3f (want 20 / 22.1)", s, batt, n.BattChargeKw, deckel(n))
		}
	}
}

// No starvation: a meter whose value moves with every sample - the twin reads
// exactly what today's tracker reads, number for number, and so does
// Netzpunkt.
func TestZwillingBewegterWertWieHeute(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	set := Settings{GridLimitKw: 550}.WithDefaults()
	tr := NewBudgetTracker()
	netz, laden, batt := 480.0, 40.0, 10.0
	for s := 0; s <= 1200; s += 1 + rng.Intn(5) {
		now := swT0.Add(time.Duration(s) * time.Second)
		netz += rng.Float64()*6 - 3 + 1e-6
		laden = math.Max(0, laden+rng.Float64()*4-2)
		batt = math.Max(0, batt+rng.Float64()*4-2)
		tr.ObserveM(now, Measurement{GridKw: netz, ChargingKw: laden, Complete: true, HaveBattery: true, BatteryChargeKw: batt})
		heute, zw := tr.Budget(now, set), tr.twin().Budget(now, set)
		if heute.Kw != zw.Kw || heute.Mode != zw.Mode {
			t.Fatalf("second %d: today %.3f (%s), twin %.3f (%s)", s, heute.Kw, heute.Mode, zw.Kw, zw.Mode)
		}
		n, _ := tr.Netzpunkt(now, set)
		if n.ChargingKw != laden || n.BattChargeKw != batt {
			t.Fatalf("second %d: Netzpunkt read %.3f / %.3f, measured %.3f / %.3f", s, n.ChargingKw, n.BattChargeKw, laden, batt)
		}
	}
}
