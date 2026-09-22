package lastmgmt

// AP-15 Folge of IP-19 (V3: the import share holds for EVERYTHING the box
// controls): the charge park gets the share minus reserve_verbraucher - the
// rated power of the box's other controllable import devices (relays,
// SG-Ready, heat pumps, a wallbox outside wallboxes[]). Proven with R3 plus a
// 10 kW heat pump at Box Verwaltung, and the three properties of the share
// path with the reserve as an extra random source. The existing test files
// stay untouched: without the field every figure is today's.

import (
	"math"
	"math/rand"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

const r3WaermepumpeKw = 10.0

// R3 with a heat pump: Box Verwaltung (steuert mit, share 77 kW) controls the
// six charge points AND a 10 kW heat pump. Without the reserve the park gets
// 77 kW and the heat pump draws on top (87 kW, 473 + 87 = 560 > 550); with it
// the park gets 67 kW blind and before the first sample. Fresh (AP-15 Folge),
// the feeder DQ-10 measures the running heat pump - 77 − 10 = 67 kW with and
// without the field, the reserve does not count twice.
func TestR3MitWaermepumpeBekommtDerLadeparkHoechstens67kW(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	for name, tr := range map[string]func() (*BudgetTracker, time.Time){
		"frisch": func() (*BudgetTracker, time.Time) {
			tr := NewBudgetTracker()
			tr.Observe(t0, r3WaermepumpeKw, 0, true) // DQ-10: the heat pump at full power, the park stands
			return tr, t0.Add(5 * time.Second)
		},
		"ohne Verbindung": func() (*BudgetTracker, time.Time) {
			tr := NewBudgetTracker()
			tr.Observe(t0, 0, 0, true)
			return tr, t0.Add(10 * time.Minute)
		},
		"nach Neustart": func() (*BudgetTracker, time.Time) { return NewBudgetTracker(), t0 },
	} {
		neu := tr
		tr, now := neu()
		v := tr.BudgetAnteil(now, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, ReserveKw: r3WaermepumpeKw})
		if v.Kw != 67 || !v.AnteilBinds || v.Measured() {
			t.Fatalf("%s: budget %+v, want 77 - 10 = 67 kW", name, v)
		}
		if v.ReserveVerbraucherKw == nil || *v.ReserveVerbraucherKw != 10 || *v.AnteilKw != 77 {
			t.Fatalf("%s: verdict echoes share %v and reserve %v, want 77 and 10", name, v.AnteilKw, v.ReserveVerbraucherKw)
		}
		if name == "frisch" && (!v.EigenerZaehler || !containsStr(v.Reason, "Dort ziehen gerade 10,0 kW")) {
			t.Fatalf("%s: reason %q does not name the measured heat pump", name, v.Reason)
		}
		if name != "frisch" && !containsStr(v.Reason, "67,0 kW (77,0 kW abzüglich 10,0 kW für ihre anderen steuerbaren Verbraucher)") {
			t.Fatalf("%s: reason %q does not name the reserve", name, v.Reason)
		}
		p := Decide(Input{Settings: verwaltungSet(), Sessions: sechsFahrzeuge(t0), BudgetKw: &v.Kw, Now: now})
		// 67,0 at one decimal: the allocator rounds each of the six shares of
		// 11,1667 kW to the watt (67,002 kW together) - today's rounding, the
		// same that gives 76,998 for 77 kW in the R3 test without a reserve
		if got := summe(p); math.Abs(got-67) > 0.006 {
			t.Fatalf("%s: the six charge points get %.3f kW together, want 67,0", name, got)
		}
		if worst := r3VorbehaltKw + v.Kw + r3WaermepumpeKw; worst > r3AnschlussKw {
			t.Fatalf("%s: 473 + budget %.3f + heat pump 10 = %.3f kW above 550", name, v.Kw, worst)
		}

		// Without the field (older document, older cloud): 77 kW as today -
		// fresh the measured heat pump, 67 kW.
		tr2, now2 := neu()
		ohne := tr2.BudgetAnteil(now2, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw})
		wantOhne := 77.0
		if name == "frisch" {
			wantOhne = 67
		}
		if ohne.Kw != wantOhne || ohne.ReserveVerbraucherKw != nil ||
			containsStr(ohne.Reason, "abzüglich") {
			t.Fatalf("%s: without the field %+v, want %.0f kW and no reserve", name, ohne, wantOhne)
		}
	}
}

