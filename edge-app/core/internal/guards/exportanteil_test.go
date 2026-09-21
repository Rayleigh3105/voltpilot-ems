package guards

// AP-15 IP-18: the feed-in watchdog with a share, proven with the numbers of
// the reference cases (vp-uems-ap15-verbund/referenzfaelle.json): Ahrenberg,
// connection point NA-1, feed-in limit 100 kW, shares 40 kW (Box Halle 1, E-1,
// fuehrt) / 60 kW (Box Verwaltung, E-4, steuert_mit). Before 13:10 (R5):
// load 40, PV E-4 55, PV E-1 83 (the loop allows exactly that), feed-in 98.

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

var (
	r9t0      = time.Date(2027, 6, 13, 13, 10, 0, 0, time.UTC)
	grenze100 = 100.0
	halle1    = ExportAnteil{AnteilKw: 40, Fuehrt: true}
	verwalt   = ExportAnteil{AnteilKw: 60}
)

func near(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 5e-4 { // results are rounded to watts (round3)
		t.Fatalf("%s: got %.4f kW, want %.4f kW", what, got, want)
	}
}

func dischargeAllowed(c ExportCap, commanded float64) float64 {
	if c.DischargeCapKw != nil && *c.DischargeCapKw < commanded {
		return *c.DischargeCapKw
	}
	return commanded
}

// R9, second by second: the meter's last value is 13:10:00. Fresh (closed
// loop) up to and including 13:10:30, then linear WITHOUT holding, at 13:11:30
// on the share of 40 kW, and there it stays.
func TestR9FuehrendeBoxOhneHaltenInNeunzigSekundenAufDenAnteil(t *testing.T) {
	l := NewExportLimiter()
	l.ObserveMitSpeicher(r9t0, -98, 83, ptr(0))
	var prev float64
	for s := 0; s <= 120; s++ {
		c := l.CapAnteil(r9t0.Add(time.Duration(s)*time.Second), &grenze100, halle1, 0)
		switch {
		case s <= 30:
			if c.Blind || c.State != ExportLimiting {
				t.Fatalf("13:10:%02d must still be the closed loop, got %s", s, c.State)
			}
			near(t, "loop cap", c.CapKw, 83)
		case s < 90:
			want := 83 - (83-40)*float64(s-30)/60
			near(t, "ramp", c.CapKw, want)
			if c.State != ExportContracting || c.CapKw >= prev {
				t.Fatalf("second %d: no hold allowed - %s at %.3f after %.3f", s, c.State, c.CapKw, prev)
			}
		default:
			if c.State != ExportSafeCap {
				t.Fatalf("second %d: expected sicherheitskappe, got %s", s, c.State)
			}
			near(t, "share", c.CapKw, 40)
		}
		prev = c.CapKw
	}
}

// R9 with the battery discharging 60 kW for the market: at 13:11:30
// generation AND discharge together are at most the share of 40 kW (V6).
func TestR9AuchBei60kWEntladungHoechstens40kW(t *testing.T) {
	l := NewExportLimiter()
	// E-1: 23 kW PV + 60 kW discharge = 83 kW, feed-in 98 at the meter
	l.ObserveMitSpeicher(r9t0, -98, 23, ptr(-60))
	c := l.CapAnteil(r9t0, &grenze100, halle1, 60)
	near(t, "loop cap", c.CapKw, 23)
	if c.DischargeCapKw != nil {
		t.Fatalf("fresh, producers not at 0: the discharge is untouched, got %v", *c.DischargeCapKw)
	}
	half := l.CapAnteil(r9t0.Add(60*time.Second), &grenze100, halle1, 60)
	near(t, "PV at :60", half.CapKw, 11.5)
	near(t, "discharge at :60", dischargeAllowed(half, 60), 50)
	for s := 90; s <= 600; s += 30 {
		c := l.CapAnteil(r9t0.Add(time.Duration(s)*time.Second), &grenze100, halle1, 60)
		sum := c.CapKw + dischargeAllowed(c, 60)
		if c.State != ExportSafeCap || sum > 40+1e-9 {
			t.Fatalf("second %d: %s, PV %.3f + discharge %.3f = %.3f > 40", s, c.State, c.CapKw, dischargeAllowed(c, 60), sum)
		}
		near(t, "discharge lowered to the share", dischargeAllowed(c, 60), 40)
	}
}

