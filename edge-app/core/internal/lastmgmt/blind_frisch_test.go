package lastmgmt

// IP-18 finding of IP-27 (one headroom given out once), the import-side
// counterpart of guards/doppelfreigabe_test.go.

import (
	"math/rand"
	"testing"
	"time"
)

// The counterpart of the feed-in release test: long gaps (the leading box
// ramps to its share, a co-controlling one holds it) and the measurement
// back - with a share the budget is never above the one of the same samples
// without a share, at the transition blind -> fresh included. Exactly,
// without tolerance.
func TestEigenschaftErweitertNieBlindZuFrisch(t *testing.T) {
	rng := rand.New(rand.NewSource(18))
	uebergaenge := 0
	for run := 0; run < 400; run++ {
		set := Settings{GridLimitKw: []float64{100, 550}[rng.Intn(2)], HouseReserveKw: float64(rng.Intn(80)), MaxHouseLoadKw: float64(rng.Intn(120))}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(400)) / 2, Fuehrt: rng.Intn(2) == 0}
		mit, ohne := NewBudgetTracker(), NewBudgetTracker()
		now, blind, warBlind := puT0, false, false
		for step := 0; step < 120; step++ {
			now = now.Add(10 * time.Second)
			if rng.Intn(12) == 0 {
				blind = !blind
			}
			if !blind {
				m := Measurement{GridKw: float64(rng.Intn(600) - 50), ChargingKw: float64(rng.Intn(120)), Complete: true}
				mit.ObserveM(now, m)
				ohne.ObserveM(now, m)
			}
			v := mit.BudgetAnteil(now, set, an)
			h := ohne.Budget(now, set)
			if v.Kw > h.Kw {
				t.Fatalf("run %d step %d: with a share %.3f kW > without %.3f kW (%+v)", run, step, v.Kw, h.Kw, an)
			}
			if warBlind && !v.Blind {
				uebergaenge++
			}
			warBlind = v.Blind
		}
	}
	if uebergaenge < 200 {
		t.Fatalf("only %d transitions blind -> fresh", uebergaenge)
	}
	t.Logf("%d transitions blind -> fresh", uebergaenge)
}
