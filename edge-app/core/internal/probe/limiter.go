package probe

import (
	"sync"
	"time"
)

// DefaultRateWindow / DefaultRateBudget bound how often this box knocks on a
// customer's Modbus device on the cloud's behalf.
//
// The number is chosen from what the surface it serves actually does: an
// assistant step is a handful of clicks, and a customer who is genuinely
// hunting for the right register clicks maybe a dozen times a minute. The thing
// being protected is a real device - single-session loggers displace a running
// connection, and cheap Modbus gateways stall under load. So the budget is
// generous enough that no honest wizard ever meets it, and low enough that a
// runaway portal loop cannot turn a preview into a denial of service against
// the customer's own inverter.
//
// Deliberately counted in REQUESTS, not ops: the ops of one request share the
// device's read queue anyway (they are serialized by the box's one-socket
// discipline), so what matters for the device is how often a burst STARTS.
const (
	DefaultRateWindow = time.Minute
	DefaultRateBudget = 12
)

// Limiter is a sliding-window request limiter. Concurrency-safe, since the
// cloud link delivers on its own goroutine.
//
// It is deliberately NOT persisted: a restart forgets the budget. A pause the
// limiter cannot know is not owed (the CycleGuard reasoning), and the failure
// mode of forgetting - one extra allowed burst after a reboot - is bounded and
// harmless, while persisting it would add a file whose only reader is a
// throttle.
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

// Allow records one request at `now` and reports whether it may run. A refused
// request does NOT consume budget - otherwise a client that keeps retrying
// would hold the window open forever and the limit would never lift.
func (l *Limiter) Allow(now time.Time) bool {
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

// RateLimitedMessage is the ONE German sentence for a throttled probe. It says
// what happened and what to do, and it never blames the customer's device -
// this refusal is entirely ours.
const RateLimitedMessage = "Zu viele Prüfungen in kurzer Zeit. Bitte einen Moment warten und erneut versuchen."
