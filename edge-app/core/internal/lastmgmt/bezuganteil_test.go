package lastmgmt

// AP-15 IP-19: the charging budget with a share, proven with the figures of
// referenzfaelle.json (vp-uems-ap15-verbund): R3 (77 kW, worst case 550 kW)
// and R13 („Jetzt voll laden" inside 77 kW), plus the leading box's blind
// stages and the property "der Waechter erweitert nie".

import (
	"fmt"
	"math"
	"math/rand"
	"testing"
	"time"
)

// R3, Anlage AN-1: 550 kW connection, Vorbehalt 473 kW, verteilbar 77 kW -
// E-1 (Halle 1, fuehrt) 0 kW, E-4 (Verwaltung, steuert mit) 77 kW.
const (
	r3AnschlussKw = 550.0
	r3VorbehaltKw = 473.0
	r3AnteilE1Kw  = 0.0
	r3AnteilE4Kw  = 77.0
)

// verwaltungSet is the Ladepark-Rahmen of Box Verwaltung as today's
// charging-config document carries it: the connection limit of the site.
func verwaltungSet() Settings {
	return Settings{GridLimitKw: r3AnschlussKw, HouseReserveKw: 40, MaxHouseLoadKw: 60}
}

// sechsFahrzeuge want 6 × 22 kW = 132 kW (R3 Eingang).
func sechsFahrzeuge(t0 time.Time) []Session {
	var s []Session
	for i := 1; i <= 6; i++ {
		s = append(s, Session{Key: fmt.Sprintf("AHR-LP-%02d#1", i), MinKw: 4.1, MaxKw: 22, Since: t0.Add(time.Duration(i) * time.Second)})
	}
	return s
}

func summe(p Plan) float64 {
	sum := 0.0
	for _, a := range p.Allocations {
		sum += a.Kw
	}
	return math.Round(sum*1000) / 1000
}

// R3: six vehicles want 132 kW; Box Verwaltung hands out 77 kW in total -
// with a fresh measurement of its feeder, without any connection (10 min
// blind), and after a restart before the first sample. The same box without a
// document would hand out 132 kW in each of the three.
func TestR3SechsLadepunkteBekommenZusammenDenAnteilVon77kW(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	an := BezugAnteil{AnteilKw: r3AnteilE4Kw}
	for name, tr := range map[string]func() (*BudgetTracker, time.Time){
		"frisch": func() (*BudgetTracker, time.Time) {
			tr := NewBudgetTracker()
			tr.Observe(t0, 38, 0, true) // the feeder of Verwaltung: its building only
			return tr, t0.Add(5 * time.Second)
		},
		"ohne Verbindung": func() (*BudgetTracker, time.Time) {
			tr := NewBudgetTracker()
			tr.Observe(t0, 38, 0, true)
			return tr, t0.Add(10 * time.Minute)
		},
		"nach Neustart": func() (*BudgetTracker, time.Time) { return NewBudgetTracker(), t0 },
	} {
		tr, now := tr()
		v := tr.BudgetAnteil(now, verwaltungSet(), an)
		if v.Kw != 77 || !v.AnteilBinds || v.Measured() {
			t.Fatalf("%s: budget %+v, want the share 77 kW", name, v)
		}
		p := Decide(Input{Settings: verwaltungSet(), Sessions: sechsFahrzeuge(t0), BudgetKw: &v.Kw, Now: now})
		// ≤ 77 always; 77,0 at one decimal (the allocator rounds each of the
		// six shares of 12,833 kW to the watt, 76,998 kW together)
		if got := summe(p); got > 77 || got < 77-0.006 {
			t.Fatalf("%s: the six charge points get %.3f kW together, want 77,0 and never more (R3 laden_kw)", name, got)
		}
		// Without a document the same box is today's: the connection limit.
		heute := NewBudgetTracker().Budget(now, verwaltungSet())
		if q := Decide(Input{Settings: verwaltungSet(), Sessions: sechsFahrzeuge(t0), BudgetKw: &heute.Kw, Now: now}); summe(q) != 132 {
			t.Fatalf("%s: without a share the six vehicles get %.3f, want all 132 kW", name, summe(q))
		}
	}
}

