package lastmgmt

// IP-27 healing package (vp-uems-v15-folge-waechter-a7-a8) on the import
// side: the probing adjustment of the leading box's charging budget (A7) and
// the twin that re-anchors on a clock that jumped back (A8). The picture is
// R3 of the reference cases: NA-1 550 kW, the leading box holds an import
// share of 77 kW over its charge park.

import (
	"math"
	"math/rand"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

var (
	puT0   = time.Date(2027, 6, 15, 22, 0, 0, 0, time.UTC)
	puSet  = Settings{GridLimitKw: 550, HouseReserveKw: 473, MaxHouseLoadKw: 473}
	puFuer = BezugAnteil{AnteilKw: 77, Fuehrt: true}
)

func TestPruefSenkKwWieGuards(t *testing.T) {
	if pruefSenkKw != guards.PruefSenkKw {
		t.Fatalf("lastmgmt %.3f kW, guards %.3f kW - one figure for both directions", pruefSenkKw, guards.PruefSenkKw)
	}
}

// puLauf plays the leading box: a sample every 10 s (probe first, as the
// agent does), the budget right after; the charge park follows the budget.
func puLauf(t *testing.T, friert bool, sekunden int) (budgets []BudgetVerdict, pruefungen int, eingefroren time.Time) {
	t.Helper()
	b, p := NewBudgetTracker(), &guards.Einfrierprobe{}
	laden, rest := 90.0, 380.0 // budget 495 - 380 = 115 kW: the park draws 90
	altAlloc := laden
	var grid float64
	for s := -60; s <= sekunden; s += 10 {
		now := puT0.Add(time.Duration(s) * time.Second)
		g := rest + laden + float64(min(s, 0))/1000 // alive and moving before 0
		if !friert || s <= 0 {
			grid = g
		}
		p.Wert(now, grid)
		b.ObserveM(now, Measurement{GridKw: grid, ChargingKw: laden, Complete: true})
		an := puFuer
		if seit, ok := p.Eingefroren(now); ok {
			an.EingefrorenSeit = seit
			if eingefroren.IsZero() {
				eingefroren = now
			}
		}
		if r, neu := p.Pruefung(now); r > 0 {
			an.Pruefen, an.PruefenNeu = true, neu
		}
		v := b.BudgetAnteil(now, puSet, an)
		if v.Pruefung {
			pruefungen++
			p.Geprueft(now)
		}
		alloc := math.Min(v.Kw, 90)
		p.Verstellt(now, -guards.WirksamGesenkt(altAlloc, alloc, laden))
		altAlloc, laden = alloc, alloc
		if s >= 0 {
			budgets = append(budgets, v)
		}
	}
	return budgets, pruefungen, eingefroren
}

// A frozen connection point at the leading box with its charge park above its
// share: ONE probing adjustment after 30 s standstill (the budget 2.1 kW below
// the measured draw, held), frozen 20 s later, on the share 90 s after the
// last value. The same with a healthy meter: the value moves, no verdict.
func TestBezugPruefVerstellung(t *testing.T) {
	v, n, seit := puLauf(t, true, 200)
	if n != 1 {
		t.Fatalf("one probing adjustment per standstill, got %d", n)
	}
	if seit.IsZero() {
		t.Fatal("the frozen meter was never judged frozen")
	}
	if v[3].Kw != 87.9 {
		t.Fatalf("+30 s: the budget lowered to 87.9 kW (90 - 2.1), got %.3f (%s)", v[3].Kw, v[3].Reason)
	}
	if v[9].Kw > 77+1e-9 {
		t.Fatalf("+90 s after the last value: on the share of 77 kW, got %.3f (%s)", v[9].Kw, v[9].Mode)
	}
	t.Logf("probe at +30 s (87.9 kW), frozen at %v, +90 s %.1f kW", seit.Sub(puT0), v[9].Kw)

	_, n, seit = puLauf(t, false, 200)
	if !seit.IsZero() {
		t.Fatal("a healthy meter judged frozen")
	}
	if n > 4 {
		t.Fatalf("%d probing adjustments in 200 s of a healthy meter", n)
	}
}

// Under its share the leading box never probes, and without a draw there is
// nothing to lower: no pretend adjustment.
func TestBezugPruefVerstellungKeinFehlalarm(t *testing.T) {
	for _, laden := range []float64{50, 1.5} {
		b := NewBudgetTracker()
		for s := 0; s <= 120; s += 10 {
			now := puT0.Add(time.Duration(s) * time.Second)
			b.ObserveM(now, Measurement{GridKw: 470 + laden, ChargingKw: laden, Complete: true})
			an := puFuer
			if laden == 1.5 {
				an.AnteilKw = 0
			}
			an.Pruefen, an.PruefenNeu = true, true
			if v := b.BudgetAnteil(now, puSet, an); v.Pruefung {
				t.Fatalf("draw %.1f kW: a probe although %s", laden, v.Reason)
			}
		}
	}
}

// A8 on the import side: the clock of the leading box jumps 840 s back.
// Today's tracker discards every later sample (and keeps its verdict - byte
// for byte what it was); the share path's twin re-anchors on them, so a rise
// of the building load after the jump is regulated at once. Evaluated BEFORE
// the next sample the age is below zero: blind, on the share.
func TestBezugUhrZurueck(t *testing.T) {
	b := NewBudgetTracker()
	b.ObserveM(puT0, Measurement{GridKw: 470, ChargingKw: 50, Complete: true})
	vor := b.BudgetAnteil(puT0, puSet, puFuer)
	nach := puT0.Add(-840 * time.Second)
	v := b.BudgetAnteil(nach, puSet, puFuer)
	if !v.Blind || v.Kw > 77+1e-9 || !containsStr(v.Reason, "zurückgesprungen") {
		t.Fatalf("clock behind the sample: blind on the share, got %.3f blind=%v %q", v.Kw, v.Blind, v.Reason)
	}
	// the building load rises 60 kW, the next sample is older than the last
	b.ObserveM(nach.Add(10*time.Second), Measurement{GridKw: 530, ChargingKw: 50, Complete: true})
	v = b.BudgetAnteil(nach.Add(10*time.Second), puSet, puFuer)
	if v.Blind || v.Kw > vor.Kw-60+1e-6 {
		t.Fatalf("re-anchored: the rise is regulated at once (%.3f -> %.3f kW), got blind=%v", vor.Kw, v.Kw, v.Blind)
	}
	// today's tracker alone: the older sample is discarded, as it always was
	h := NewBudgetTracker()
	h.ObserveM(puT0, Measurement{GridKw: 470, ChargingKw: 50, Complete: true})
	h.ObserveM(nach.Add(10*time.Second), Measurement{GridKw: 530, ChargingKw: 50, Complete: true})
	if hv := h.Budget(nach.Add(10*time.Second), puSet); hv.Kw != vor.Kw {
		t.Fatalf("today's Budget is unchanged by this package: %.3f, want %.3f", hv.Kw, vor.Kw)
	}
	n, _ := b.Netzpunkt(nach.Add(5*time.Second), puSet)
	if n.GridKw != 530 {
		t.Fatalf("the leading box's grid-charge loop reads the re-anchored sample: %.1f", n.GridKw)
	}
	if n, _ := b.Netzpunkt(nach, puSet); n.Age <= BudgetFreshWindow {
		t.Fatalf("an age below zero is blind for the grid-charge loop: %v", n.Age)
	}
}

// "Der Waechter erweitert nie" with the new random sources of this package:
// the clock jumps back and ahead, the probing adjustment runs. With a share
// the budget is never above the one of the same samples without a share -
// exactly, without tolerance.
func TestEigenschaftErweitertNieMitUhrUndPruefung(t *testing.T) {
	rng := rand.New(rand.NewSource(27))
	pruefungen, spruenge := 0, 0
	for run := 0; run < 400; run++ {
		set := Settings{
			GridLimitKw:    []float64{0, 30, 100, 550}[rng.Intn(4)],
			HouseReserveKw: float64(rng.Intn(80)),
			MaxHouseLoadKw: float64(rng.Intn(120)),
			StaticBudget:   rng.Intn(6) == 0,
		}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(700)) / 2, Fuehrt: rng.Intn(2) == 0}
		mit, ohne := NewBudgetTracker(), NewBudgetTracker()
		probe := &guards.Einfrierprobe{}
		now, uhr := puT0, time.Duration(0)
		for step := 0; step < 60; step++ {
			now = now.Add(time.Duration(rng.Intn(40)) * time.Second)
			if rng.Intn(10) == 0 {
				uhr += time.Duration(rng.Intn(1800)-900) * time.Second
				spruenge++
			}
			box := now.Add(uhr)
			if rng.Intn(3) > 0 {
				m := Measurement{GridKw: float64(rng.Intn(700) - 150), ChargingKw: float64(rng.Intn(100)), Complete: rng.Intn(8) > 0}
				probe.Wert(box, m.GridKw)
				mit.ObserveM(box, m)
				ohne.ObserveM(box, m)
			}
			if rng.Intn(3) == 0 {
				probe.Verstellt(box, float64(rng.Intn(60)-30))
			}
			if rng.Intn(5) == 0 {
				kw := float64(rng.Intn(400))
				mit.ObserveGridLimit(kw)
				ohne.ObserveGridLimit(kw)
			}
			if rng.Intn(6) == 0 {
				kw := float64(rng.Intn(600))
				mit.ObservePlanLimit(box, kw)
				ohne.ObservePlanLimit(box, kw)
			}
			an.EingefrorenSeit, an.Pruefen, an.PruefenNeu = time.Time{}, false, false
			if seit, ok := probe.Eingefroren(box); ok {
				an.EingefrorenSeit = seit
			}
			if r, neu := probe.Pruefung(box); r > 0 || rng.Intn(6) == 0 {
				an.Pruefen, an.PruefenNeu = true, neu || rng.Intn(2) == 0
			}
			v := mit.BudgetAnteil(box, set, an)
			h := ohne.Budget(box, set)
			if v.Pruefung {
				pruefungen++
				probe.Geprueft(box)
			}
			if v.Kw > h.Kw {
				t.Fatalf("run %d step %d: with a share %.3f kW > without %.3f kW (%+v, %s)", run, step, v.Kw, h.Kw, an, v.Reason)
			}
		}
	}
	if pruefungen < 50 || spruenge < 100 {
		t.Fatalf("the random sources do not reach the new paths: %d probes, %d jumps", pruefungen, spruenge)
	}
	t.Logf("%d probing adjustments, %d clock jumps", pruefungen, spruenge)
}

func containsStr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
