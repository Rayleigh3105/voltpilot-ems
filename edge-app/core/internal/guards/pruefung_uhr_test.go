package guards

// IP-27 healing package (vp-uems-v15-folge-waechter-a7-a8): the probing
// adjustment (finding A7, eingefroren.go Pruefung, exportanteil.go pruefen)
// and "Dauer statt Uhrzeit" (finding A8, ObserveMitSpeicher/CapAnteil,
// Einfrierprobe.Wert) on the feed-in side, played against a small plant of
// its own: Box Halle 1 (fuehrt, share 40 kW) with K-1 PV and a 60 kW market
// discharge behind the connection point, the partner's 30 kW rising to 60 kW
// five seconds after the failure (R9) - the same picture as zwei_agenten_test.

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

// prAnlage is Box Halle 1 in the loop: the watchdog, the probe, and a plant
// that follows the commanded PV cap and discharge at once. Samples every 10 s
// (with the probe fed first, as the agent does), the watchdog right after.
type prAnlage struct {
	l          *ExportLimiter
	p          *Einfrierprobe
	sonne      float64 // available PV of K-1
	partner    float64 // what the other box pushes (kW)
	dis        float64 // commanded (planned) discharge
	pv, batt   float64 // the plant: PV, battery (+ charge / - discharge)
	capAlt     float64 // last published cap
	friert     *float64
	uhr        time.Duration // offset of the box's clock
	pruefungen int
	eingefr    bool
}

func neuePrAnlage() *prAnlage {
	return &prAnlage{l: NewExportLimiter(), p: &Einfrierprobe{}, sonne: 100, partner: 30, dis: 60, pv: 8, batt: -60, capAlt: math.Inf(1)}
}

func (a *prAnlage) netz() float64 { return a.batt - a.pv - a.partner }

// takt runs one control tick at model time now: sample, watchdog, the plant
// follows the command.
func (a *prAnlage) takt(now time.Time) ExportCap {
	box := now.Add(a.uhr)
	g := a.netz()
	if a.friert != nil {
		g = *a.friert
	}
	a.p.Wert(box, g)
	b := a.batt
	a.l.ObserveMitSpeicher(box, g, a.pv, &b)
	an := halle1
	if seit, ok := a.p.Eingefroren(box); ok {
		an.EingefrorenSeit, a.eingefr = seit, true
	}
	if r, neu := a.p.Pruefung(box); r < 0 {
		an.Pruefen, an.PruefenNeu = true, neu
	}
	c := a.l.CapAnteil(box, &grenze100, an, a.dis)
	if c.Pruefung {
		a.pruefungen++
		a.p.Geprueft(box)
	}
	// what the setpoint MUST change at the meter (agent.einfrierSollwert)
	soll := -a.dis
	if c.DischargeCapKw != nil && -soll > *c.DischargeCapKw {
		soll = -*c.DischargeCapKw
	}
	a.p.Verstellt(box, WirksamGesenkt(a.capAlt, c.CapKw, a.pv)+WirksamSpeicher(a.batt, soll))
	a.capAlt = c.CapKw
	a.pv, a.batt = math.Min(a.sonne, c.CapKw), soll
	return c
}

// A7 at the guard: the meter freezes at 13:10:00 (the last change) while the
// box regulates; the partner rises at +5 s. Without the probing adjustment the
// box never adjusts and runs above its share without end (the finding: 2096 s
// in the two-agent test). With it: one probe after 30 s standstill, frozen 20 s
// later, and generation plus discharge on the share of 40 kW 90 s after the
// last value - the matrix row A7.
func TestPruefVerstellungEingefrorenAufDemAnteil(t *testing.T) {
	a := neuePrAnlage()
	for s := -60; s < 0; s += 10 { // alive and moving before the freeze
		a.partner = 30 + float64(s)/100
		a.takt(r9t0.Add(time.Duration(s) * time.Second))
	}
	a.partner = 30
	v := a.netz()
	a.takt(r9t0) // the last value: 13:10:00
	a.friert = &v
	auf := -1
	for s := 10; s <= 300; s += 10 {
		if s >= 5 {
			a.partner = 60
		}
		c := a.takt(r9t0.Add(time.Duration(s) * time.Second))
		if auf < 0 && c.CapKw+dischargeAllowed(c, a.dis) <= 40+1e-3 {
			auf = s
		}
	}
	if a.pruefungen != 1 {
		t.Fatalf("one probing adjustment per standstill, got %d", a.pruefungen)
	}
	if !a.eingefr {
		t.Fatal("the frozen meter was never judged frozen")
	}
	if auf < 0 || auf > 90 {
		t.Fatalf("on the share %d s after the last value, the matrix demands <= 90 s", auf)
	}
	t.Logf("probe at +30 s, frozen at +50 s, on the share of 40 kW at +%d s", auf)
}