// R3 Schritt 4, the worst case without any connection and without sun: the
// uncontrolled load at its reserve, Box Verwaltung at its share, Box Halle 1
// blind - its charge park on its share of 0 kW and its battery charging
// nothing from the grid (guards.NetzladenDeckelFuer, proven in guards) -
// together 473 + 77 + 0 = 550 kW, the connection limit.
func TestR3SchlimmsterFallOhneVerbindungIst550kW(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	later := t0.Add(3 * time.Hour)

	e4 := NewBudgetTracker()
	e4.Observe(t0, 38, 0, true)
	verwaltung := e4.BudgetAnteil(later, verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw})

	e1 := NewBudgetTracker()
	e1.Observe(t0, 367, 0, true) // the whole connection point, measured once
	halle1 := e1.BudgetAnteil(later, Settings{GridLimitKw: r3AnschlussKw, HouseReserveKw: 300, MaxHouseLoadKw: 473},
		BezugAnteil{AnteilKw: r3AnteilE1Kw, Fuehrt: true})

	const netzladenHalle1 = 0.0 // blind, no sun: see guards.TestR3FuehrendeBoxBlindLaedtNichtAusDemNetz
	worst := r3VorbehaltKw + verwaltung.Kw + halle1.Kw + netzladenHalle1
	if verwaltung.Kw != 77 || halle1.Kw != 0 || worst != 550 {
		t.Fatalf("worst case %.1f kW (Verwaltung %.1f, Halle 1 %.1f), want 473 + 77 + 0 = 550", worst, verwaltung.Kw, halle1.Kw)
	}
	if worst > r3AnschlussKw {
		t.Fatalf("worst case %.1f kW above the connection limit", worst)
	}
}

// R13: „Jetzt voll laden" at AHR-LP-03 wins against the plan at THAT station
// (22 kW) - and the other five share what is left of the 77 kW. The share is
// a guard above the arbitration: the boost does not lift it.
func TestR13JetztVollLadenGewinntInnerhalbVon77kW(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 20, 0, 0, time.UTC)
	tr := NewBudgetTracker()
	tr.Observe(t0, 38, 0, true)
	v := tr.BudgetAnteil(t0.Add(5*time.Second), verwaltungSet(), BezugAnteil{AnteilKw: r3AnteilE4Kw})
	s := sechsFahrzeuge(t0.Add(-time.Hour))
	s[2].BoostUntil = t0.Add(time.Hour)
	p := Decide(Input{Settings: verwaltungSet(), Sessions: s, BudgetKw: &v.Kw, Now: t0})
	lp03, _ := p.Get("AHR-LP-03#1")
	if lp03.Kw != 22 || summe(p) != 77 {
		t.Fatalf("LP-03 %.3f kW, park %.3f kW; want 22 and 77 (R13)", lp03.Kw, summe(p))
	}
	if rest := summe(p) - lp03.Kw; rest != 55 {
		t.Fatalf("the other five share %.3f kW, want 55", rest)
	}
}

