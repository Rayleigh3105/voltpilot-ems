package guards

import (
	"math"
	"testing"
	"time"
)

// vp-schalten-3s, Captain-Entscheid C (28.11.2026): ein Handeingriff an einer
// einfachen Last schaltet in BEIDE Richtungen sofort - Mindestlauf und
// Mindestpause halten ihn nicht. Die Startgrenze hält weiter, und die
// Automatik danach wartet die Zeiten ab dem Hand-Schalten ab.
func TestApplyManualUeberspringtMindestlaufUndMindestpause(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MinOn: 300 * time.Second, MinOff: 300 * time.Second}, time.UTC)
	t0 := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	g.Apply(t0, false, math.NaN()) // Ausgangslage: aus
	if on, _, hold := g.ApplyManual(t0.Add(time.Second), true, math.NaN()); !on || hold != nil {
		t.Fatalf("Hand an: on=%v hold=%+v", on, hold)
	}
	if on, _, hold := g.ApplyManual(t0.Add(2*time.Second), false, math.NaN()); on || hold != nil {
		t.Fatalf("Hand aus innerhalb des Mindestlaufs: on=%v hold=%+v", on, hold)
	}
	if on, _, hold := g.ApplyManual(t0.Add(3*time.Second), true, math.NaN()); !on || hold != nil {
		t.Fatalf("Hand an innerhalb der Mindestpause: on=%v hold=%+v", on, hold)
	}
	// Die Automatik danach: Mindestlauf ab dem letzten Hand-Schalten, mit Ende.
	on, _, hold := g.Apply(t0.Add(4*time.Second), false, math.NaN())
	if !on || hold == nil || hold.Code != CycleReasonMinOn {
		t.Fatalf("Automatik aus nach Hand an: on=%v hold=%+v", on, hold)
	}
	if want := t0.Add(3*time.Second + 300*time.Second); !hold.Until.Equal(want) {
		t.Fatalf("Until = %v, want %v", hold.Until, want)
	}
}

func TestApplyManualHaeltDieStartgrenze(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MinOn: 300 * time.Second, MaxStartsPerDay: 1}, time.UTC)
	t0 := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	g.Apply(t0, false, math.NaN())
	g.ApplyManual(t0.Add(time.Second), true, math.NaN())
	g.ApplyManual(t0.Add(2*time.Second), false, math.NaN())
	if on, _, hold := g.ApplyManual(t0.Add(3*time.Second), true, math.NaN()); on || hold == nil ||
		hold.Code != CycleReasonMaxStarts {
		t.Fatalf("die Startgrenze muss auch von Hand halten: on=%v hold=%+v", on, hold)
	}
}

func TestMindestpauseNenntIhrEnde(t *testing.T) {
	g := NewCycleGuard(CycleLimits{MinOff: 120 * time.Second}, time.UTC)
	t0 := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	g.Apply(t0, true, math.NaN())
	g.Apply(t0.Add(time.Second), false, math.NaN())
	_, _, hold := g.Apply(t0.Add(10*time.Second), true, math.NaN())
	if hold == nil || hold.Code != CycleReasonMinOff || !hold.Until.Equal(t0.Add(121*time.Second)) {
		t.Fatalf("hold = %+v", hold)
	}
}