// A healthy meter whose number happens to stand still: at most ONE probing
// adjustment per standstill, released braked once the value moved, and a new
// one only after a real change and a new standstill. It costs PruefSenkKw for
// one tick plus the braked return - measured here in kW x s.
func TestPruefVerstellungGesunderZaehler(t *testing.T) {
	a := neuePrAnlage()
	a.partner = 30 // steady plant: the loop converges and the value stands
	kosten := 0.0
	var alt float64
	for s := 0; s <= 600; s += 10 {
		c := a.takt(r9t0.Add(time.Duration(s) * time.Second))
		if a.eingefr {
			t.Fatalf("+%d s: a healthy meter judged frozen", s)
		}
		if s >= 120 { // converged: the cost is what the probe takes from the loop
			kosten += math.Max(alt-(c.CapKw+dischargeAllowed(c, a.dis)), 0) * 10
		}
		if s == 110 {
			alt = c.CapKw + dischargeAllowed(c, a.dis)
		}
	}
	// 600 s steady: a standstill needs 30 s, the answer and the braked
	// return take two ticks - never two probes within one standstill
	if a.pruefungen < 1 || a.pruefungen > 600/50+1 {
		t.Fatalf("%d probing adjustments in 600 s steady operation", a.pruefungen)
	}
	proPruefung := kosten / float64(max(a.pruefungen-1, 1))
	if proPruefung > PruefSenkKw*20+1e-6 {
		t.Fatalf("one probing adjustment costs %.1f kWs, more than %.1f kW for two ticks", proPruefung, PruefSenkKw)
	}
	t.Logf("%d probing adjustments in 600 s of a bit-identical healthy value, %.1f kWs (%.1f Wh) each",
		a.pruefungen, proPruefung, proPruefung/3.6)
}

// No false alarm: a box under its share never probes (resting plant), a box
// with nothing it could effectively lower never makes a pretend adjustment
// and so the probe never judges it frozen - it keeps regulating as today.
func TestPruefVerstellungKeinFehlalarm(t *testing.T) {
	// under the share: 30 kW generation, no discharge, share 40
	a := neuePrAnlage()
	a.sonne, a.dis, a.batt, a.pv, a.partner = 30, 0, 0, 30, 20
	for s := 0; s <= 300; s += 10 {
		a.takt(r9t0.Add(time.Duration(s) * time.Second))
	}
	if a.pruefungen != 0 || a.eingefr {
		t.Fatalf("under the share: %d probes, frozen %v", a.pruefungen, a.eingefr)
	}
	// nothing effectively lowerable: 1.5 kW PV + 1.5 kW discharge above a
	// share of 1 kW - the meter frozen, too
	l, p := NewExportLimiter(), &Einfrierprobe{}
	an := ExportAnteil{AnteilKw: 1, Fuehrt: true}
	for s := 0; s <= 300; s += 10 {
		now := r9t0.Add(time.Duration(s) * time.Second)
		p.Wert(now, -50)
		l.ObserveMitSpeicher(now, -50, 1.5, ptr(-1.5))
		an.Pruefen, an.PruefenNeu = false, false
		if r, neu := p.Pruefung(now); r < 0 {
			an.Pruefen, an.PruefenNeu = true, neu
		}
		c := l.CapAnteil(now, &grenze100, an, 1.5)
		if c.Pruefung {
			t.Fatalf("+%d s: a probe with nothing to lower (cap %.3f)", s, c.CapKw)
		}
		if _, ok := p.Eingefroren(now); ok {
			t.Fatalf("+%d s: frozen without an own adjustment", s)
		}
	}
}

