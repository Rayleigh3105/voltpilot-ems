package guards

// AP-15 Folge of PR 1068 (finding 3): einSpielraum gives the headroom of ONE
// measurement out once - over all evaluations of it, not per evaluation. Two
// evaluations of the same moved sample (in the box: an urgent nudge and the
// tick before the next sample) each counted only the rise of their own
// evaluation, so the discharge took the headroom in the first and the
// producers got it again in the second. The loop model is the one of
// stehender_wert_test.go (Box Halle 1 at the M-3 point, Einfrierprobe wired
// as in the agent); ohneJeMessung is the mutation probe: the watchdog as on
// uems.

import (
	"math"
	"math/rand"
	"testing"
)

func withOhneJeMessung(t *testing.T, fn func()) {
	t.Helper()
	ohneJeMessung = true
	defer func() { ohneJeMessung = false }()
	fn()
}

// swHoechste is the largest real export at the connection point after the
// first probing adjustment (from second 0 when there is none).
func swHoechste(r swErgebnis) float64 {
	h := 0.0
	for _, x := range r.sek {
		if x.s >= r.pruefAb {
			h = math.Max(h, x.exportKw)
		}
	}
	return h
}

// swDoppelte counts the evaluations that read a sample an earlier evaluation
// already read, after the discharge ceiling rose on that sample - the case
// this file is about: what the discharge took is no headroom for the
// producers any more.
func swDoppelte(f swLauf, r swErgebnis) int {
	n, probe := 0, 0
	for i := 1; i < len(r.sek); i++ {
		x := r.sek[i]
		if x.s%f.takt == 0 {
			probe = i // the second a new sample arrives
			continue
		}
		ausgewertet := f.auswertung <= 1 || x.s%f.auswertung == 0
		if ausgewertet && probe > 0 && x.frisch && r.sek[i-1].entladungKw > r.sek[probe-1].entladungKw+1e-9 {
			n++
		}
	}
	return n
}

// Shown first, then healed: the discharge variant of the model (no sun, the
// probe lowers the battery), a healthy noise-free meter, a sample every 10 s
// and an evaluation every second. On uems two evaluations of one sample give
// the probe's headroom to the discharge AND to the producers: 98.0 -> 99.5 kW
// at the connection point. Healed the plant stays on its regulated point.
func TestEinSpielraumJeMessungZweiAuswertungen(t *testing.T) {
	regelpunkt := grenze100 - exportMargin(grenze100)
	for _, f := range []swLauf{
		{takt: 10, auswertung: 1, sonne: 1.5, entladung: 97.9, friertAb: math.MinInt},
		{takt: 10, auswertung: 5, sonne: 1.5, entladung: 97.9, friertAb: math.MinInt},
		{takt: 2, auswertung: 1, sonne: 1.5, entladung: 97.9, friertAb: math.MinInt},
	} {
		var alt swErgebnis
		withOhneJeMessung(t, func() { alt = f.fahre(t) })
		neu := f.fahre(t)
		hAlt, hNeu := swHoechste(alt), swHoechste(neu)
		t.Logf("takt %d s, Auswertung alle %d s: uems %.3f kW, je Messung %.3f kW (%d zweite Auswertungen mit Entladeanstieg)",
			f.takt, f.auswertung, hAlt, hNeu, swDoppelte(f, neu))
		if hAlt <= regelpunkt+1e-6 {
			t.Errorf("%+v: uems must show the double headroom above %.1f kW, got %.3f kW", f, regelpunkt, hAlt)
		}
		if hNeu > regelpunkt+1e-9 {
			t.Errorf("%+v: one measurement gave its headroom out twice: %.3f kW above the regulated point %.1f kW", f, hNeu, regelpunkt)
		}
	}
}

// Property, ohne Toleranz: healthy noise-free meters at every sample and
// evaluation rate, both actuators, random plans - the connection point never
// above the regulated point once the watchdog regulates (plus the half unit
// of the published cap's three decimals, round3: the plant follows the
// published number), never above the same box without a share (V5), and the
// source must really reach a second evaluation of one sample that raises the
// discharge.
func TestEinSpielraumJeMessungNieUeberDemRegelpunkt(t *testing.T) {
	rng := rand.New(rand.NewSource(20260923))
	regelpunkt := grenze100 - exportMargin(grenze100)
	doppelte := 0
	for i := 0; i < 200; i++ {
		f := swLauf{takt: []int{1, 2, 5, 10}[rng.Intn(4)], auswertung: []int{1, 2, 5, 10}[rng.Intn(4)],
			sonne: []float64{100, 1.5, 30}[rng.Intn(3)], entladung: 40 + 60*rng.Float64(), friertAb: math.MinInt, seed: rng.Int63()}
		r := f.fahre(t)
		doppelte += swDoppelte(f, r)
		for _, x := range r.sek {
			if x.s < 30 {
				continue // the start: the plant arrives from its plan
			}
			if x.exportKw > regelpunkt+0.0005 {
				t.Fatalf("%+v: second %d exports %.6f kW, above the regulated point %.1f kW", f, x.s, x.exportKw, regelpunkt)
			}
			if x.c.HeuteCapKw != nil && x.capKw > *x.c.HeuteCapKw+1e-9 {
				t.Fatalf("%+v: second %d above the watchdog without a share: %.3f > %.3f", f, x.s, x.capKw, *x.c.HeuteCapKw)
			}
		}
	}
	if doppelte < 20 {
		t.Fatalf("only %d second evaluations of one sample raised the discharge - the source does not reach the case", doppelte)
	}
	t.Logf("%d zweite Auswertungen einer Messung mit Entladeanstieg", doppelte)
}
