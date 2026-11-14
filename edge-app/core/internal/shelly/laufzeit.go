package shelly

// Steuerlogik-Konzept Stufe 1 (report.md §4.4): "Laufzeit je Ausgang" is
// named a GAP for a Shelly heating rod (group.go already reads every
// output's ON/OFF state each pass; nothing accumulates it per output - only
// the whole consumer's runtime, in guards.CycleGuard). RuntimeTracker closes
// exactly that gap, as a small, pure, in-memory accrual over successive
// GroupResult readbacks - not wired into the control executor in this
// stage (no surface asks for it yet; Stufe 2's rule core will).
//
// In memory only, like guards.CycleGuard's own runtime counter: a restart
// forgets it, honestly, rather than persisting a number nobody could prove
// right across a crash.

import (
	"sync"
	"time"
)

// RuntimeTracker accumulates ON time per output of ONE output set.
type RuntimeTracker struct {
	mu      sync.Mutex
	n       int
	since   []time.Time     // zero = currently off (or never observed on)
	runtime []time.Duration // accrued so far, NOT counting a still-open interval
}

// NewRuntimeTracker builds a tracker for a set of n outputs, all presumed
// off until the first Observe says otherwise.
func NewRuntimeTracker(n int) *RuntimeTracker {
	return &RuntimeTracker{n: n, since: make([]time.Time, n), runtime: make([]time.Duration, n)}
}

// Observe folds one readback into the tracker: outputsOn must have exactly
// n entries, in the same channel order every call (group.go's
// GroupResult.Verdict.Outputs shape) - a nil entry is an UNKNOWN reading
// (the device did not answer for that output) and neither starts nor stops
// an accrual; it simply contributes no time this interval, same as every
// other "fehlend ist keine Null" reading in this house. now must never go
// backwards (the agent's own wall clock feeds this, like CycleGuard).
func (r *RuntimeTracker) Observe(now time.Time, outputsOn []*bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(outputsOn) != r.n {
		panic("shelly: RuntimeTracker.Observe: output count changed")
	}
	for i, on := range outputsOn {
		switch {
		case on == nil:
			// Unknown: neither closes a running interval early nor opens a
			// new one on a guess.
		case *on && r.since[i].IsZero():
			r.since[i] = now
		case !*on && !r.since[i].IsZero():
			r.runtime[i] += now.Sub(r.since[i])
			r.since[i] = time.Time{}
		}
	}
}

// Runtime returns output i's accumulated ON duration, including any
// interval still open as of now (now must be >= the last Observe; the open
// interval is never persisted until the output is actually seen off).
func (r *RuntimeTracker) Runtime(i int, now time.Time) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	total := r.runtime[i]
	if !r.since[i].IsZero() {
		total += now.Sub(r.since[i])
	}
	return total
}