// A8 at the guard: the clock of the leading box jumps 840 s back at 13:10:00.
// Every later sample is older than the last one; the watchdog re-anchors on
// it instead of discarding it, so the partner's rise at +5 s is seen at the
// next sample and cut within one tick - as without a jump.
func TestUhrZurueckNeuVerankert(t *testing.T) {
	a := neuePrAnlage()
	for s := -60; s <= 0; s += 10 {
		a.partner = 30 + float64(s)/100
		a.takt(r9t0.Add(time.Duration(s) * time.Second))
	}
	a.uhr = -840 * time.Second
	ueber, laengste := 0, 0
	for s := 1; s <= 300; s++ {
		if s >= 5 {
			a.partner = 60
		}
		if s%10 == 0 {
			a.takt(r9t0.Add(time.Duration(s) * time.Second))
		}
		if -a.netz() > 100+1e-6 {
			ueber++
			laengste = max(laengste, ueber)
		} else {
			ueber = 0
		}
	}
	if laengste > 10 {
		t.Fatalf("above the limit %d s at a stretch after the clock jumped back", laengste)
	}
}

// An age below zero is no age: evaluated after the jump but BEFORE the next
// sample, the watchdog is blind - on the share at once, never "fresh" on the
// last value before the jump. The next sample re-anchors, the release is
// braked. (Clamping the age to 0 again turns this red.)
func TestUhrZurueckVorDerNaechstenMessungBlind(t *testing.T) {
	l := NewExportLimiter()
	l.ObserveMitSpeicher(r9t0, -98, 38, ptr(-60))
	if c := l.CapAnteil(r9t0, &grenze100, halle1, 60); c.Blind {
		t.Fatalf("fresh before the jump: %+v", c)
	}
	nach := r9t0.Add(-840 * time.Second)
	c := l.CapAnteil(nach, &grenze100, halle1, 60)
	if !c.Blind || !c.Uhrsprung || c.CapKw+dischargeAllowed(c, 60) > 40+1e-3 {
		t.Fatalf("clock behind the sample: blind on the share, got blind=%v uhr=%v cap %.3f dis %.3f (%s)",
			c.Blind, c.Uhrsprung, c.CapKw, dischargeAllowed(c, 60), c.State)
	}
	if !contains(c.Reason, "zurückgesprungen") {
		t.Fatalf("the sentence names the clock: %q", c.Reason)
	}
	l.ObserveMitSpeicher(nach.Add(5*time.Second), -40, 0, ptr(-40))
	c = l.CapAnteil(nach.Add(5*time.Second), &grenze100, halle1, 60)
	if c.Blind || c.Uhrsprung {
		t.Fatalf("the next sample re-anchors: fresh again, got %+v", c)
	}
}

// A jump FORWARD (row A8, the partner's clock, holds today) stays holding:
// the sample after the jump is newer, the loop runs on.
func TestUhrVorHaelt(t *testing.T) {
	a := neuePrAnlage()
	for s := -60; s <= 0; s += 10 {
		a.partner = 30 + float64(s)/100
		a.takt(r9t0.Add(time.Duration(s) * time.Second))
	}
	a.uhr = 840 * time.Second
	for s := 10; s <= 120; s += 10 {
		a.partner = 60
		a.takt(r9t0.Add(time.Duration(s) * time.Second))
		if s >= 20 && -a.netz() > 100+1e-6 {
			t.Fatalf("+%d s: %.3f kW feed-in after the clock jumped ahead", s, -a.netz())
		}
	}
}

// The probe re-anchors on a clock that went back: the standstill it measured
// survives the jump, a value after it counts, the jump sample's own value
// does not un-freeze.
func TestEinfrierprobeUhrZurueck(t *testing.T) {
	p := &Einfrierprobe{}
	p.Wert(r9t0, -98)
	p.Wert(r9t0.Add(20*time.Second), -98)
	back := r9t0.Add(20*time.Second - 840*time.Second)
	p.Wert(back, -97) // the jump sample: re-anchors, proves nothing
	p.Wert(back.Add(10*time.Second), -98)
	if r, neu := p.Pruefung(back.Add(10 * time.Second)); r != -1 || !neu {
		t.Fatalf("30 s standstill across the jump: a probe is due, got %d %v", r, neu)
	}
	p.Wert(back.Add(20*time.Second), -95)
	if r, _ := p.Pruefung(back.Add(20 * time.Second)); r != 0 {
		t.Fatal("a value after the jump that moved re-anchors the standstill")
	}
}

