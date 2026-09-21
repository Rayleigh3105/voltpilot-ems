package guards

// IP-18 finding (from the healing package of IP-27): after a blind state in
// which the watchdog lowered BOTH the producers and the discharge (V6), the
// first fresh measurement shows one headroom - and the PV law of
// exportlimit.go and the discharge law of exportanteil.go each claimed all of
// it. One headroom is given out once: the discharge first (the last actuator
// to be cut is the first to be released), the producers with what is left.

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

// dfLauf plays Box Halle 1 (fuehrt, share 40 kW, 60 kW market discharge, PV
// 100 kW available) behind NA-1 with the partner pushing 30 kW: the plant
// follows every command at once, a sample every 10 s, the watchdog right
// after. From 13:10:00 the samples stop for luecke - the box goes blind and
// ramps generation and discharge to its share - then they come back. It
// returns the largest excess over 100 kW and the seconds above it after the
// return.
func dfLauf(t *testing.T, luecke time.Duration) (groessteKw float64, sekunden int) {
	t.Helper()
	l := NewExportLimiter()
	sonne, partner, dis := 100.0, 30.0, 60.0
	pv, batt := 8.0, -60.0
	netz := func() float64 { return batt - pv - partner }
	for s := -120; s <= 600; s++ {
		now := r9t0.Add(time.Duration(s) * time.Second)
		if s%10 == 0 {
			seit := time.Duration(s) * time.Second
			if s < 0 || seit >= luecke {
				b := batt
				l.ObserveMitSpeicher(now, netz(), pv, &b)
			}
			c := l.CapAnteil(now, &grenze100, halle1, dis)
			pv, batt = math.Min(sonne, c.CapKw), -math.Min(dis, dischargeAllowed(c, dis))
		}
		if ueber := -netz() - 100; ueber > 1e-9 {
			groessteKw = math.Max(groessteKw, ueber)
			sekunden++
		}
	}
	return groessteKw, sekunden
}

// Blind long enough to arrive on the share (PV 0 kW, discharge 40 kW), then
// the measurement is back: 70 kW feed-in, 28 kW of headroom below the limit
// minus margin. Given out once: nothing above 100 kW, at no second.
func TestDoppelfreigabeNachBlindEinSpielraum(t *testing.T) {
	for _, luecke := range []time.Duration{60 * time.Second, 120 * time.Second, 300 * time.Second} {
		kw, s := dfLauf(t, luecke)
		if s > 0 {
			t.Errorf("blind %v, then fresh: %d s above the limit, largest excess +%.1f kW - one headroom given out twice",
				luecke, s, kw)
		}
	}
}

// "Der Waechter erweitert nie", the release half: random plants, shares,
// discharges and gaps - blind with generation AND discharge lowered, then
// fresh again - with a plant that follows every command at once and a rest of
// the connection point that stays put while the box measures. After every
// fresh evaluation the feed-in at the box's point stays at or below its loop
// limit - exactly, without tolerance (the margin is >= 0.3 kW, the write
// hysteresis 0.1 kW). And with a share never above the same box without one.
func TestAnteilFreigabeEinmalNachBlind(t *testing.T) {
	rng := rand.New(rand.NewSource(18))
	uebergaenge := 0
	for run := 0; run < 400; run++ {
		heute, l := NewExportLimiter(), NewExportLimiter()
		limit := 20 + rng.Float64()*200
		an := ExportAnteil{AnteilKw: rng.Float64() * limit, Fuehrt: rng.Intn(2) == 0}
		loop := limit
		if !an.Fuehrt {
			loop = an.AnteilKw
		}
		sonne := rng.Float64() * 1.5 * limit
		dis := rng.Float64() * limit
		rest := rng.Float64()*limit - limit/2 // + the rest pushes too, - it draws
		// the plant starts on its plan: a discharge the plan raises is not the
		// watchdog's release (the same for the box without a share)
		pv, batt := 0.0, -dis
		now, blind := r9t0, false
		for step := 0; step < 120; step++ {
			now = now.Add(10 * time.Second)
			if rng.Intn(15) == 0 { // a gap begins or ends
				blind = !blind
				if blind {
					rest = rng.Float64()*limit - limit/2 // it may change unseen
				}
			}
			netz := batt - pv - rest
			if !blind {
				b := batt
				heute.Observe(now, netz, pv)
				l.ObserveMitSpeicher(now, netz, pv, &b)
			}
			h := heute.Cap(now, &limit, exportSafeStatic(&limit, dis))
			c := l.CapAnteil(now, &limit, an, dis)
			if h.Active && c.CapKw > h.CapKw {
				t.Fatalf("run %d step %d: with share %.3f > without %.3f", run, step, c.CapKw, h.CapKw)
			}
			war := c.Blind
			pv, batt = math.Min(sonne, c.CapKw), -math.Min(dis, dischargeAllowed(c, dis))
			if war || blind || rest > loop-exportMargin(loop) {
				continue // blind, or the rest alone leaves the box nothing to hold
			}
			if einspeisung := pv - batt + rest; einspeisung > loop {
				t.Fatalf("run %d step %d: after a fresh evaluation %.3f kW feed-in above the loop limit %.3f (PV %.3f, discharge %.3f, rest %.3f)",
					run, step, einspeisung, loop, pv, -batt, rest)
			}
			if l.dcapValid && l.dcap < dis {
				uebergaenge++
			}
		}
	}
	if uebergaenge < 200 {
		t.Fatalf("the discharge ceiling bound in only %d fresh evaluations - the source does not reach the release", uebergaenge)
	}
	t.Logf("%d fresh evaluations with a binding discharge ceiling", uebergaenge)
}
