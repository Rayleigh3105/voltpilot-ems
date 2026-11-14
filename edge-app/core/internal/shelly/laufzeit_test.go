package shelly

import (
	"testing"
	"time"
)

func TestRuntimeTrackerAccruesOnlyWhileOn(t *testing.T) {
	tr := NewRuntimeTracker(2)
	t0 := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	on, off := true, false
	tr.Observe(t0, []*bool{&on, &off})
	if got := tr.Runtime(0, t0); got != 0 {
		t.Fatalf("output 0 open interval at t0 = %v, want 0", got)
	}
	t1 := t0.Add(5 * time.Minute)
	if got := tr.Runtime(0, t1); got != 5*time.Minute {
		t.Fatalf("output 0 open interval at t1 = %v, want 5m", got)
	}
	if got := tr.Runtime(1, t1); got != 0 {
		t.Fatalf("output 1 (never on) = %v, want 0", got)
	}
	tr.Observe(t1, []*bool{&off, &off})
	t2 := t1.Add(10 * time.Minute)
	if got := tr.Runtime(0, t2); got != 5*time.Minute {
		t.Fatalf("output 0 after turning off = %v, want the closed 5m interval, not still accruing", got)
	}
}

// A device that goes on, off, then on again accumulates ACROSS both
// intervals, never resets on a restart (within the process; a real
// restart loses the tracker entirely, which is documented, not tested
// here).
func TestRuntimeTrackerAccumulatesAcrossSeveralIntervals(t *testing.T) {
	tr := NewRuntimeTracker(1)
	t0 := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	on, off := true, false
	tr.Observe(t0, []*bool{&on})
	tr.Observe(t0.Add(2*time.Minute), []*bool{&off})
	tr.Observe(t0.Add(3*time.Minute), []*bool{&on})
	got := tr.Runtime(0, t0.Add(7*time.Minute))
	want := 2*time.Minute + 4*time.Minute
	if got != want {
		t.Fatalf("accumulated runtime = %v, want %v", got, want)
	}
}

// An unknown reading (the device did not answer for that output) neither
// starts nor stops an accrual - "fehlend ist keine Null".
func TestRuntimeTrackerUnknownReadingNeitherStartsNorStopsAccrual(t *testing.T) {
	tr := NewRuntimeTracker(1)
	t0 := time.Date(2026, 11, 14, 10, 0, 0, 0, time.UTC)
	on := true
	tr.Observe(t0, []*bool{&on})
	// A later pass could not read this output at all.
	tr.Observe(t0.Add(1*time.Minute), []*bool{nil})
	t1 := t0.Add(4 * time.Minute)
	if got := tr.Runtime(0, t1); got != 4*time.Minute {
		t.Fatalf("runtime through an unknown reading = %v, want the interval to keep running (4m)", got)
	}

	tr2 := NewRuntimeTracker(1)
	tr2.Observe(t0, []*bool{nil})
	if got := tr2.Runtime(0, t0.Add(5*time.Minute)); got != 0 {
		t.Fatalf("an output never seen ON must read 0, got %v", got)
	}
}

func TestRuntimeTrackerPanicsOnChangedOutputCount(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic for a mismatched output count")
		}
	}()
	tr := NewRuntimeTracker(2)
	on := true
	tr.Observe(time.Now(), []*bool{&on})
}