// The leading box with a FRESH connection-point value regulates the whole
// limit and measures the heat pump at the grid meter: the reserve changes
// nothing there - the verdict is identical with and without it. Blind, the
// same box ramps to share − reserve.
func TestR3FuehrendeBoxMitFrischemWertOhneWirkungDerReserve(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	set := Settings{GridLimitKw: r3AnschlussKw, HouseReserveKw: 300, MaxHouseLoadKw: 473}
	mit, ohne := NewBudgetTracker(), NewBudgetTracker()
	for _, tr := range []*BudgetTracker{mit, ohne} {
		tr.Observe(t0, 367, 20, true)
	}
	now := t0.Add(5 * time.Second)
	a := mit.BudgetAnteil(now, set, BezugAnteil{AnteilKw: 40, Fuehrt: true, ReserveKw: r3WaermepumpeKw})
	b := ohne.BudgetAnteil(now, set, BezugAnteil{AnteilKw: 40, Fuehrt: true})
	if a.Kw != b.Kw || a.Mode != b.Mode || a.Reason != b.Reason || a.AnteilBinds || !a.Measured() {
		t.Fatalf("fresh leading box: with reserve %+v, without %+v - want identical, measured", a, b)
	}
	// blind for good: the share minus the reserve
	later := t0.Add(10 * time.Minute)
	a = mit.BudgetAnteil(later, set, BezugAnteil{AnteilKw: 15, Fuehrt: true, ReserveKw: r3WaermepumpeKw})
	b = ohne.BudgetAnteil(later, set, BezugAnteil{AnteilKw: 15, Fuehrt: true})
	if a.Kw != 5 || b.Kw != 15 || !a.Blind {
		t.Fatalf("blind leading box: with reserve %.3f kW, without %.3f kW - want 5 and 15", a.Kw, b.Kw)
	}
}

// R3 Schritt 4 with the heat pump: without any connection the uncontrolled
// load at its reserve, Box Verwaltung's park at 77 − 10 and its heat pump at
// full power, Box Halle 1 blind at 0 - together 473 + 67 + 10 + 0 = 550 kW.
func TestR3SchlimmsterFallMitWaermepumpeIst550kW(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	later := t0.Add(3 * time.Hour)
	e4 := NewBudgetTracker()
	e4.Observe(t0, 0, 0, true) // DQ-10
	verwaltung := e4.BudgetAnteil(later, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, ReserveKw: r3WaermepumpeKw})
	e1 := NewBudgetTracker()
	e1.Observe(t0, 367, 0, true)
	halle1 := e1.BudgetAnteil(later, Settings{GridLimitKw: r3AnschlussKw, HouseReserveKw: 300, MaxHouseLoadKw: 473},
		BezugAnteil{AnteilKw: r3AnteilE1Kw, Fuehrt: true})
	worst := r3VorbehaltKw + verwaltung.Kw + r3WaermepumpeKw + halle1.Kw
	if verwaltung.Kw != 67 || halle1.Kw != 0 || worst != 550 {
		t.Fatalf("worst case %.1f kW (park %.1f, Halle 1 %.1f), want 473 + 67 + 10 + 0 = 550", worst, verwaltung.Kw, halle1.Kw)
	}
}

// reserveZufall is the new random source: no reserve (older document) in a
// third of the runs, else 0..60 kW - also above the share.
func reserveZufall(rng *rand.Rand) float64 {
	if rng.Intn(3) == 0 {
		return 0
	}
	return float64(rng.Intn(121)) / 2
}

