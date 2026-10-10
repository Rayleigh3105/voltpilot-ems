package guards

import (
	"math"
	"reflect"
	"testing"
	"time"
)

func TestEinzelboxUhrZurueckFreigabeAbSprung(t *testing.T) {
	l := NewExportLimiter()
	l.Observe(r9t0, 0, 0)
	vor := l.Cap(r9t0, &grenze100, 100)
	sprung := r9t0.Add(-840 * time.Second)
	l.Observe(sprung, -48, 98) // more headroom, never credit from the old clock
	if c := l.Cap(sprung, &grenze100, 100); c.CapKw != vor.CapKw || c.Blind {
		t.Fatalf("jump must re-anchor without releasing: %+v", c)
	}
	if c := l.Cap(sprung.Add(6*time.Second), &grenze100, 100); c.CapKw != vor.CapKw+10 {
		t.Fatalf("only six seconds of release credit: %+v", c)
	}
	if !l.Observe(sprung.Add(time.Second), -150, 150) { // another older timestamp
		t.Fatal("a tighter sample must wake the executor even when older")
	}
	if c := l.Cap(sprung.Add(time.Second), &grenze100, 100); c.CapKw != 98 {
		t.Fatalf("tightening must be immediate: %+v", c)
	}
}

func TestEinzelboxNegativesAlterHaeltDannZiehtZusammen(t *testing.T) {
	for _, rueck := range []time.Duration{400 * time.Second, 840 * time.Second} {
		t.Run(rueck.String(), func(t *testing.T) {
			l := NewExportLimiter()
			l.Observe(r9t0, -98, 148)
			l.Cap(r9t0, &grenze100, 100)
			sprung := r9t0.Add(-rueck)
			for _, s := range []int{0, 30, 90, 240, 391} {
				now := sprung.Add(time.Duration(s) * time.Second)
				l.Observe(now, math.NaN(), 148) // unusable input cannot end blindness
				c := l.Cap(now, &grenze100, 100)
				if s == 0 && c.MeasurementAge >= 0 {
					t.Fatalf("negative age must not be clamped: %+v", c)
				}
				want, state := 148.0, ExportHolding
				if s == 240 {
					want, state = 124, ExportContracting
				} else if s == 391 {
					want, state = 100, ExportSafeCap
				}
				if !c.Blind || !c.Uhrsprung || c.CapKw != want || c.State != state || c.ExportKw != nil {
					t.Fatalf("+%d s: want blind %s %.1f, got %+v", s, state, want, c)
				}
			}
			now := sprung.Add(392 * time.Second)
			l.Observe(now, -98, 118)
			if c := l.Cap(now, &grenze100, 100); c.Blind || c.Uhrsprung {
				t.Fatalf("accepted sample must restore the loop: %+v", c)
			}
		})
	}
}

func TestEinzelboxPositivesAlterBleibtUnveraendert(t *testing.T) {
	heute, ohne := NewExportLimiter(), NewExportLimiter()
	for _, l := range []*ExportLimiter{heute, ohne} {
		l.Observe(r9t0, -98, 148)
		l.Cap(r9t0, &grenze100, 100)
	}
	// A concurrent sample can be slightly ahead of the caller's captured now.
	if c := heute.Cap(r9t0.Add(-time.Microsecond), &grenze100, 100); !c.Blind {
		t.Fatal("negative age must be blind, even for a microsecond")
	}
	now := r9t0.Add(time.Second)
	if got, want := heute.Cap(now, &grenze100, 100), ohne.Cap(now, &grenze100, 100); !reflect.DeepEqual(got, want) {
		t.Fatalf("positive age must keep the old verdict: got %+v, want %+v", got, want)
	}
}

func TestEinzelboxUhrVorHaelt(t *testing.T) {
	l := NewExportLimiter()
	l.Observe(r9t0, -98, 148)
	l.Cap(r9t0, &grenze100, 100)
	now := r9t0.Add(840 * time.Second)
	if c := l.Cap(now, &grenze100, 100); !c.Blind || c.CapKw != 100 || c.Uhrsprung {
		t.Fatalf("forward jump must retain the safe fallback: %+v", c)
	}
	l.Observe(now, -80, 100)
	if c := l.Cap(now, &grenze100, 100); c.Blind || c.CapKw > 118 {
		t.Fatalf("new measurement on the forward clock: %+v", c)
	}
}

func TestEinzelboxZukuenftigeMessungVerlaengertHaltenNicht(t *testing.T) {
	l := NewExportLimiter()
	l.Observe(r9t0, -98, 148)
	l.Cap(r9t0, &grenze100, 100)
	sprung := r9t0.Add(-840 * time.Second)
	for s := 0; s <= 400; s += 10 {
		// A publisher still on the old clock cannot restart the 90 s hold.
		l.Observe(r9t0, -98, 148)
		c := l.Cap(sprung.Add(time.Duration(s)*time.Second), &grenze100, 100)
		if !c.Blind || (s == 400 && c.CapKw != 100) {
			t.Fatalf("+%d s: future-dated sample extended holding: %+v", s, c)
		}
	}
}