// befundEinzelboxUhrZurueck: healed for the single box (Observe + Cap),
// authorized for the next box release on 2026-09-22. Previously 830 s above
// the limit, +28.0 kW: older samples were discarded and negative age was fresh.
// Picture: limit 100 kW, PV 150 kW available, house 50 kW; the clock jumps
// 840 s back, 5 s later the house drops to 20 kW. The test SHOWS the excess
// with these numbers; nil requires the limit to hold throughout.
var befundEinzelboxUhrZurueck *struct {
	laengsteS       int
	groessteUeberKw float64
} = nil

func TestEinzelboxUhrZurueckBefund(t *testing.T) {
	l := NewExportLimiter()
	pv, last := 148.0, 50.0
	uhr := time.Duration(0)
	lauf, laengste, groesste := 0, 0, 0.0
	for s := -120; s <= 1200; s++ {
		now := r9t0.Add(time.Duration(s) * time.Second)
		if s == 0 {
			uhr = -840 * time.Second
		}
		if s >= 5 {
			last = 20
		}
		box := now.Add(uhr)
		if s%5 == 0 {
			l.Observe(box, last-pv, pv)
		}
		c := l.Cap(box, &grenze100, 100)
		pv = math.Min(150, c.CapKw)
		if ueber := pv - last - 100; ueber > 1e-6 {
			lauf++
			laengste, groesste = max(laengste, lauf), math.Max(groesste, ueber)
		} else {
			lauf = 0
		}
	}
	b := befundEinzelboxUhrZurueck
	if b == nil {
		if laengste != 0 || groesste != 0 {
			t.Fatalf("Einzelbox Uhr zurück hält nicht: %d s / +%.1f kW", laengste, groesste)
		}
		t.Logf("Einzelbox ohne Anteils-Dokument, Uhr 840 s zurück: hält, %d s über der Grenze, +%.1f kW", laengste, groesste)
		return
	}
	if laengste < b.laengsteS-5 || laengste > b.laengsteS+5 || math.Abs(groesste-b.groessteUeberKw) > 0.1 {
		t.Fatalf("Befund Einzelbox Uhr zurück verändert: festgehalten %d s / +%.1f kW, gemessen %d s / +%.1f kW",
			b.laengsteS, b.groessteUeberKw, laengste, groesste)
	}
	t.Logf("BEFUND Einzelbox ohne Anteils-Dokument, Uhr 840 s zurück: %d s über der Grenze, größte Überschreitung +%.1f kW", laengste, groesste)
}

