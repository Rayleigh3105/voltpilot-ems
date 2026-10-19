package guards

// THE STUFEN-HALTEZEIT (Captain decision A, 2026-10-19): not only the first
// deficit, every RISE of a deficit that already stands must have been measured
// for DeficitCoverHold before the follower raises the discharge to it. The
// clock returns the smallest deficit measured over the hold
// (DeficitHold.Observe), the follower covers no more than that or what it
// already had in force, and lowering stays immediate.

import (
	"math"
	"testing"
	"time"
)

const (
	nightBaseKw     = 1.5
	nightConsumerKw = 2.62 // the consumer of Herzogau 17:03:15, on top of the base load
)

// nightObserve is one tick of the clock at night (no PV) on a measurement
// taken at the tick.
func nightObserve(h *DeficitHold, s, loadKw float64) float64 {
	return h.Observe(holdAt(s), holdAt(s), true, 0, loadKw)
}

// The night: the base load has stood for the hold, then a consumer switches on
// top. What has stood is the base load - until the consumer has been measured
// for a full hold after the tick that first saw it. Its end counts at once.
func TestDeficitHoldReturnsTheSmallestDeficitOfTheHold(t *testing.T) {
	h := NewDeficitHold()
	hold := DeficitCoverHold.Seconds()
	for s := 0.0; s < hold; s += 5 {
		if got := nightObserve(h, s, nightBaseKw); got != 0 {
			t.Fatalf("%.0f s: nothing has stood yet, got %.2f kW", s, got)
		}
	}
	if got := nightObserve(h, hold, nightBaseKw); got != nightBaseKw {
		t.Fatalf("the base load stood for the hold: got %.2f kW", got)
	}
	on := hold + 5
	for s := on; s < on+hold; s += 5 {
		if got := nightObserve(h, s, nightBaseKw+nightConsumerKw); got != nightBaseKw {
			t.Fatalf("%.0f s into the consumer: %.2f kW stood, want the base load %.2f kW", s-on, got, nightBaseKw)
		}
		if since, ok := h.Since(); !ok || !since.Equal(holdAt(on)) {
			t.Fatalf("%.0f s into the consumer the wait runs from its first sight: %v %v", s-on, since, ok)
		}
	}
	if got := nightObserve(h, on+hold, nightBaseKw+nightConsumerKw); math.Abs(got-(nightBaseKw+nightConsumerKw)) > 1e-9 {
		t.Fatalf("the consumer stood for the hold: got %.2f kW", got)
	}
	if since, ok := h.Since(); !ok || !since.Equal(holdT0) {
		t.Fatalf("nothing waits any more - Since is the standing deficit's: %v %v", since, ok)
	}
	if got := nightObserve(h, on+hold+5, nightBaseKw); got != nightBaseKw {
		t.Fatalf("the consumer is off: what stood is the base load at once, got %.2f kW", got)
	}
}

// A rise is counted like a deficit out of rest: from the TICK that first saw
// it, never from the (older) time of the measurement that showed it.
func TestDeficitHoldCountsARiseFromTheTickThatSawIt(t *testing.T) {
	h := NewDeficitHold()
	for s := 0.0; s <= 60; s += 5 {
		nightObserve(h, s, nightBaseKw)
	}
	// First seen at 70 s on a measurement timed 62 s.
	if got := h.Observe(holdAt(70), holdAt(62), true, 0, 4.12); got != nightBaseKw {
		t.Fatalf("a rise seen for the first time: %.2f kW stood, want %.2f", got, nightBaseKw)
	}
	for s := 75.0; s < 130; s += 5 {
		if got := nightObserve(h, s, 4.12); got != nightBaseKw {
			t.Fatalf("%.0f s: the rise was first seen at 70 s - %.2f kW stood, want %.2f", s, got, nightBaseKw)
		}
	}
	if got := nightObserve(h, 130, 4.12); got != 4.12 {
		t.Fatalf("60 s after the tick that saw it the rise has stood: got %.2f kW", got)
	}
}

// A load that swings faster than the hold (a hob in its cycle, 30 s on, 30 s
// off) has stood only at its lower edge - however long it swings.
func TestDeficitHoldCoversASwingingLoadUpToItsLowerEdge(t *testing.T) {
	h := NewDeficitHold()
	for s := 0.0; s < 600; s += 5 {
		load := nightBaseKw
		if s >= 120 && math.Mod(s-120, 60) < 30 {
			load += 2
		}
		got := nightObserve(h, s, load)
		if s >= DeficitCoverHold.Seconds() && got != nightBaseKw {
			t.Fatalf("%.0f s: %.2f kW stood, want the lower edge %.2f kW", s, got, nightBaseKw)
		}
	}
}

// Ticks prove nothing for a rise either: a re-read of a measurement already
// judged neither starts nor lengthens one - but a LOWER deficit on it counts,
// because that errs toward waiting.
func TestDeficitHoldReadsARereadTowardWaiting(t *testing.T) {
	h := NewDeficitHold()
	for s := 0.0; s <= 60; s += 5 {
		nightObserve(h, s, 3.0)
	}
	if got := h.Observe(holdAt(65), holdAt(60), true, 0, 5.0); got != 3.0 {
		t.Fatalf("a re-read showing more proves no rise: got %.2f kW", got)
	}
	if got := h.Observe(holdAt(70), holdAt(60), true, 0, 2.0); got != 2.0 {
		t.Fatalf("a re-read showing less counts at once: got %.2f kW", got)
	}
}