// R9 "heute_waere_es_s": 390. The same box without a document holds 90 s and
// contracts 5 min - to limit minus discharge, not to a share.
func TestR9OhneDokumentWieHeute390Sekunden(t *testing.T) {
	l := NewExportLimiter()
	l.Observe(r9t0, -98, 83)
	l.Cap(r9t0, &grenze100, 100)
	if c := l.Cap(r9t0.Add(90*time.Second), &grenze100, 100); c.State != ExportHolding {
		t.Fatalf("today at :90 = haelt, got %s", c.State)
	}
	if c := l.Cap(r9t0.Add(389*time.Second), &grenze100, 100); c.State == ExportSafeCap {
		t.Fatalf("today at 389 s not yet on the safe cap, got %s", c.State)
	}
	if c := l.Cap(r9t0.Add(391*time.Second), &grenze100, 100); c.State != ExportSafeCap {
		t.Fatalf("today after 390 s on the safe cap, got %s", c.State)
	}
}

// R15: restart in the middle of curtailing. The share was loaded before the
// first measurement; the first setpoint is already the share - also with a
// discharge - and the first fresh value releases braked, over 60 s.
func TestR15NeustartErsterSollwertIstSchonDerAnteil(t *testing.T) {
	l := NewExportLimiter() // the new process: nothing measured
	start := r9t0.Add(10 * time.Minute)
	c := l.CapAnteil(start, &grenze100, halle1, 0)
	if c.State != ExportSafeCap || !c.Blind {
		t.Fatalf("never measured = sicherheitskappe, got %+v", c)
	}
	near(t, "erster_sollwert_kw", c.CapKw, 40)
	d := l.CapAnteil(start, &grenze100, halle1, 60)
	near(t, "first setpoint with discharge, PV", d.CapKw, 0)
	near(t, "first setpoint with discharge, battery", dischargeAllowed(d, 60), 40)
	// also without any plan (V5: a missing plan takes no share away)
	e := NewExportLimiter().CapAnteil(start, nil, halle1, 0)
	if !e.Active {
		t.Fatal("without a plan the share must still hold")
	}
	near(t, "share without plan", e.CapKw, 40)

	// first fresh meter value 10 s later: the loop wants 83, but releasing is braked
	l.CapAnteil(start.Add(5*time.Second), &grenze100, halle1, 0)
	l.ObserveMitSpeicher(start.Add(10*time.Second), -98, 40, ptr(0))
	f := l.CapAnteil(start.Add(10*time.Second), &grenze100, halle1, 0)
	if f.Blind || f.CapKw > 40+releaseRate(100)*5+1e-9 {
		t.Fatalf("release after the restart must be braked, got %.3f (%s)", f.CapKw, f.State)
	}
	g := l.CapAnteil(start.Add(70*time.Second), &grenze100, halle1, 0)
	if g.CapKw < f.CapKw {
		t.Fatalf("the loop releases over time: %.3f after %.3f", g.CapKw, f.CapKw)
	}
}

// Co-controlling box with a feeder meter: it regulates its share at its OWN
// point - the whole limit of the connection point is never its input (G1).
func TestMitsteuerndAbgangszaehlerFrischHaeltDenAnteil(t *testing.T) {
	var caps []float64
	for _, lim := range []*float64{nil, &grenze100, ptr(1000)} {
		l := NewExportLimiter()
		l.ObserveMitSpeicher(r9t0, -58, 70, nil) // 70 kW PV, 12 kW house behind the feeder
		c := l.CapAnteil(r9t0, lim, verwalt, 0)
		caps = append(caps, c.CapKw)
		if c.LimitKw != 60 || c.Blind {
			t.Fatalf("loop limit must be the share: %+v", c)
		}
	}
	// 70 + (60 - 58) - 1.2 = 70.8: the house behind the feeder is netted in
	near(t, "feeder loop", caps[0], 70.8)
	if caps[1] != caps[0] || caps[2] != caps[0] {
		t.Fatalf("the whole limit changed the co-controlling box's cap: %v", caps)
	}
}

