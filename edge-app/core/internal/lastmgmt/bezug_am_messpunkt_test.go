package lastmgmt

// AP-15 Folge of IP-19 (concept §3.2 Schicht 2, §3.3, B3): the co-controlling
// box holds its import share at its OWN meter - `budget = share − (feeder −
// measured charging)`, never above the share; blind the share minus the
// reserve minus the declared maximum of the uncontrolled load behind the
// feeder. Proven with the figures of the clarification
// vp-uems-v15-klaerung-ungeregelt-abgang: R3 with 50 kW building load behind
// the feeder of Verwaltung (Fall A: Vorbehalt 473, share 77; Fall C: Vorbehalt
// 418 from the measurements + ungeregelt 50 declared, share 132), plus the
// property "der Waechter erweitert nie" with that building load as a random
// source.

import (
	"math"
	"math/rand"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

const (
	gebaeudeImAbgangKw = 50.0  // Verwaltung's building behind DQ-10's position
	halle1SpitzeKw     = 380.0 // the rest of the plant at the measured peak
	vorbehaltGemessen  = 418.0 // 1,1 × 380, the Vorbehalt taken from the measurements
	anteilFallCKw      = 132.0 // share of E-4 with 418 + ungeregelt 50 declared
)

// abgang is Box Verwaltung's feeder meter with the building load behind it:
// what the six charge points draw plus the building.
func abgang(tr *BudgetTracker, ts time.Time, ladenKw float64) {
	tr.Observe(ts, gebaeudeImAbgangKw+ladenKw, ladenKw, true)
}

// Fall A (R3 wörtlich, Vorbehalt 473 with the 50 kW inside, share 77): fresh
// the feeder measures the building - the park gets 77 − 50 = 27 kW; blind with
// the declared maximum 50 the same 27; blind WITHOUT the field today's
// share − reserve (77, and 67 with the heat pump of PR 1058).
func TestR3GebaeudelastImAbgangFallA(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	frisch := NewBudgetTracker()
	abgang(frisch, t0, 0)
	v := frisch.BudgetAnteil(t0.Add(5*time.Second), verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw})
	if v.Kw != 27 || !v.AnteilBinds || !v.EigenerZaehler || v.Measured() {
		t.Fatalf("fresh: %+v, want 77 − 50 = 27 kW", v)
	}
	if !containsStr(v.Reason, "Dort ziehen gerade 50,0 kW") || !containsStr(v.Reason, "höchstens 27,0 kW") {
		t.Fatalf("fresh: the reason %q does not name the measured building", v.Reason)
	}
	// the park charging 27 kW: the feeder reads 77, the loop stays at 27
	abgang(frisch, t0.Add(10*time.Second), 27)
	if v := frisch.BudgetAnteil(t0.Add(12*time.Second), verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw}); v.Kw != 27 {
		t.Fatalf("fresh while charging: %.3f kW, want 27 (rest = feeder − charging, stable)", v.Kw)
	}
	for name, now := range map[string]time.Time{"ohne Verbindung": t0.Add(10 * time.Minute), "nach 31 s": t0.Add(41 * time.Second)} {
		mit := frisch.BudgetAnteil(now, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, UngeregeltKw: gebaeudeImAbgangKw})
		if mit.Kw != 27 || mit.EigenerZaehler || mit.UngeregeltHinterAbgangKw == nil || *mit.UngeregeltHinterAbgangKw != 50 {
			t.Fatalf("%s, declared 50: %+v, want 27 kW", name, mit)
		}
		if !containsStr(mit.Reason, "27,0 kW (77,0 kW abzüglich 50,0 kW für das Ungeregelte hinter ihrem Zähler)") {
			t.Fatalf("%s: the reason %q does not name the declared maximum", name, mit.Reason)
		}
	}
	neustart := NewBudgetTracker().BudgetAnteil(t0, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, UngeregeltKw: gebaeudeImAbgangKw})
	if neustart.Kw != 27 {
		t.Fatalf("after a restart, declared 50: %+v, want 27 kW", neustart)
	}
	// without the field: the blind figure of PR 1058, share − reserve
	blind := NewBudgetTracker()
	abgang(blind, t0, 0)
	later := t0.Add(10 * time.Minute)
	if v := blind.BudgetAnteil(later, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw}); v.Kw != 77 || v.UngeregeltHinterAbgangKw != nil {
		t.Fatalf("blind without the field: %+v, want today's 77 kW", v)
	}
	if v := blind.BudgetAnteil(later, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, ReserveKw: r3WaermepumpeKw}); v.Kw != 67 {
		t.Fatalf("blind without the field, heat pump 10: %.3f kW, want 77 − 10 = 67", v.Kw)
	}
	// both declared: blind share − reserve − ungeregelt
	if v := blind.BudgetAnteil(later, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, ReserveKw: r3WaermepumpeKw, UngeregeltKw: 50}); v.Kw != 17 ||
		!containsStr(v.Reason, "17,0 kW (77,0 kW abzüglich 10,0 kW für ihre anderen steuerbaren Verbraucher und 50,0 kW für das Ungeregelte hinter ihrem Zähler)") {
		t.Fatalf("blind, heat pump 10 and ungeregelt 50: %+v, want 17 kW", v)
	}
	// fresh, the heat pump counts once: measured inside the rest, not reserved
	if v := frisch.BudgetAnteil(t0.Add(12*time.Second), verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw, ReserveKw: r3WaermepumpeKw, UngeregeltKw: 50}); v.Kw != 27 {
		t.Fatalf("fresh with reserve and ungeregelt: %.3f kW, want 27 (both measured, nothing counted twice)", v.Kw)
	}
}

