package guards

// THE HOLD in the follower (Captain decision A, 2026-10-13): a deficit that has
// not been measured without a break for DeficitCoverHold never raises the
// discharge - in every slot kind, for every authority. The clock itself is
// DeficitHold (deficitcover_test.go); these tests hand its verdict in.

import (
	"math"
	"testing"
	"time"
)

// holdRead is a house with 5 kW PV and the given load; the storage sits well
// above every floor.
func holdRead(loadKw float64) Reading {
	return Reading{SocPct: 60, PvKw: 5.0, LoadKw: loadKw, GridLimitKw: Unknown()}
}

const (
	holdQuietLoad    = 4.2  // 0,8 kW PV surplus
	holdConsumerLoad = 6.82 // the 2,62 kW consumer of Herzogau on top: 1,82 kW short
)

// allStood is the clock's verdict on a deficit that has stood at every height -
// what the follower's own Apply passes.
var allStood = math.Inf(1)

// stood is the verdict for a test that asks only WHETHER the deficit has stood.
func stood(sustained bool) float64 {
	if sustained {
		return allStood
	}
	return 0
}

// holdAuthority is one of the three ways a measured deficit may become a
// discharge from a command at rest.
type holdAuthority struct {
	name                               string
	coverLoad, unplanned, deficitCover bool
	path                               string
}

func holdAuthorities() []holdAuthority {
	return []holdAuthority{
		{name: "Ruhe-Viertelstunde (deficit_cover)", deficitCover: true, path: "deficit_cover"},
		{name: "ungeplante Lastdeckung (unplanned_load_discharge)", unplanned: true, path: "idle_follow"},
		{name: "Deck-Viertelstunde (cover_load_from_battery)", coverLoad: true, path: "follow"},
	}
}

func (h holdAuthority) apply(f *LoadFollower, at time.Time, kw float64, sustained bool, r Reading) FollowResult {
	floor := 5.0
	return f.ApplyAuthorized(at, kw, h.coverLoad, h.unplanned, h.deficitCover, false,
		stood(sustained), &floor, true, followLimits(), r)
}

// From rest, no authority discharges for a deficit that has not stood - and
// each of them covers it the moment it has.
func TestTheHoldKeepsEveryAuthorityAtRestUntilTheDeficitHasStood(t *testing.T) {
	for _, auth := range holdAuthorities() {
		t.Run(auth.name, func(t *testing.T) {
			f := NewLoadFollower()
			at := followBase()
			// The consumer switches on; tick after tick the deficit is measured,
			// but the clock has not reached the hold.
			for i := 0; i < 6; i++ {
				got := auth.apply(f, at.Add(time.Duration(i)*10*time.Second), 0, false, holdRead(holdConsumerLoad))
				if got.Kw != 0 || got.Active || got.Direction != "" || got.Path != "" {
					t.Fatalf("tick %d: %+v - a deficit that has not stood must not discharge", i, got)
				}
				if !got.Held {
					t.Fatalf("tick %d: the wait must be named: %+v", i, got)
				}
				if math.Abs(got.DeficitKw-1.82) > 1e-9 {
					t.Fatalf("tick %d: the measured deficit stays the measured one: %+v", i, got)
				}
			}
			// It has stood: covered in full, under the authority's own name.
			got := auth.apply(f, at.Add(70*time.Second), 0, true, holdRead(holdConsumerLoad))
			if !got.Active || got.Direction != FollowDeepen || got.Path != auth.path ||
				math.Abs(got.Kw+1.82) > 1e-9 || got.Held {
				t.Fatalf("a deficit that stood for the hold is covered: %+v", got)
			}
		})
	}
}

// A consumer that ends inside the hold leaves no trace: no discharge during
// it, none after it, and no wait claimed once the house is not short.
func TestTheHoldLeavesNoTraceOfAConsumerThatEndsInsideIt(t *testing.T) {
	for _, auth := range holdAuthorities() {
		t.Run(auth.name, func(t *testing.T) {
			f := NewLoadFollower()
			at := followBase()
			auth.apply(f, at, 0, false, holdRead(holdConsumerLoad))
			auth.apply(f, at.Add(10*time.Second), 0, false, holdRead(holdConsumerLoad))
			got := auth.apply(f, at.Add(20*time.Second), 0, false, holdRead(holdQuietLoad))
			if got.Kw != 0 || got.Active || got.Held {
				t.Fatalf("the consumer is off - nothing to cover, nothing waits: %+v", got)
			}
		})
	}
}