// Co-controlling box whose feeder value is missing: `share - discharge`, like
// today's static cap (V4) - and without holding.
func TestMitsteuerndOhneMesswertAnteilMinusEntladung(t *testing.T) {
	l := NewExportLimiter()
	c := l.CapAnteil(r9t0, &grenze100, verwalt, 25)
	near(t, "share - discharge", c.CapKw, 35)
	l.ObserveMitSpeicher(r9t0, -58, 70, nil)
	l.CapAnteil(r9t0, nil, verwalt, 25)
	d := l.CapAnteil(r9t0.Add(90*time.Second), nil, verwalt, 25)
	near(t, "blind after 90 s", d.CapKw, 35)
	if d.State != ExportSafeCap {
		t.Fatalf("expected sicherheitskappe, got %s", d.State)
	}
}

// Co-controlling box without any meter: the sum of its devices (B3) - a
// charging battery is netted in, a discharging one counts, an unmeasured
// battery is no sum at all.
func TestMitsteuerndGeraetesumme(t *testing.T) {
	if _, ok := GeraeteSummeNetz(50, nil); ok {
		t.Fatal("unknown battery is not zero")
	}
	g, _ := GeraeteSummeNetz(70, ptr(20)) // 70 PV, 20 charging: 50 pushed out
	near(t, "device sum", g, -50)
	l := NewExportLimiter()
	l.ObserveMitSpeicher(r9t0, g, 70, ptr(20))
	c := l.CapAnteil(r9t0, nil, verwalt, 0)
	near(t, "cap nets the charge", c.CapKw, 70+(60-50)-1.2)
}

// V6 with a fresh measurement: the discharge is the LAST actuator - lowered
// only once the producers are at 0, and only as far as needed; never below 0.
func TestV6FrischEntladungErstWennErzeugerAufNull(t *testing.T) {
	l := NewExportLimiter()
	// E-1 discharges 100 kW with 10 kW PV; partner and house put 58 kW on top
	l.ObserveMitSpeicher(r9t0, -168, 10, ptr(-100))
	c := l.CapAnteil(r9t0, &grenze100, halle1, 100)
	near(t, "producers first", c.CapKw, 0)
	// 10 + 100 + (100 - 168) - 2 = 40: what remains of the total for the battery
	near(t, "discharge ceiling", dischargeAllowed(c, 100), 40)
	// the battery now does 40: 100 - 2 kW margin at the meter - stable, no release
	l.ObserveMitSpeicher(r9t0.Add(5*time.Second), -108, 10, ptr(-40))
	s := l.CapAnteil(r9t0.Add(5*time.Second), &grenze100, halle1, 100)
	near(t, "converged", dischargeAllowed(s, 100), 40)
	// the producers alone can hold it: the battery stays untouched
	m := NewExportLimiter()
	m.ObserveMitSpeicher(r9t0, -110, 30, ptr(-20))
	if c := m.CapAnteil(r9t0, &grenze100, halle1, 20); c.DischargeCapKw != nil || c.CapKw != 18 {
		t.Fatalf("PV takes the cut first: cap %.3f, discharge %v", c.CapKw, c.DischargeCapKw)
	}
	// the watchdog never commands a charge: its ceiling is >= 0
	n := NewExportLimiter()
	n.ObserveMitSpeicher(r9t0, -500, 0, ptr(-10))
	if c := n.CapAnteil(r9t0, &grenze100, halle1, 10); c.DischargeCapKw == nil || *c.DischargeCapKw != 0 {
		t.Fatalf("expected ceiling 0 (stop discharging, not charge), got %v", c.DischargeCapKw)
	}
}