// Fall C (B3 as the concept wants it): Vorbehalt 418 from the measurements,
// the 50 kW behind the feeder declared as ungeregelt - share 132. Fresh the
// park gets 132 − 50 = 82 kW, blind the same 82; the worst case is
// 418 + 132 = 550 kW, at the measured peak 380 + 50 + 82 = 512 kW. The fixed
// share of IP-19 gave the park 132 kW: 562 kW at the measured peak.
func TestR3GebaeudelastImAbgangFallC(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	an := BezugAnteil{AnteilKw: anteilFallCKw, UngeregeltKw: gebaeudeImAbgangKw}
	tr := NewBudgetTracker()
	abgang(tr, t0, 0)
	for name, now := range map[string]time.Time{"frisch": t0.Add(5 * time.Second), "ohne Verbindung": t0.Add(3 * time.Hour)} {
		v := tr.BudgetAnteil(now, verwaltungSet(), an)
		p := Decide(Input{Settings: verwaltungSet(), Sessions: sechsFahrzeuge(t0), BudgetKw: &v.Kw, Now: now})
		park := summe(p)
		// 82,0 at one decimal: the allocator rounds each of the six shares of
		// 13,667 kW to the watt (82,002 kW together), today's rounding
		if v.Kw != 82 || math.Abs(park-82) > 0.006 {
			t.Fatalf("%s: budget %.3f, park %.3f kW, want 132 − 50 = 82", name, v.Kw, park)
		}
		if spitze := halle1SpitzeKw + gebaeudeImAbgangKw + park; spitze > r3AnschlussKw {
			t.Fatalf("%s: at the measured peak 380 + 50 + %.3f = %.3f kW above 550", name, park, spitze)
		}
		if worst := vorbehaltGemessen + gebaeudeImAbgangKw + v.Kw; worst > r3AnschlussKw {
			t.Fatalf("%s: worst case 418 + 50 + %.3f = %.3f kW above 550", name, v.Kw, worst)
		}
	}
	// Fall B, the same measured Vorbehalt 418 WITHOUT the declaration (share
	// 132, no field): fresh the feeder still holds - 82 kW, 512 at the peak.
	b := NewBudgetTracker()
	abgang(b, t0, 0)
	if v := b.BudgetAnteil(t0.Add(5*time.Second), verwaltungSet(), BezugAnteil{AnteilKw: anteilFallCKw}); v.Kw != 82 {
		t.Fatalf("Fall B fresh: %.3f kW, want 82", v.Kw)
	}
}

// DQ-10 as Ahrenberg has it (only what the box controls behind the feeder):
// fresh, blind and after a restart the park keeps its 77 kW, also while it
// charges - the loop sees rest 0.
func TestR3RichtigSitzenderZaehlerBleibt77kW(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	tr := NewBudgetTracker()
	for i, laden := range []float64{0, 40, 77, 76.998} {
		ts := t0.Add(time.Duration(i) * 5 * time.Second)
		tr.Observe(ts, laden, laden, true)
		if v := tr.BudgetAnteil(ts.Add(time.Second), verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw}); v.Kw != 77 || !v.EigenerZaehler {
			t.Fatalf("DQ-10 charging %.3f kW: %+v, want 77", laden, v)
		}
	}
	if v := tr.BudgetAnteil(t0.Add(time.Hour), verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw}); v.Kw != 77 {
		t.Fatalf("DQ-10 blind: %.3f, want 77", v.Kw)
	}
}

