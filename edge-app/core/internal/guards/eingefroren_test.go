package guards

// AP-15 IP-20: the frozen connection-point value counts as blind (B2), proven
// with R9 of the reference cases (vp-uems-ap15-verbund/referenzfaelle.json):
// the meter freezes at 13:10:00 - it keeps sending telegrams with a FRESH
// timestamp, always the same number (-98 kW, feed-in 98). Box Halle 1 (E-1,
// fuehrt, share 40 kW) regulates PV 83 kW at the loop. At 13:10:00 a plan slot
// ends and the box stops a 10 kW market discharge - its own adjustment, +10 kW
// that MUST show at the meter.

import (
	"math"
	"testing"
	"time"
)

// r9Eingefroren runs R9 with a frozen meter, second by second: a sample every
// 5 s (fresh timestamp, the value frozen from 13:10:00 on), the watchdog every
// second with the probe's verdict. verstelltAb is when the box stops the
// discharge (its own adjustment); tautAb is when the meter moves again (zero =
// never). It returns the verdict of every second 0..sekunden.
func r9Eingefroren(t *testing.T, verstelltAb, tautAb time.Duration, sekunden int) []ExportCap {
	t.Helper()
	l, p := NewExportLimiter(), &Einfrierprobe{}
	obs := func(ts time.Time, grid, pv, batt float64) {
		p.Wert(ts, grid)
		l.ObserveMitSpeicher(ts, grid, pv, &batt)
	}
	// alive before the freeze: the value moves
	obs(r9t0.Add(-5*time.Second), -97.9, 83, -10)
	var out []ExportCap
	batt, dis := -10.0, 10.0
	for s := 0; s <= sekunden; s++ {
		now := r9t0.Add(time.Duration(s) * time.Second)
		if s%5 == 0 {
			grid, pv := -98.0, 83.0
			if tautAb > 0 && time.Duration(s)*time.Second >= tautAb {
				// the meter is back: the real value, PV at the share's cap
				grid, pv = -40-float64(s%7)/10, 40
			}
			if dis == 0 {
				batt = 0
			}
			obs(now, grid, pv, batt)
		}
		if time.Duration(s)*time.Second == verstelltAb {
			// the plan slot ends: discharge 10 kW -> 0, from the MEASURED -10
			// (after this second's sample: the last change is 13:10:00)
			p.Verstellt(now, WirksamSpeicher(batt, 0))
			dis = 0
		}
		an := halle1
		if seit, ok := p.Eingefroren(now); ok {
			an.EingefrorenSeit = seit
		}
		out = append(out, l.CapAnteil(now, &grenze100, an, dis))
	}
	return out
}

// R9 with the FROZEN meter (not the stale one IP-18 proved): the timestamps
// stay fresh, so up to 13:10:59 the box cannot know - the loop runs. At
// 13:11:00 the value has stood 60 s after an own adjustment of 10 kW: blind,
// and since a frozen value is no measurement, its age counts from the last
// change (13:10:00) - the ramp starts half way and arrives at 13:11:30 on the
// share of 40 kW, 90 s after the freeze as R9 demands (auf_anteil_nach_s: 90).
func TestR9EingefrorenerZaehlerNachNeunzigSekundenAufDemAnteil(t *testing.T) {
	caps := r9Eingefroren(t, 0, 0, 600)
	prev := math.Inf(1)
	for s, c := range caps {
		switch {
		case s < 60:
			if c.Blind || c.State != ExportLimiting {
				t.Fatalf("13:10:%02d: the timestamps are fresh, the probe needs 60 s - loop expected, got %s", s, c.State)
			}
			near(t, "loop cap", c.CapKw, 83)
		case s < 90:
			near(t, "ramp", c.CapKw, 83-(83-40)*float64(s-30)/60)
			if !c.Blind || !c.Eingefroren || c.State != ExportContracting || c.CapKw >= prev {
				t.Fatalf("second %d: frozen, no hold - got %s blind=%v eingefroren=%v at %.3f after %.3f",
					s, c.State, c.Blind, c.Eingefroren, c.CapKw, prev)
			}
		default:
			if c.State != ExportSafeCap || !c.Eingefroren {
				t.Fatalf("second %d: expected sicherheitskappe (frozen), got %s", s, c.State)
			}
			near(t, "share", c.CapKw, 40)
		}
		prev = c.CapKw
	}
	if caps[60].MeasurementAge != 60*time.Second {
		t.Fatalf("13:11:00: the age counts from the last change, got %v", caps[60].MeasurementAge)
	}
	if want := "steht seit 75 s still"; !contains(caps[75].Reason, want) {
		t.Fatalf("the sentence names the frozen value (%q): %s", want, caps[75].Reason)
	}
}