// THE REDUCE HALF IS PART OF IT. A covering slot carries the plan's own
// forecast discharge. On a PV surplus the follower limits it to zero - and a
// short consumer must not bring it back: until the deficit has stood the house
// has been shown to need nothing, so the limit stays where it is.
func TestTheHoldKeepsACoveringSlotsForecastDischargeLimitedThroughAShortConsumer(t *testing.T) {
	cases := []struct {
		name               string
		coverLoad, limit   bool
		planKw             float64
		path               string
		sustainedKw        float64
		sustainedDirection string
	}{
		// cover_load_from_battery: both halves - the stood deficit is covered in full.
		{"cover_load_from_battery, Plan -1,0 kW", true, false, -1.0, "follow", -1.82, FollowDeepen},
		// limit_discharge_to_load alone: the plan's -3 kW limited to the house.
		{"limit_discharge_to_load, Plan -3,0 kW", false, true, -3.0, "limit", -1.82, FollowReduce},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := NewLoadFollower()
			floor := 5.0
			at := followBase()
			step := func(n int, sustained bool, load float64) FollowResult {
				return f.ApplyAuthorized(at.Add(time.Duration(n)*10*time.Second), tc.planKw,
					tc.coverLoad, false, false, tc.limit, stood(sustained), &floor, true, followLimits(), holdRead(load))
			}
			// PV covers the house: the forecast discharge is limited to zero.
			if got := step(0, false, holdQuietLoad); got.Kw != 0 || got.Direction != FollowReduce || got.Path != tc.path || got.Held {
				t.Fatalf("on a surplus the discharge is stopped: %+v", got)
			}
			// The consumer: the plan's value must NOT return for it.
			for n := 1; n <= 2; n++ {
				got := step(n, false, holdConsumerLoad)
				if got.Kw != 0 || got.Direction != FollowReduce || got.Path != tc.path {
					t.Fatalf("tick %d into the consumer: %+v - the limit stays at zero", n, got)
				}
				if !got.Held {
					t.Fatalf("tick %d: the wait must be named: %+v", n, got)
				}
			}
			// Off again: still zero, nothing waits.
			if got := step(3, false, holdQuietLoad); got.Kw != 0 || got.Held {
				t.Fatalf("after the consumer: %+v", got)
			}
			// A deficit that stays: once it has stood, the slot does what it
			// always did.
			step(4, false, holdConsumerLoad)
			got := step(11, true, holdConsumerLoad)
			if math.Abs(got.Kw-tc.sustainedKw) > 1e-9 || got.Direction != tc.sustainedDirection ||
				got.Path != tc.path || got.Held {
				t.Fatalf("a deficit that stood: %+v, want %.2f kW %s", got, tc.sustainedKw, tc.sustainedDirection)
			}
		})
	}
}

// A WAIT, NOT AN OUTAGE. A cover that runs is not dropped because the evidence
// had a gap (a stale reading restarts the clock): the follower keeps what it
// already covers, follows the house DOWN at once, and merely cannot grow until
// the deficit has stood again.
func TestTheHoldKeepsARunningCoverAndOnlyRefusesToRaiseIt(t *testing.T) {
	f := NewLoadFollower()
	floor := 5.0
	at := followBase()
	night := func(load float64) Reading {
		return Reading{SocPct: 60, PvKw: 0, LoadKw: load, GridLimitKw: Unknown()}
	}
	step := func(n int, sustained bool, load float64) FollowResult {
		return f.ApplyAuthorized(at.Add(time.Duration(n)*10*time.Second), -1.5,
			true, false, false, false, stood(sustained), &floor, true, followLimits(), night(load))
	}
	// A covering slot at night: plan -1,5 kW, the house draws 0,5 kW.
	if got := step(0, true, 0.5); got.Kw != -0.5 || got.Direction != FollowReduce {
		t.Fatalf("the standing deficit is followed: %+v", got)
	}
	// The clock restarts (a gap in the evidence). The cover stays.
	if got := step(1, false, 0.5); got.Kw != -0.5 || got.Held {
		t.Fatalf("a running cover is kept through a restarted clock: %+v", got)
	}
	// A load step that has not stood: not raised - and that is named.
	if got := step(2, false, 3.0); got.Kw != -0.5 || !got.Held {
		t.Fatalf("an unproven load step must not raise the discharge: %+v", got)
	}
	// The house draws less: followed down with this very tick.
	if got := step(3, false, 0.2); got.Kw != -0.2 || got.Held {
		t.Fatalf("lowering is immediate: %+v", got)
	}
	// ... and what was given up is not kept in reserve for the next step.
	if got := step(4, false, 3.0); got.Kw != -0.2 || !got.Held {
		t.Fatalf("the level in force is the one of the previous tick: %+v", got)
	}
	// The deficit has stood: covered in full.
	if got := step(11, true, 3.0); got.Kw != -3.0 || got.Direction != FollowDeepen || got.Path != "follow" || got.Held {
		t.Fatalf("a load step that stood is covered: %+v", got)
	}
}