// A blind controller releases nothing it just measured: the building draws
// 70 kW although only 50 are declared - fresh 77 − 70 = 7 kW; blind the box
// stays on those 7 kW for BezugAnteilWindow, then the declared figure 27.
// Going blind never ramps DOWN slowly: the step to 27 is at once.
func TestMitsteuerndBlindNieUeberDemLetztenMesswert(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	an := BezugAnteil{AnteilKw: r3AnteilE4Kw, UngeregeltKw: gebaeudeImAbgangKw}
	tr := NewBudgetTracker()
	tr.Observe(t0, 70, 0, true)
	if v := tr.BudgetAnteil(t0.Add(time.Second), verwaltungSet(), an); v.Kw != 7 {
		t.Fatalf("fresh: %.3f, want 7", v.Kw)
	}
	if v := tr.BudgetAnteil(t0.Add(45*time.Second), verwaltungSet(), an); v.Kw != 7 || !v.Blind || !containsStr(v.Reason, "zuletzt gemessenen Wert von 7,0 kW") {
		t.Fatalf("blind in the window: %+v, want the last fresh 7 kW", v)
	}
	if v := tr.BudgetAnteil(t0.Add(91*time.Second), verwaltungSet(), an); v.Kw != 27 {
		t.Fatalf("past the window: %.3f, want the declared 27", v.Kw)
	}
	g := NewBudgetTracker()
	g.Observe(t0, 0, 0, true) // nothing behind the feeder: fresh 77
	if v := g.BudgetAnteil(t0.Add(31*time.Second), verwaltungSet(), an); v.Kw != 27 {
		t.Fatalf("31 s blind: %.3f, want 27 at once (no ramp down)", v.Kw)
	}
}

// B2 and A8 hold for the co-controlling box too: a frozen feeder value and a
// clock behind the sample are blind - the declared figure; a standing value
// asks for the probing adjustment while the park draws above it.
func TestMitsteuerndEingefrorenUhrUndPruefung(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	an := BezugAnteil{AnteilKw: r3AnteilE4Kw, UngeregeltKw: gebaeudeImAbgangKw}
	tr := NewBudgetTracker()
	tr.Observe(t0, 0, 0, true)
	tr.Observe(t0.Add(100*time.Second), 0, 0, true)
	fr := an
	fr.EingefrorenSeit = t0
	if v := tr.BudgetAnteil(t0.Add(101*time.Second), verwaltungSet(), fr); v.Kw != 27 || v.EigenerZaehler ||
		!containsStr(v.Reason, "gilt als eingefroren") {
		t.Fatalf("frozen since 101 s: %+v, want blind 27", v)
	}
	if v := tr.BudgetAnteil(t0.Add(50*time.Second), verwaltungSet(), an); v.Kw != 27 || !containsStr(v.Reason, "zurückgesprungen") {
		t.Fatalf("clock behind the sample: %+v, want blind 27", v)
	}
	p := NewBudgetTracker()
	p.Observe(t0, 60, 60, true) // the park draws 60 > 27
	pr := an
	pr.Pruefen, pr.PruefenNeu = true, true
	v := p.BudgetAnteil(t0.Add(time.Second), verwaltungSet(), pr)
	if !v.Pruefung || v.Kw != round3(60-pruefSenkKw) {
		t.Fatalf("standing feeder value: %+v, want one probe to 60 − 2,1 kW", v)
	}
	q := NewBudgetTracker()
	q.Observe(t0, 20, 20, true) // the park draws 20 < 27: blindness changes nothing
	if v := q.BudgetAnteil(t0.Add(time.Second), verwaltungSet(), pr); v.Pruefung {
		t.Fatalf("draw below the blind figure: a probe although %s", v.Reason)
	}
}