// The own adjustment comes late (13:10:45): the probe needs 60 s after IT, so
// the box is blind at 13:11:45 - and then at once on the share, because the
// last change of the value is already 105 s ago.
func TestR9EingefrorenSpaeteVerstellungSofortAufDemAnteil(t *testing.T) {
	caps := r9Eingefroren(t, 45*time.Second, 0, 200)
	for s, c := range caps {
		switch {
		case s < 105:
			if c.Blind {
				t.Fatalf("second %d: blind before 60 s after the own adjustment (%s)", s, c.State)
			}
		default:
			if c.State != ExportSafeCap || !c.Eingefroren {
				t.Fatalf("second %d: expected sicherheitskappe, got %s", s, c.State)
			}
			near(t, "share", c.CapKw, 40)
		}
	}
}

// The way back: as soon as the value moves again the loop is fresh, and it
// releases from the share BRAKED (the release rate of every blind state),
// never with a jump.
func TestEingefrorenRueckkehrGebremst(t *testing.T) {
	caps := r9Eingefroren(t, 0, 150*time.Second, 240)
	rate := releaseRate(grenze100)
	for s := 150; s <= 240; s++ {
		c := caps[s]
		if c.Blind || c.Eingefroren {
			t.Fatalf("second %d: the value moves again - fresh expected, got %s", s, c.State)
		}
		if c.CapKw > caps[s-1].CapKw+rate+1e-3 {
			t.Fatalf("second %d: released %.3f -> %.3f, faster than %.3f kW/s", s, caps[s-1].CapKw, c.CapKw, rate)
		}
	}
	near(t, "first fresh second releases from the share", caps[150].CapKw, 40+rate)
	if caps[240].CapKw <= 90 {
		t.Fatalf("the release goes on up to the loop: %.3f at 13:14:00", caps[240].CapKw)
	}
}

// No false alarm (B2): a value standing still is HEALTHY unless the box's own
// adjustment MUST have moved it. Ten minutes each, a sample every 5 s with
// always the same value - never blind.
func TestEingefrorenKeinFehlalarm(t *testing.T) {
	type schritt func(p *Einfrierprobe, now time.Time, s int)
	faelle := []struct {
		name    string
		pv      float64
		schritt schritt
	}{
		{"ruhende Anlage - nichts verstellt", 20, func(*Einfrierprobe, time.Time, int) {}},
		{"Nacht ohne PV - die Kappe hat nichts zu kappen", 0, func(p *Einfrierprobe, now time.Time, s int) {
			if s%30 == 0 { // the loop cap swings 83 -> 10 -> 83
				p.Verstellt(now, WirksamGesenkt(83, 10, 0))
				p.Verstellt(now, WirksamGesenkt(10, 83, 0))
			}
		}},
		{"Verstellung unter 2 kW", 20, func(p *Einfrierprobe, now time.Time, s int) {
			switch s {
			case 10:
				p.Verstellt(now, WirksamSpeicher(-1.2, 0)) // +1,2
			case 20:
				p.Verstellt(now, WirksamGesenkt(math.Inf(1), 19.3, 20)) // +0,7 = 1,9 together
			}
		}},
		{"Kappe oberhalb der Erzeugung: 80 -> 70 kW bei 30 kW", 30, func(p *Einfrierprobe, now time.Time, s int) {
			if s == 10 {
				p.Verstellt(now, WirksamGesenkt(80, 70, 30))
			}
		}},
		{"Speicher weg von 0 und Anheben - nur erlaubt, nie erzwungen", 20, func(p *Einfrierprobe, now time.Time, s int) {
			if s == 10 {
				p.Verstellt(now, WirksamSpeicher(0, -30))             // 0 -> 30 kW discharge: SoC decides
				p.Verstellt(now, WirksamSpeicher(-5, -30))            // more discharge: SoC decides
				p.Verstellt(now, WirksamGesenkt(20, math.Inf(1), 20)) // a raise only permits
			}
		}},
		{"gegenlaeufig: PV-Kappe -5, Ladepunkt -5 heben sich am Zaehler auf", 30, func(p *Einfrierprobe, now time.Time, s int) {
			if s == 10 {
				p.Verstellt(now, WirksamGesenkt(math.Inf(1), 25, 30)) // +5
				p.Verstellt(now, -WirksamGesenkt(11, 6, 11))          // -5
			}
		}},
	}
	for _, f := range faelle {
		t.Run(f.name, func(t *testing.T) {
			l, p := NewExportLimiter(), &Einfrierprobe{}
			for s := 0; s <= 600; s++ {
				now := r9t0.Add(time.Duration(s) * time.Second)
				f.schritt(p, now, s)
				if s%5 == 0 {
					p.Wert(now, -12.5)
					l.ObserveMitSpeicher(now, -12.5, f.pv, ptr(0))
				}
				an := halle1
				seit, ok := p.Eingefroren(now)
				if ok {
					t.Fatalf("second %d: frozen since %v - false alarm", s, seit)
				}
				if c := l.CapAnteil(now, &grenze100, an, 0); c.Blind || c.Eingefroren {
					t.Fatalf("second %d: the watchdog went blind (%s)", s, c.State)
				}
			}
		})
	}
}

