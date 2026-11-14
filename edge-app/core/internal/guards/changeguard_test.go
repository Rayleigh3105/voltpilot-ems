package guards

import (
	"testing"
	"time"
)

func TestChangeGuard(t *testing.T) {
	t0 := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	g := NewChangeGuard(5 * time.Minute)
	v := func(x float64) *float64 { return &x }

	// The first value is never held: no invented pause.
	sp, m, h := g.Apply(t0, v(22), "cool")
	if *sp != 22 || m != "cool" || len(h) != 0 {
		t.Fatalf("first: %v %q %v", *sp, m, h)
	}
	// The same value again is no change.
	if sp, _, h := g.Apply(t0.Add(time.Second), v(22), "cool"); *sp != 22 || len(h) != 0 {
		t.Fatalf("same value held: %v", h)
	}
	// A change inside the interval is held at the old value, per field.
	sp, m, h = g.Apply(t0.Add(time.Minute), v(20), "heat")
	if *sp != 22 || m != "cool" || len(h) != 2 || h[0].Code != ChangeReasonInterval ||
		!h[0].Until.Equal(t0.Add(5*time.Minute)) {
		t.Fatalf("held: %v %q %+v", *sp, m, h)
	}
	// Absent fields pass untouched and do not reset the memory.
	if sp, m, h := g.Apply(t0.Add(2*time.Minute), nil, ""); sp != nil || m != "" || len(h) != 0 {
		t.Fatalf("absent: %v %q %v", sp, m, h)
	}
	// After the interval the change lands and opens a new window.
	sp, m, h = g.Apply(t0.Add(5*time.Minute), v(20), "heat")
	if *sp != 20 || m != "heat" || len(h) != 0 {
		t.Fatalf("after: %v %q %v", *sp, m, h)
	}
	if sp, _, h := g.Apply(t0.Add(6*time.Minute), v(21), ""); *sp != 20 || len(h) != 1 {
		t.Fatalf("new window: %v %v", *sp, h)
	}
	// Interval 0: every change passes.
	g.SetInterval(0)
	if sp, _, h := g.Apply(t0.Add(6*time.Minute), v(21), ""); *sp != 21 || len(h) != 0 {
		t.Fatalf("interval 0: %v %v", *sp, h)
	}
}