// "Der Waechter erweitert nie" with the new random sources of this package:
// the box's clock jumps back and ahead at random, and the probing adjustment
// runs (the probe's request goes in, its adjustments are reported back as
// the agent does). With a share the PV cap is never above the cap of the same
// box without one on the same (jumped) timestamps, and the allowed discharge
// never above the commanded one - exactly, without tolerance.
func TestAnteilErweitertNieMitUhrUndPruefung(t *testing.T) {
	rng := rand.New(rand.NewSource(27))
	pruefungen, spruenge, uhrBlind := 0, 0, 0
	for run := 0; run < 400; run++ {
		heute, anteil := NewExportLimiter(), NewExportLimiter()
		probe := &Einfrierprobe{}
		friertAb := rng.Intn(120)
		frozenGrid := 0.0
		limit := 20 + rng.Float64()*200
		an := ExportAnteil{AnteilKw: rng.Float64() * limit, Fuehrt: rng.Intn(2) == 0}
		now := r9t0
		uhr := time.Duration(0)
		for step := 0; step < 80; step++ {
			now = now.Add(time.Duration(1+rng.Intn(40)) * time.Second)
			if rng.Intn(12) == 0 { // the clock jumps, back or ahead
				uhr += time.Duration(rng.Intn(1800)-900) * time.Second
				spruenge++
			}
			box := now.Add(uhr)
			if rng.Intn(3) > 0 {
				grid := -rng.Float64()*1.5*limit + rng.Float64()*50
				if rng.Intn(4) == 0 {
					grid = frozenGrid // a standstill, sometimes
				}
				if step < friertAb {
					frozenGrid = grid
				} else {
					grid = frozenGrid
				}
				pv := rng.Float64() * 1.5 * limit
				batt := -rng.Float64() * limit
				probe.Wert(box, grid)
				heute.Observe(box, grid, pv)
				anteil.ObserveMitSpeicher(box, grid, pv, &batt)
			}
			if rng.Intn(3) == 0 {
				probe.Verstellt(box, (rng.Float64()-0.5)*limit)
			}
			an.EingefrorenSeit, an.Pruefen, an.PruefenNeu = time.Time{}, false, false
			if seit, ok := probe.Eingefroren(box); ok {
				an.EingefrorenSeit = seit
			}
			if r, neu := probe.Pruefung(box); r < 0 || rng.Intn(8) == 0 {
				an.Pruefen, an.PruefenNeu = true, neu || rng.Intn(2) == 0
			}
			var lim *float64
			if rng.Intn(6) > 0 {
				lim = &limit
			}
			d := 0.0
			if rng.Intn(2) == 0 {
				d = rng.Float64() * limit
			}
			h := heute.Cap(box, lim, exportSafeStatic(lim, d))
			a := anteil.CapAnteil(box, lim, an, d)
			if a.Pruefung {
				pruefungen++
				probe.Geprueft(box)
				probe.Verstellt(box, PruefSenkKw)
			}
			if a.Uhrsprung {
				uhrBlind++
			}
			if h.Active && a.CapKw > h.CapKw {
				t.Fatalf("run %d step %d: with share %.3f (%s) > without %.3f (%s)",
					run, step, a.CapKw, a.State, h.CapKw, h.State)
			}
			if dischargeAllowed(a, d) > d+1e-9 || dischargeAllowed(a, d) < 0 {
				t.Fatalf("run %d step %d: discharge raised or turned into a charge", run, step)
			}
		}
	}
	if pruefungen < 100 || spruenge < 100 || uhrBlind < 20 {
		t.Fatalf("the random sources do not reach the new paths: %d probes, %d jumps, %d blind by the clock",
			pruefungen, spruenge, uhrBlind)
	}
	t.Logf("%d probing adjustments, %d clock jumps, %d steps blind by the clock", pruefungen, spruenge, uhrBlind)
}

// The battery side of the import probe: the leading box lowers a grid charge
// ONCE to PruefSenkKw below the measured charge and keeps that ceiling while
// the probe runs; a charge its own PV covers (what it falls back to blind),
// or one too small to show, is never probed.
func TestNetzladenPruefung(t *testing.T) {
	in := Netzladen{Fuehrt: true, Fresh: true, Limit: true, PlanableKw: 495, GridKw: 480, BattChargeKw: 30, PvKw: 0,
		Pruefen: true, PruefenNeu: true}
	d := NetzladenDeckelFuer(in)
	if !d.Pruefung || d.PruefKw == nil || *d.PruefKw != 27.9 || d.DeckelKw != 27.9 {
		t.Fatalf("probe: ceiling 27.9 kW, got %+v", d)
	}
	in.PruefenNeu, in.PruefKw, in.BattChargeKw = false, d.PruefKw, 27.9
	if d := NetzladenDeckelFuer(in); d.Pruefung || d.DeckelKw != 27.9 {
		t.Fatalf("running: the ceiling is kept, no second probe, got %+v", d)
	}
	for _, c := range []struct{ batt, pv float64 }{{30, 40}, {2, 0}} {
		in := Netzladen{Fuehrt: true, Fresh: true, Limit: true, PlanableKw: 495, GridKw: 480, BattChargeKw: c.batt, PvKw: c.pv,
			Pruefen: true, PruefenNeu: true}
		if d := NetzladenDeckelFuer(in); d.Pruefung || d.PruefKw != nil {
			t.Fatalf("batt %.1f pv %.1f: no probe, got %+v", c.batt, c.pv, d)
		}
	}
}
