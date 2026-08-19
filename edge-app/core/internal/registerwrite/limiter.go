package registerwrite

import (
	"sync"
	"time"
)

// Limiter is a sliding-window request limiter for ADMITTED write orders.
// Concurrency-safe, since the cloud link delivers on its own goroutine.
//
// It is the twin of probe.Limiter and deliberately NOT persisted: a restart
// forgets the budget. A pause the limiter cannot know is not owed (the
// CycleGuard reasoning), and the failure mode of forgetting - one extra allowed
// burst after a reboot - is bounded, while persisting it would add a file whose
// only reader is a throttle.
type Limiter struct {
	mu     sync.Mutex
	window time.Duration
	budget int
	hits   []time.Time
}

// NewLimiter builds a limiter; zero/negative arguments fall back to the
// defaults, so a caller cannot accidentally build an unlimited one.
func NewLimiter(window time.Duration, budget int) *Limiter {
	if window <= 0 {
		window = DefaultRateWindow
	}
	if budget <= 0 {
		budget = DefaultRateBudget
	}
	return &Limiter{window: window, budget: budget}
}

// Allow records one order at `now` and reports whether it may run. A refused
// order does NOT consume budget - otherwise a client that keeps retrying would
// hold the window open forever and the limit would never lift.
func (l *Limiter) Allow(now time.Time) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-l.window)
	kept := l.hits[:0]
	for _, t := range l.hits {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	l.hits = kept
	if len(l.hits) >= l.budget {
		return false
	}
	l.hits = append(l.hits, now)
	return true
}