// A discharge the PLAN commands in a slot without the reduce right runs
// unchanged, clock or not: the hold only ever withholds what a MEASUREMENT
// would add. And once such a discharge is in force it is the level a deficit
// that has not stood may keep.
func TestTheHoldNeverTouchesAPlannedDischargeItMayNotLimit(t *testing.T) {
	f := NewLoadFollower()
	floor := 5.0
	at := followBase()
	step := func(n int, sustained bool) FollowResult {
		return f.ApplyAuthorized(at.Add(time.Duration(n)*10*time.Second), -4.3,
			false, false, true, false, stood(sustained), &floor, true, followLimits(), pilstingNight())
	}
	for n := 0; n < 3; n++ {
		got := step(n, false)
		if got.Kw != -4.3 || got.Active {
			t.Fatalf("tick %d: the planned -4,3 kW runs unchanged: %+v", n, got)
		}
		if !got.Held {
			t.Fatalf("tick %d: the house draws 7,1 kW - the withheld deepen is named: %+v", n, got)
		}
	}
	if got := step(7, true); !got.Active || got.Direction != FollowDeepen || got.Path != "deficit_cover" ||
		math.Abs(got.Kw+7.087) > 1e-9 || got.Held {
		t.Fatalf("the deficit stood: deepened to the house: %+v", got)
	}
	// A planned sale deeper than the house: untouched, and nothing waits.
	sale := NewLoadFollower().ApplyAuthorized(at, -27, false, false, true, false, 0,
		&floor, true, followLimits(), holdRead(holdConsumerLoad))
	if sale.Kw != -27 || sale.Active || sale.Held {
		t.Fatalf("a planned sale is no deficit cover: %+v", sale)
	}
}

// Release forgets the level in force: after an early exit of the setpoint path
// (no reading, a bounded test write) nothing of this stage runs any more.
func TestTheHoldFindsNothingToKeepAfterRelease(t *testing.T) {
	f := NewLoadFollower()
	floor := 5.0
	at := followBase()
	step := func(n int, sustained bool) FollowResult {
		return f.ApplyAuthorized(at.Add(time.Duration(n)*10*time.Second), 0,
			false, false, true, false, stood(sustained), &floor, true, followLimits(), holdRead(holdConsumerLoad))
	}
	if got := step(0, true); got.Kw != -1.82 {
		t.Fatalf("covered: %+v", got)
	}
	if got := step(1, false); got.Kw != -1.82 || got.Held {
		t.Fatalf("kept through a restarted clock: %+v", got)
	}
	f.Release()
	if got := step(2, false); got.Kw != 0 || !got.Held {
		t.Fatalf("after Release a deficit that has not stood starts from rest: %+v", got)
	}
}

// The wait is named only where the measured deficit would have moved the
// discharge: not under the follower's own engage margin, not without an
// authority, not on a charge.
func TestTheHoldClaimsNoWaitWhereNothingWouldHaveMoved(t *testing.T) {
	floor := 5.0
	at := followBase()
	// 0,15 kW short: below the engage margin the follower would not have acted.
	small := NewLoadFollower().ApplyAuthorized(at, 0, false, false, true, false, 0,
		&floor, true, followLimits(), holdRead(5.15))
	if small.Held || small.Kw != 0 {
		t.Fatalf("below the engage margin nothing waits: %+v", small)
	}
	// No authority at all.
	none := NewLoadFollower().ApplyAuthorized(at, 0, false, false, false, false, 0,
		&floor, true, followLimits(), holdRead(holdConsumerLoad))
	if none.Held || none.Kw != 0 {
		t.Fatalf("without an authority nothing waits: %+v", none)
	}
	// The reduce right alone on a command at rest: it could never have raised.
	limit := NewLoadFollower().ApplyAuthorized(at, 0, false, false, false, true, 0,
		&floor, true, followLimits(), holdRead(holdConsumerLoad))
	if limit.Held || limit.Kw != 0 {
		t.Fatalf("the reduce right raises nothing, so nothing waits: %+v", limit)
	}
	// A commanded charge is left alone.
	charge := NewLoadFollower().ApplyAuthorized(at, 2, true, false, false, false, 0,
		&floor, true, followLimits(), holdRead(holdConsumerLoad))
	if charge.Held || charge.Kw != 2 {
		t.Fatalf("a charge is not this guard's: %+v", charge)
	}
}

// The floor and the rated band bind a cover that was allowed to begin exactly
// as before - the hold is a condition in front of the bounds, never a way
// around them.
func TestTheHoldChangesNoBound(t *testing.T) {
	at := followBase()
	// At the reserve nothing is covered, stood or not, and nothing "waits".
	floor := 60.0
	for _, sustained := range []bool{false, true} {
		got := NewLoadFollower().ApplyAuthorized(at, 0, false, false, true, false, stood(sustained),
			&floor, true, followLimits(), holdRead(holdConsumerLoad))
		if got.Kw != 0 || got.Active || got.Held {
			t.Fatalf("at the reserve (sustained=%v): %+v", sustained, got)
		}
	}
	// The rated band caps a stood deficit.
	low := 5.0
	l := followLimits()
	l.MaxDischargeKw = 1
	got := NewLoadFollower().ApplyAuthorized(at, 0, false, false, true, false, allStood,
		&low, true, l, holdRead(holdConsumerLoad))
	if got.Kw != -1 {
		t.Fatalf("rated band: %+v, want -1 kW", got)
	}
}