// The leading box regulates the WHOLE limit while it measures (today's loop,
// its share does not bind); older than 30 s it pulls the budget WITHOUT
// holding within 60 s linearly to its share; before the first sample the
// share holds at once (R15).
func TestFuehrendeBoxBlindAufDenAnteilOhneHalten(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	set := Settings{GridLimitKw: 550, HouseReserveKw: 300, MaxHouseLoadKw: 473}
	an := BezugAnteil{AnteilKw: 20, Fuehrt: true}
	tr := NewBudgetTracker()
	tr.Observe(t0, 367, 0, true)

	frisch := tr.BudgetAnteil(t0.Add(10*time.Second), set, an)
	// planable 495 − rest 367 = 128 kW: today's loop, the share does not bind
	if !frisch.Measured() || frisch.Kw != 128 || frisch.AnteilBinds {
		t.Fatalf("fresh: %+v, want today's measured 128 kW", frisch)
	}
	halb := tr.BudgetAnteil(t0.Add(60*time.Second), set, an) // 30 s into the ramp
	if halb.Mode != BudgetContracting || !halb.Blind || halb.Kw != 74 {
		t.Fatalf("mid-ramp: %+v, want zieht_zusammen 128 − (128 − 20)/2 = 74 kW", halb)
	}
	// today's budget.go would still HOLD 128 kW here (hold window 90 s)
	if heute := tr.Budget(t0.Add(60*time.Second), set); heute.Mode != BudgetHolding || heute.Kw != 128 {
		t.Fatalf("today's evaluation: %+v", heute)
	}
	an2 := tr.BudgetAnteil(t0.Add(91*time.Second), set, an)
	if an2.Mode != BudgetSafe || an2.Kw != 20 || !an2.AnteilBinds {
		t.Fatalf("after the ramp: %+v, want sicherheitsbudget on the share 20 kW", an2)
	}
	neu := NewBudgetTracker().BudgetAnteil(t0, set, an)
	if neu.Kw != 20 || neu.Mode != BudgetStatic || !neu.AnteilBinds {
		t.Fatalf("before the first sample: %+v, want the share 20 kW", neu)
	}
	// a fresh sample returns the loop at once
	tr.Observe(t0.Add(100*time.Second), 367, 0, true)
	if back := tr.BudgetAnteil(t0.Add(101*time.Second), set, an); !back.Measured() || back.AnteilBinds {
		t.Fatalf("fresh again: %+v", back)
	}
}

// A document without a role is the safe side: the share holds like
// steuert_mit, also with a fresh measurement of the connection point.
func TestOhneRolleGiltDerAnteilImmer(t *testing.T) {
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	tr := NewBudgetTracker()
	tr.Observe(t0, 100, 0, true)
	v := tr.BudgetAnteil(t0.Add(time.Second), Settings{GridLimitKw: 550}, BezugAnteil{AnteilKw: 30})
	if v.Kw != 30 || !v.AnteilBinds {
		t.Fatalf("no role: %+v, want the share 30 kW", v)
	}
}

// V5, "der Waechter erweitert nie": two trackers fed the SAME samples - one
// evaluated with a share, one without. At every step, for every role and
// share, the budget with a share is never above the one without - exactly,
// without a tolerance. The minimum with today's evaluation is the
// construction; a mutation that drops it goes red here at once (a share above
// today's budget).
func TestEigenschaftDerWaechterErweitertNie(t *testing.T) {
	rng := rand.New(rand.NewSource(19))
	t0 := time.Date(2027, 6, 15, 10, 0, 0, 0, time.UTC)
	for run := 0; run < 400; run++ {
		set := Settings{
			GridLimitKw:    []float64{0, 30, 100, 550}[rng.Intn(4)],
			HouseReserveKw: float64(rng.Intn(80)),
			MaxHouseLoadKw: float64(rng.Intn(120)),
			StaticBudget:   rng.Intn(6) == 0,
		}
		an := BezugAnteil{AnteilKw: float64(rng.Intn(700)) / 2, Fuehrt: rng.Intn(2) == 0}
		mit, ohne := NewBudgetTracker(), NewBudgetTracker()
		now := t0
		for step := 0; step < 60; step++ {
			now = now.Add(time.Duration(rng.Intn(40)) * time.Second)
			if rng.Intn(3) > 0 {
				m := Measurement{GridKw: float64(rng.Intn(700) - 150), ChargingKw: float64(rng.Intn(100)), Complete: rng.Intn(8) > 0}
				mit.ObserveM(now, m)
				ohne.ObserveM(now, m)
			}
			if rng.Intn(5) == 0 {
				kw := float64(rng.Intn(400))
				mit.ObserveGridLimit(kw)
				ohne.ObserveGridLimit(kw)
			}
			v := mit.BudgetAnteil(now, set, an)
			h := ohne.Budget(now, set)
			if v.Kw > h.Kw {
				t.Fatalf("run %d step %d: with a share %.3f kW > without %.3f kW (%+v, %+v)", run, step, v.Kw, h.Kw, an, set)
			}
			if !an.Fuehrt && v.Kw > round3(an.AnteilKw) {
				t.Fatalf("run %d step %d: co-controlling box %.3f kW above its share %.3f", run, step, v.Kw, an.AnteilKw)
			}
		}
	}
}