// The clock keeps no more than one hold of measurements, however long the
// deficit stands and however often the box ticks.
func TestDeficitHoldKeepsOneHoldOfMeasurements(t *testing.T) {
	h := NewDeficitHold()
	for s := 0.0; s <= 3600; s++ {
		nightObserve(h, s, nightBaseKw+0.5*math.Sin(s/7))
	}
	if n, most := len(h.steps), int(DeficitCoverHold.Seconds())+1; n > most {
		t.Fatalf("after an hour of 1-s ticks the clock keeps %d measurements, want <= %d", n, most)
	}
	h.Release()
	if len(h.steps) != 0 {
		t.Fatal("Release forgets every measurement")
	}
}

// nightRead is the house at night: no PV, the storage well above every floor.
func nightRead(loadKw float64) Reading {
	return Reading{SocPct: 60, PvKw: 0, LoadKw: loadKw, GridLimitKw: Unknown()}
}

// applyStood is apply with the clock's verdict as a height.
func (h holdAuthority) applyStood(f *LoadFollower, at time.Time, kw, stoodKw float64, r Reading) FollowResult {
	floor := 5.0
	return f.ApplyAuthorized(at, kw, h.coverLoad, h.unplanned, h.deficitCover, false,
		stoodKw, &floor, true, followLimits(), r)
}

// The follower on that night, for every authority: the base load is covered;
// a consumer on top is not followed while only the base load has stood - and
// the wait is named; its end changes nothing; a consumer that has stood is
// covered in full; and the house drawing less is followed down at once, below
// what has stood.
func TestTheStufenHaltezeitKeepsAStandingCoverThroughAConsumerOnTop(t *testing.T) {
	for _, auth := range holdAuthorities() {
		t.Run(auth.name, func(t *testing.T) {
			f := NewLoadFollower()
			at := func(n int) time.Time { return followBase().Add(time.Duration(n) * 10 * time.Second) }
			if got := auth.applyStood(f, at(0), 0, nightBaseKw, nightRead(nightBaseKw)); got.Kw != -nightBaseKw || got.Held {
				t.Fatalf("the base load stood and is covered: %+v", got)
			}
			for n := 1; n <= 2; n++ {
				got := auth.applyStood(f, at(n), 0, nightBaseKw, nightRead(nightBaseKw+nightConsumerKw))
				if got.Kw != -nightBaseKw || !got.Held {
					t.Fatalf("tick %d of the consumer: %+v - want the base load kept and the wait named", n, got)
				}
				if math.Abs(got.DeficitKw-(nightBaseKw+nightConsumerKw)) > 1e-9 {
					t.Fatalf("the measured deficit stays the measured one: %+v", got)
				}
			}
			if got := auth.applyStood(f, at(3), 0, nightBaseKw, nightRead(nightBaseKw)); got.Kw != -nightBaseKw || got.Held {
				t.Fatalf("the consumer is off: the base load is covered as before: %+v", got)
			}
			// A consumer that has stood for the hold is covered in full.
			full := nightBaseKw + nightConsumerKw
			if got := auth.applyStood(f, at(10), 0, full, nightRead(full)); math.Abs(got.Kw+full) > 1e-9 ||
				got.Direction != FollowDeepen || got.Path != auth.path || got.Held {
				t.Fatalf("a rise that stood is covered: %+v", got)
			}
			// Lowering needs no clock: the clock still says 4,12 kW stood, the
			// house draws 1 kW - followed down with this very tick.
			if got := auth.applyStood(f, at(11), 0, full, nightRead(1.0)); got.Kw != -1.0 || got.Held {
				t.Fatalf("lowering is immediate: %+v", got)
			}
			// ... and the level given up is not kept for the next rise.
			if got := auth.applyStood(f, at(12), 0, 1.0, nightRead(full)); got.Kw != -1.0 || !got.Held {
				t.Fatalf("a rise after a lowering waits from the lowered level: %+v", got)
			}
		})
	}
}

// What the clock has stood for is coverable even above the level in force (a
// cover that the reserve or a restarted readback had held lower), and a
// verdict that is not a number is no verdict.
func TestTheStufenHaltezeitCoversWhatStoodAndNothingOnANaNVerdict(t *testing.T) {
	auth := holdAuthorities()[0]
	if got := auth.applyStood(NewLoadFollower(), followBase(), 0, 2.0, nightRead(4.12)); got.Kw != -2.0 || !got.Held {
		t.Fatalf("from rest, 2 kW that stood are covered and the rest waits: %+v", got)
	}
	if got := auth.applyStood(NewLoadFollower(), followBase(), 0, math.NaN(), nightRead(4.12)); got.Kw != 0 || !got.Held {
		t.Fatalf("a NaN verdict covers nothing: %+v", got)
	}
}
