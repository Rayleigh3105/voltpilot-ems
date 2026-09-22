package lastmgmt

import (
	"reflect"
	"testing"
	"time"
)

func TestEinzelboxUhrZurueckHaeltGlaettungUndPlan(t *testing.T) {
	b := NewBudgetTracker()
	set := dynSite()
	b.Observe(t0, 140, 40, true) // rest 100
	b.ObservePlanLimit(t0, 150)
	b.Observe(t0.Add(time.Second), 140, 40, false)
	sprung := t0.Add(-840 * time.Second)
	b.Observe(sprung, 60, 40, true) // rest 20; old maximum must survive
	for _, s := range []int{0, 60, 61, 90, 91} {
		now := sprung.Add(time.Duration(s) * time.Second)
		b.Observe(now, 60, 40, true)
		v := b.Budget(now, set)
		want := 50.0 // plan 150 - held rest 100
		if s > 60 {
			want = 130 // plan 150 - measured rest 20
		}
		if s > 90 {
			want = 229.3 // plan ceiling has now expired
		}
		if v.Blind || v.Kw != want {
			t.Fatalf("+%d s: want %.1f, got %+v", s, want, v)
		}
	}
	if b.incompleteAt.After(sprung) {
		t.Fatal("incomplete measurement time was left on the old clock")
	}
}

func TestEinzelboxBudgetNegativesAlterHaeltDannZiehtZusammen(t *testing.T) {
	for _, rueck := range []time.Duration{400 * time.Second, 840 * time.Second} {
		t.Run(rueck.String(), func(t *testing.T) {
			b := NewBudgetTracker()
			set := dynSite()
			b.Observe(t0, 60, 40, true)
			b.Budget(t0, set)
			sprung := t0.Add(-rueck)
			for _, s := range []int{0, 30, 90, 240, 391} {
				now := sprung.Add(time.Duration(s) * time.Second)
				b.Observe(now, 60, 40, false) // incomplete is not a new anchor
				v := b.Budget(now, set)
				if s == 0 && v.MeasurementAge >= 0 {
					t.Fatalf("negative age must not be clamped: %+v", v)
				}
				want, mode := 229.3, BudgetHolding
				if s == 240 {
					want, mode = 149.3, BudgetContracting
				} else if s == 391 {
					want, mode = 69.3, BudgetSafe
				}
				if !v.Blind || v.Kw != want || v.Mode != mode || v.SiteLoadKw != nil {
					t.Fatalf("+%d s: want blind %s %.1f, got %+v", s, mode, want, v)
				}
			}
			now := sprung.Add(392 * time.Second)
			b.Observe(now, 160, 40, true)
			if v := b.Budget(now, set); v.Blind || v.Kw != 129.3 {
				t.Fatalf("next complete sample must restore the loop: %+v", v)
			}
		})
	}
}

func TestEinzelboxBudgetPositivesAlterBleibtUnveraendert(t *testing.T) {
	heute, ohne := NewBudgetTracker(), NewBudgetTracker()
	set := dynSite()
	for _, b := range []*BudgetTracker{heute, ohne} {
		b.Observe(t0, 60, 40, true)
		b.Budget(t0, set)
	}
	if v := heute.Budget(t0.Add(-time.Microsecond), set); !v.Blind {
		t.Fatal("negative age must be blind, even for a microsecond")
	}
	now := t0.Add(time.Second)
	if got, want := heute.Budget(now, set), ohne.Budget(now, set); !reflect.DeepEqual(got, want) {
		t.Fatalf("positive age must keep the old verdict: got %+v, want %+v", got, want)
	}
}

func TestEinzelboxBudgetUhrVorHaelt(t *testing.T) {
	b := NewBudgetTracker()
	set := dynSite()
	b.Observe(t0, 60, 40, true)
	b.Budget(t0, set)
	now := t0.Add(840 * time.Second)
	if v := b.Budget(now, set); !v.Blind || v.Mode != BudgetSafe || v.Kw != 69.3 {
		t.Fatalf("forward jump must retain the safe fallback: %+v", v)
	}
	b.Observe(now, 160, 40, true)
	if v := b.Budget(now, set); v.Blind || v.Kw != 129.3 {
		t.Fatalf("new measurement on the forward clock: %+v", v)
	}
}

func TestEinzelboxBudgetZukuenftigeMessungVerlaengertHaltenNicht(t *testing.T) {
	b := NewBudgetTracker()
	set := dynSite()
	b.Observe(t0, 60, 40, true)
	b.Budget(t0, set)
	sprung := t0.Add(-840 * time.Second)
	for s := 0; s <= 400; s += 10 {
		b.Observe(t0, 60, 40, true)
		v := b.Budget(sprung.Add(time.Duration(s)*time.Second), set)
		if !v.Blind || (s == 400 && v.Kw != 69.3) {
			t.Fatalf("+%d s: future-dated sample extended holding: %+v", s, v)
		}
	}
}