// pruefeReserve holds the three verdicts of one step against each other:
// with the reserve never above the same share without it, never above the box
// without a share (V5); a co-controlling box never above its share, and never
// above share − reserve where it cannot see those consumers - blind or before
// the first sample (AP-15 Folge: with a fresh value of its own meter they
// draw inside the measured rest, and the reserve does not count twice).
func pruefeReserve(t *testing.T, run, step int, an BezugAnteil, mitR, ohneR, heute BudgetVerdict) {
	t.Helper()
	if mitR.Kw > ohneR.Kw || mitR.Kw > heute.Kw {
		t.Fatalf("run %d step %d: with reserve %.3f kW > without reserve %.3f / without share %.3f (%+v, %s)",
			run, step, mitR.Kw, ohneR.Kw, heute.Kw, an, mitR.Reason)
	}
	lade := round3(an.AnteilKw - an.ReserveKw)
	if lade < 0 {
		lade = 0
	}
	if !an.Fuehrt && !mitR.EigenerZaehler && mitR.Kw > lade {
		t.Fatalf("run %d step %d: co-controlling box %.3f kW above share − reserve %.3f", run, step, mitR.Kw, lade)
	}
	if !an.Fuehrt && mitR.Kw > round3(math.Max(an.AnteilKw, 0)) {
		t.Fatalf("run %d step %d: co-controlling box %.3f kW above its share %.3f", run, step, mitR.Kw, an.AnteilKw)
	}
}

// TestEigenschaftDerWaechterErweitertNie with the reserve as a random source.
func TestEigenschaftErweitertNieMitReserve(t *testing.T) {
	rng := rand.New(rand.NewSource(1019))
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	gesenkt := 0
	for run := 0; run < 400; run++ {
		set := Settings{
			GridLimitKw:    []float64{0, 30, 100, 550}[rng.Intn(4)],
			HouseReserveKw: float64(rng.Intn(80)),
			MaxHouseLoadKw: float64(rng.Intn(120)),
			StaticBudget:   rng.Intn(6) == 0,
		}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(700)) / 2, Fuehrt: rng.Intn(2) == 0, ReserveKw: reserveZufall(rng)}
		ohneAn := an
		ohneAn.ReserveKw = 0
		mit, ohneR, ohne := NewBudgetTracker(), NewBudgetTracker(), NewBudgetTracker()
		probe := &guards.Einfrierprobe{}
		friertAb, frozenGrid := rng.Intn(90), 0.0
		now := t0
		for step := 0; step < 60; step++ {
			now = now.Add(time.Duration(rng.Intn(40)) * time.Second)
			if rng.Intn(3) > 0 {
				m := Measurement{GridKw: float64(rng.Intn(700) - 150), ChargingKw: float64(rng.Intn(100)), Complete: rng.Intn(8) > 0}
				if step < friertAb {
					frozenGrid = m.GridKw
				} else {
					m.GridKw = frozenGrid
				}
				probe.Wert(now, m.GridKw)
				for _, tr := range []*BudgetTracker{mit, ohneR, ohne} {
					tr.ObserveM(now, m)
				}
			}
			if rng.Intn(3) == 0 {
				probe.Verstellt(now, float64(rng.Intn(60)-30))
			}
			an.EingefrorenSeit = time.Time{}
			if seit, ok := probe.Eingefroren(now); ok {
				an.EingefrorenSeit = seit
			}
			ohneAn.EingefrorenSeit = an.EingefrorenSeit
			if rng.Intn(5) == 0 {
				kw := float64(rng.Intn(400))
				for _, tr := range []*BudgetTracker{mit, ohneR, ohne} {
					tr.ObserveGridLimit(kw)
				}
			}
			v, w := mit.BudgetAnteil(now, set, an), ohneR.BudgetAnteil(now, set, ohneAn)
			pruefeReserve(t, run, step, an, v, w, ohne.Budget(now, set))
			if v.Kw < w.Kw {
				gesenkt++
			}
		}
	}
	if gesenkt < 500 {
		t.Fatalf("the reserve lowered the budget in only %d steps", gesenkt)
	}
	t.Logf("%d steps lowered by the reserve", gesenkt)
}