// A document without a role (the field is optional): the box holds the share
// at its own point, always - exactly like steuert_mit.
func TestOhneRolleWieMitsteuernd(t *testing.T) {
	ohne := ExportAnteil{AnteilKw: 60}
	a, b := NewExportLimiter(), NewExportLimiter()
	for i, off := range []time.Duration{0, 20 * time.Second, 45 * time.Second, 2 * time.Minute} {
		if i == 0 {
			a.ObserveMitSpeicher(r9t0, -58, 70, nil)
			b.ObserveMitSpeicher(r9t0, -58, 70, nil)
		}
		ca := a.CapAnteil(r9t0.Add(off), &grenze100, ohne, 10)
		cb := b.CapAnteil(r9t0.Add(off), &grenze100, verwalt, 10)
		if ca.CapKw != cb.CapKw || ca.State != cb.State || ca.LimitKw != 60 {
			t.Fatalf("%v: without a role %+v, steuert_mit %+v", off, ca, cb)
		}
	}
}

// "Der Waechter erweitert nie": for random sequences of measurement, age,
// plan limit and commanded discharge, the PV cap WITH a share is never above
// the cap WITHOUT a share for the same input, and the allowed discharge is
// never above the commanded one - exactly, without tolerance.
func TestAnteilErweitertNie(t *testing.T) {
	rng := rand.New(rand.NewSource(18))
	for run := 0; run < 400; run++ {
		heute, anteil := NewExportLimiter(), NewExportLimiter()
		limit := 20 + rng.Float64()*200
		an := ExportAnteil{AnteilKw: rng.Float64() * limit, Fuehrt: rng.Intn(2) == 0}
		now := r9t0
		var lastObs time.Time
		for step := 0; step < 80; step++ {
			now = now.Add(time.Duration(1+rng.Intn(40)) * time.Second)
			if rng.Intn(3) > 0 { // a measurement, sometimes long gaps
				lastObs = now
				grid := -rng.Float64()*1.5*limit + rng.Float64()*50
				pv := rng.Float64() * 1.5 * limit
				batt := -rng.Float64() * limit
				heute.Observe(now, grid, pv)
				anteil.ObserveMitSpeicher(now, grid, pv, &batt)
			}
			var lim *float64
			if rng.Intn(6) > 0 {
				lim = &limit
			}
			d := 0.0
			if rng.Intn(2) == 0 {
				d = rng.Float64() * limit
			}
			h := heute.Cap(now, lim, exportSafeStatic(lim, d))
			a := anteil.CapAnteil(now, lim, an, d)
			if h.Active && a.CapKw > h.CapKw {
				t.Fatalf("run %d step %d: with share %.3f (%s) > without %.3f (%s)",
					run, step, a.CapKw, a.State, h.CapKw, h.State)
			}
			if dischargeAllowed(a, d) > d+1e-9 || dischargeAllowed(a, d) < 0 {
				t.Fatalf("run %d step %d: discharge raised or turned into a charge", run, step)
			}
			// R9/V6: never measured, or blind for more than 30 + 60 s: generation
			// and discharge together on the share (1 W: rounding to watts)
			if (lastObs.IsZero() || now.Sub(lastObs) > ExportFreshWindow+ExportAnteilWindow) &&
				a.CapKw+dischargeAllowed(a, d) > an.AnteilKw+1e-3 {
				t.Fatalf("run %d step %d: blind %v, over the share: %.3f + %.3f > %.3f (%s)",
					run, step, now.Sub(lastObs), a.CapKw, dischargeAllowed(a, d), an.AnteilKw, a.State)
			}
		}
	}
}

// exportSafeStatic is the caller's `limit - discharge` (agent.exportSafeStaticCap).
func exportSafeStatic(limit *float64, discharge float64) float64 {
	if limit == nil {
		return 0
	}
	return math.Max(*limit-discharge, 0)
}