// The probe itself: 60 s AFTER the adjustment, not after the last change;
// latched until the value moves; a change re-anchors.
func TestEinfrierprobeGrenzen(t *testing.T) {
	p := &Einfrierprobe{}
	if _, ok := p.Eingefroren(r9t0); ok {
		t.Fatal("never seen: not frozen")
	}
	p.Wert(r9t0, 5)
	p.Verstellt(r9t0.Add(10*time.Second), 2) // exactly the start value
	if _, ok := p.Eingefroren(r9t0.Add(69 * time.Second)); ok {
		t.Fatal("59 s after the adjustment: not yet")
	}
	seit, ok := p.Eingefroren(r9t0.Add(70 * time.Second))
	if !ok || !seit.Equal(r9t0) {
		t.Fatalf("60 s after the adjustment: frozen since the last change, got %v %v", seit, ok)
	}
	// latched: the box moving back does not un-freeze
	p.Verstellt(r9t0.Add(71*time.Second), -2)
	if _, ok := p.Eingefroren(r9t0.Add(72 * time.Second)); !ok {
		t.Fatal("latched until the value moves")
	}
	// the same number is no change, an older sample is ignored
	p.Wert(r9t0.Add(73*time.Second), 5)
	p.Wert(r9t0.Add(-time.Second), 6)
	if _, ok := p.Eingefroren(r9t0.Add(74 * time.Second)); !ok {
		t.Fatal("same number or older sample: still frozen")
	}
	p.Wert(r9t0.Add(75*time.Second), 5.001)
	if _, ok := p.Eingefroren(r9t0.Add(200 * time.Second)); ok {
		t.Fatal("the value moved: re-anchored, not frozen")
	}
	// an adjustment that falls back below 2 kW before 60 s disarms
	p.Verstellt(r9t0.Add(80*time.Second), 3)
	p.Verstellt(r9t0.Add(100*time.Second), -2)
	if _, ok := p.Eingefroren(r9t0.Add(300 * time.Second)); ok {
		t.Fatal("back to 1 kW before 60 s: not frozen")
	}
}

func TestWirksam(t *testing.T) {
	inf := math.Inf(1)
	for _, c := range []struct {
		name      string
		got, want float64
	}{
		{"cap 80 -> 70 at 30 kW", WirksamGesenkt(80, 70, 30), 0},
		{"cap 40 -> 20 at 30 kW", WirksamGesenkt(40, 20, 30), 10},
		{"no cap -> 25 at 30 kW", WirksamGesenkt(inf, 25, 30), 5},
		{"raise 20 -> 40 at 20 kW", WirksamGesenkt(20, 40, 20), 0},
		{"night", WirksamGesenkt(83, 0, 0), 0},
		{"unknown flow", WirksamGesenkt(83, 0, math.NaN()), 0},
		{"discharge 10 -> 0", WirksamSpeicher(-10, 0), 10},
		{"discharge 60 -> 40", WirksamSpeicher(-60, -40), 20},
		{"discharge 30 -> charge 10", WirksamSpeicher(-30, 10), 30},
		{"discharge 30 -> 40", WirksamSpeicher(-30, -40), 0},
		{"charge 20 -> 5", WirksamSpeicher(20, 5), -15},
		{"charge 20 -> discharge", WirksamSpeicher(20, -50), -20},
		{"idle -> discharge", WirksamSpeicher(0, -30), 0},
		{"unknown battery", WirksamSpeicher(math.NaN(), 0), 0},
	} {
		if c.got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, c.got, c.want)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