// TestEigenschaftErweitertNieMitUhrUndPruefung with the reserve as a random
// source.
func TestEigenschaftErweitertNieMitUhrPruefungUndReserve(t *testing.T) {
	rng := rand.New(rand.NewSource(1027))
	pruefungen, spruenge := 0, 0
	for run := 0; run < 400; run++ {
		set := Settings{
			GridLimitKw:    []float64{0, 30, 100, 550}[rng.Intn(4)],
			HouseReserveKw: float64(rng.Intn(80)),
			MaxHouseLoadKw: float64(rng.Intn(120)),
			StaticBudget:   rng.Intn(6) == 0,
		}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(700)) / 2, Fuehrt: rng.Intn(2) == 0, ReserveKw: reserveZufall(rng)}
		mit, ohneR, ohne := NewBudgetTracker(), NewBudgetTracker(), NewBudgetTracker()
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
				for _, tr := range []*BudgetTracker{mit, ohneR, ohne} {
					tr.ObserveM(box, m)
				}
			}
			if rng.Intn(3) == 0 {
				probe.Verstellt(box, float64(rng.Intn(60)-30))
			}
			if rng.Intn(5) == 0 {
				kw := float64(rng.Intn(400))
				for _, tr := range []*BudgetTracker{mit, ohneR, ohne} {
					tr.ObserveGridLimit(kw)
				}
			}
			if rng.Intn(6) == 0 {
				kw := float64(rng.Intn(600))
				for _, tr := range []*BudgetTracker{mit, ohneR, ohne} {
					tr.ObservePlanLimit(box, kw)
				}
			}
			an.EingefrorenSeit, an.Pruefen, an.PruefenNeu = time.Time{}, false, false
			if seit, ok := probe.Eingefroren(box); ok {
				an.EingefrorenSeit = seit
			}
			if r, neu := probe.Pruefung(box); r > 0 || rng.Intn(6) == 0 {
				an.Pruefen, an.PruefenNeu = true, neu || rng.Intn(2) == 0
			}
			ohneAn := an
			ohneAn.ReserveKw = 0
			v, w := mit.BudgetAnteil(box, set, an), ohneR.BudgetAnteil(box, set, ohneAn)
			if v.Pruefung {
				pruefungen++
				probe.Geprueft(box)
			}
			pruefeReserve(t, run, step, an, v, w, ohne.Budget(box, set))
		}
	}
	if pruefungen < 50 || spruenge < 100 {
		t.Fatalf("the random sources do not reach the new paths: %d probes, %d jumps", pruefungen, spruenge)
	}
	t.Logf("%d probing adjustments, %d clock jumps", pruefungen, spruenge)
}

// TestEigenschaftErweitertNieBlindZuFrisch with the reserve as a random
// source: long gaps and the measurement back.
func TestEigenschaftErweitertNieBlindZuFrischMitReserve(t *testing.T) {
	rng := rand.New(rand.NewSource(1018))
	uebergaenge := 0
	for run := 0; run < 400; run++ {
		set := Settings{GridLimitKw: []float64{100, 550}[rng.Intn(2)], HouseReserveKw: float64(rng.Intn(80)), MaxHouseLoadKw: float64(rng.Intn(120))}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(400)) / 2, Fuehrt: rng.Intn(2) == 0, ReserveKw: reserveZufall(rng)}
		ohneAn := an
		ohneAn.ReserveKw = 0
		mit, ohneR, ohne := NewBudgetTracker(), NewBudgetTracker(), NewBudgetTracker()
		now, blind, warBlind := puT0, false, false
		for step := 0; step < 120; step++ {
			now = now.Add(10 * time.Second)
			if rng.Intn(12) == 0 {
				blind = !blind
			}
			if !blind {
				m := Measurement{GridKw: float64(rng.Intn(600) - 50), ChargingKw: float64(rng.Intn(120)), Complete: true}
				for _, tr := range []*BudgetTracker{mit, ohneR, ohne} {
					tr.ObserveM(now, m)
				}
			}
			v, w := mit.BudgetAnteil(now, set, an), ohneR.BudgetAnteil(now, set, ohneAn)
			pruefeReserve(t, run, step, an, v, w, ohne.Budget(now, set))
			// the fresh leading box: the reserve changes nothing
			if an.Fuehrt && w.Measured() && v.Kw != w.Kw {
				t.Fatalf("run %d step %d: fresh leading box %.3f kW with reserve, %.3f without", run, step, v.Kw, w.Kw)
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