// V5 with the building load behind the feeder as the new random source: the
// feeder reads building + charging; the share never lifts the budget above
// the same box without a share, a co-controlling box is never above its share,
// with a fresh feeder never above share − building (the loop holds whatever
// draws behind it), blind never above share − reserve − ungeregelt. The meter
// may freeze and the clock may jump as in the properties of IP-20/IP-27.
func TestEigenschaftAmEigenenZaehlerErweitertNie(t *testing.T) {
	rng := rand.New(rand.NewSource(2209))
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	frischGebunden, blindGezaehlt := 0, 0
	for run := 0; run < 400; run++ {
		set := Settings{
			GridLimitKw:    []float64{0, 30, 100, 550}[rng.Intn(4)],
			HouseReserveKw: float64(rng.Intn(80)),
			MaxHouseLoadKw: float64(rng.Intn(120)),
			StaticBudget:   rng.Intn(6) == 0,
		}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(400)) / 2, Fuehrt: rng.Intn(4) == 0,
			ReserveKw: reserveZufall(rng), UngeregeltKw: []float64{0, 0, 20, 50, 120}[rng.Intn(5)]}
		mit, ohne := NewBudgetTracker(), NewBudgetTracker()
		probe := &guards.Einfrierprobe{}
		friertAb, frozenGrid := rng.Intn(120), 0.0
		now, box := t0, t0
		gebaeude := float64(rng.Intn(150))
		for step := 0; step < 80; step++ {
			now = now.Add(time.Duration(rng.Intn(40)) * time.Second)
			box = now
			if rng.Intn(15) == 0 { // A8: the box clock jumps back
				box = now.Add(-time.Duration(rng.Intn(600)) * time.Second)
			}
			if rng.Intn(4) == 0 {
				gebaeude = float64(rng.Intn(150))
			}
			letzte := -1.0
			if rng.Intn(3) > 0 {
				laden := float64(rng.Intn(120))
				m := Measurement{GridKw: gebaeude + laden, ChargingKw: laden, Complete: rng.Intn(8) > 0}
				if step < friertAb {
					frozenGrid = m.GridKw
				} else {
					m.GridKw = frozenGrid
				}
				probe.Wert(box, m.GridKw)
				mit.ObserveM(box, m)
				ohne.ObserveM(box, m)
				if m.Complete && step < friertAb {
					letzte = gebaeude
				}
			}
			if rng.Intn(3) == 0 {
				probe.Verstellt(box, float64(rng.Intn(60)-30))
			}
			an.EingefrorenSeit, an.Pruefen, an.PruefenNeu = time.Time{}, false, false
			if seit, ok := probe.Eingefroren(box); ok {
				an.EingefrorenSeit = seit
			}
			if r, neu := probe.Pruefung(box); r > 0 {
				an.Pruefen, an.PruefenNeu = true, neu
			}
			v := mit.BudgetAnteil(box, set, an)
			if v.Pruefung {
				probe.Geprueft(box)
			}
			h := ohne.Budget(box, set)
			if v.Kw > h.Kw {
				t.Fatalf("run %d step %d: with a share %.3f kW > without %.3f kW (%+v, %s)", run, step, v.Kw, h.Kw, an, v.Reason)
			}
			if an.Fuehrt {
				continue
			}
			anteil := round3(an.AnteilKw)
			if v.Kw > anteil {
				t.Fatalf("run %d step %d: co-controlling box %.3f kW above its share %.3f", run, step, v.Kw, anteil)
			}
			// the sample just observed at this very moment: fresh, and the
			// loop's trailing rest is at least this building load
			if letzte >= 0 && v.EigenerZaehler {
				frischGebunden++
				if want := math.Max(anteil-letzte, 0); v.Kw > want+1e-9 {
					t.Fatalf("run %d step %d: fresh, building %.0f kW behind the feeder, budget %.3f > share − building %.3f (%s)",
						run, step, letzte, v.Kw, want, v.Reason)
				}
			}
			if !v.EigenerZaehler {
				blindGezaehlt++
				if want := math.Max(round3(anteil-an.ReserveKw)-an.UngeregeltKw, 0); v.Kw > want+1e-9 {
					t.Fatalf("run %d step %d: blind %.3f kW above share − reserve − ungeregelt %.3f (%+v, %s)", run, step, v.Kw, want, an, v.Reason)
				}
			}
		}
	}
	if frischGebunden < 2000 || blindGezaehlt < 2000 {
		t.Fatalf("the random sources do not reach both paths: %d fresh steps, %d blind", frischGebunden, blindGezaehlt)
	}
	t.Logf("%d fresh steps with a building behind the feeder, %d blind", frischGebunden, blindGezaehlt)
}
