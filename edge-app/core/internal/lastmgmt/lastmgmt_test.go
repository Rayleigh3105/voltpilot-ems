package lastmgmt

import (
	"math"
	"testing"
	"time"
)

var base = time.Date(2026, 8, 20, 13, 24, 0, 0, time.UTC)

// site is the mockups' running example (Mockups §1): a 277 kW connection,
// 10 % margin, three DC stations with two plugs each, a 30 kW Mindestleistung.
func site(houseReserve float64) Settings {
	return Settings{
		GridLimitKw:    277,
		HouseReserveKw: houseReserve,
		MarginPct:      10,
		MinPowerKw:     30,
		RotationPeriod: 15 * time.Minute,
		MaxHouseLoadKw: 180,
	}.WithDefaults()
}

func sess(key string, maxKw float64, since time.Duration) Session {
	return Session{Key: key, MaxKw: maxKw, Since: base.Add(since)}
}

func alloc(t *testing.T, p Plan, key string) Allocation {
	t.Helper()
	a, ok := p.Get(key)
	if !ok {
		t.Fatalf("no allocation for %q in %+v", key, p.Allocations)
	}
	return a
}

func near(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.01 {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

// TestBudgetIsNeverSpentToTheLastKw: the engineering margin exists because
// OCPP is a seconds-scale loop and vehicles follow it slowly (Konzept §4.2).
func TestBudgetIsNeverSpentToTheLastKw(t *testing.T) {
	// The margin comes off the CONNECTION first: 277 -> never plan above 249.3;
	// the building's 167 kW then leaves 82.3 kW for charging. Taking the margin
	// off the remainder instead would yield 99 kW - a third car charging that
	// must not be.
	near(t, "planable", site(0).BudgetKw(), 249.3)
	near(t, "budget with the building reserved", site(167).BudgetKw(), 82.3)

	// A building that eats the whole connection leaves nothing - and the
	// answer is 0, not a negative number and not a friendly minimum.
	near(t, "over-reserved", site(300).BudgetKw(), 0)
	near(t, "unconfigured site", Settings{}.WithDefaults().BudgetKw(), 0)
}

// TestOneVehicleGetsEverythingItCanUse: the whole point of water filling - a
// lone car is not held to a fair share of one.
func TestOneVehicleGetsEverythingItCanUse(t *testing.T) {
	p := Decide(Input{Settings: site(0), Now: base, Sessions: []Session{sess("A#1", 120, 0)}})
	a := alloc(t, p, "A#1")
	if a.Paused || a.Reason != ReasonCharging {
		t.Fatalf("lone session paused: %+v", a)
	}
	near(t, "allocation", a.Kw, 120) // its own ceiling, not the budget
	near(t, "plan total", p.AllocatedKw, 120)
}

// TestUnusedHeadRoomIsHandedBack: a small car on a big site must not sit on a
// share it cannot use.
func TestUnusedHeadRoomIsHandedBack(t *testing.T) {
	p := Decide(Input{Settings: site(0), Now: base, Sessions: []Session{
		sess("SMALL#1", 11, 0), // an AC box
		sess("BIG#1", 240, time.Second),
	}})
	near(t, "small", alloc(t, p, "SMALL#1").Kw, 11)
	near(t, "big", alloc(t, p, "BIG#1").Kw, 238.3) // 249.3 - 11, capped by nothing else
	near(t, "total", p.AllocatedKw, 249.3)
	if p.AllocatedKw > p.BudgetKw+1e-6 {
		t.Fatalf("allocated %v exceeds the budget %v", p.AllocatedKw, p.BudgetKw)
	}
}

// TestThreeCarsShareTheBudgetEqually is the L1 rig case in pure form.
func TestThreeCarsShareTheBudgetEqually(t *testing.T) {
	p := Decide(Input{Settings: site(0), Now: base, Sessions: []Session{
		sess("A#1", 240, 0), sess("A#2", 240, time.Second), sess("B#1", 240, 2*time.Second),
	}})
	for _, k := range []string{"A#1", "A#2", "B#1"} {
		near(t, k, alloc(t, p, k).Kw, 83.1)
	}
	near(t, "total", p.AllocatedKw, 249.3)
}

// TestPausingBeatsStarving is the non-convex floor (the D4 discipline on n
// vehicles): 82 kW over three cars is 27 kW each, below the 30 kW minimum, so
// one waits and two really charge - the mockups' scenario, arithmetic and all.
func TestPausingBeatsStarving(t *testing.T) {
	p := Decide(Input{Settings: site(167), Now: base, Sessions: []Session{
		sess("A#1", 240, 0), sess("A#2", 240, time.Second), sess("B#1", 240, 2*time.Second),
	}})
	near(t, "budget", p.BudgetKw, 82.3)

	charging, paused := 0, 0
	for _, a := range p.Allocations {
		if a.Paused {
			paused++
			near(t, a.Key+" paused value", a.Kw, 0)
			if a.Reason != ReasonBudget {
				t.Fatalf("%s: reason %q, want %q", a.Key, a.Reason, ReasonBudget)
			}
			continue
		}
		charging++
		if a.Kw < 30 {
			t.Fatalf("%s allocated %v kW, below the 30 kW Mindestleistung - that is starving, not charging", a.Key, a.Kw)
		}
		// The mockups' own scenario, arithmetic and all: 82.3 kW over two
		// admitted cars is 41.15 kW each.
		near(t, a.Key, a.Kw, 41.15)
	}
	if charging != 2 || paused != 1 {
		t.Fatalf("got %d charging / %d paused, want 2/1", charging, paused)
	}
	near(t, "total", p.AllocatedKw, 82.3)
}

// TestARotationTurnChangesWhoWaits: no vehicle stands forever.
func TestARotationTurnChangesWhoWaits(t *testing.T) {
	in := Input{Settings: site(167), Now: base, Sessions: []Session{
		sess("A#1", 240, 0), sess("A#2", 240, time.Second), sess("B#1", 240, 2*time.Second),
	}}
	waiting := func(p Plan) string {
		for _, a := range p.Allocations {
			if a.Paused {
				return a.Key
			}
		}
		return ""
	}
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		in.Now = base.Add(time.Duration(i) * 15 * time.Minute)
		in.Previous = nil
		seen[waiting(Decide(in))] = true
	}
	if len(seen) != 3 {
		t.Fatalf("after three turns only %v had to wait - the rotation is not turning", seen)
	}

	// WITHIN one rotation period the answer is stable: a queue that reshuffles
	// every few seconds would interrupt a charge for nothing. NOTE the epochs
	// are wall-clock aligned (13:15/13:30/... for a 15-min cadence), which is
	// what makes the decision stateless and reproducible - so "stable" is
	// tested inside one epoch, not across an arbitrary +14 minutes.
	in.Now = base.Add(15 * time.Minute) // 13:39, inside [13:30, 13:45)
	first := waiting(Decide(in))
	in.Now = in.Now.Add(5 * time.Minute) // 13:44, same epoch
	if again := waiting(Decide(in)); again != first {
		t.Fatalf("the queue turned inside one period: %s -> %s", first, again)
	}
}

// TestAWaitingVehicleIsToldWhenItsTurnComes - the mockups' "dran in ca. 2 Min."
// is derived, not decoration; and it is only claimed when it is computable.
func TestAWaitingVehicleIsToldWhenItsTurnComes(t *testing.T) {
	// 82.3 kW, 30 kW minimum -> 2 slots; five cars, so three wait.
	in := Input{Settings: site(167), Now: base.Add(3 * time.Minute), Sessions: []Session{
		sess("A#1", 240, 0), sess("A#2", 240, time.Second), sess("B#1", 240, 2*time.Second),
		sess("B#2", 240, 3*time.Second), sess("C#1", 240, 4*time.Second),
	}}
	p := Decide(in)
	waits := 0
	for _, a := range p.Allocations {
		if !a.Paused {
			continue
		}
		waits++
		if a.NextTurnAt.IsZero() {
			t.Fatalf("%s waits without being told when: %+v", a.Key, a)
		}
		if !a.NextTurnAt.After(in.Now) {
			t.Fatalf("%s: next turn %v is not in the future", a.Key, a.NextTurnAt)
		}
		// The fairness guarantee: with n sessions nobody waits longer than n
		// turns, whatever the queue looks like.
		if d := a.NextTurnAt.Sub(in.Now); d > time.Duration(len(in.Sessions))*15*time.Minute {
			t.Fatalf("%s: next turn in %v, more than %d rotation periods away", a.Key, d, len(in.Sessions))
		}
	}
	if waits != 3 {
		t.Fatalf("got %d waiting, want 3", waits)
	}
}

// TestVorrangIsARankNotABypass (Captain decision): a priority station is served
// to its full demand first, the rest share what remains - fairly, and still
// under every limit.
func TestVorrangIsARankNotABypass(t *testing.T) {
	vip := sess("VIP#1", 100, 5*time.Second)
	vip.Priority = true
	p := Decide(Input{Settings: site(167), Now: base, Sessions: []Session{
		sess("A#1", 240, 0), sess("A#2", 240, time.Second), vip,
	}})
	// Its FULL demand first - capped only by the budget itself (82.3 < 100).
	near(t, "vip", alloc(t, p, "VIP#1").Kw, 82.3)
	// ... and it did NOT get more than the budget: the rest is what is left.
	near(t, "total", p.AllocatedKw, 82.3)
	if p.AllocatedKw > p.BudgetKw+1e-6 {
		t.Fatalf("Vorrang broke the budget: %v > %v", p.AllocatedKw, p.BudgetKw)
	}
	// The two ordinary cars wait; the VIP arrived LAST and still went first.
	for _, k := range []string{"A#1", "A#2"} {
		if a := alloc(t, p, k); !a.Paused {
			t.Fatalf("%s should wait behind the Vorrang station: %+v", k, a)
		}
	}
}

// TestVorrangDoesNotRotateOut: a priority station keeps its place; only the
// ordinary tail takes turns.
func TestVorrangDoesNotRotateOut(t *testing.T) {
	vip := sess("VIP#1", 60, 0)
	vip.Priority = true
	in := Input{Settings: site(167), Now: base, Sessions: []Session{
		vip, sess("A#1", 240, time.Second), sess("B#1", 240, 2*time.Second), sess("C#1", 240, 3*time.Second),
	}}
	for i := 0; i < 5; i++ {
		in.Now = base.Add(time.Duration(i) * 15 * time.Minute)
		if a := alloc(t, Decide(in), "VIP#1"); a.Paused {
			t.Fatalf("the Vorrang station was rotated out at turn %d: %+v", i, a)
		}
	}
}

// TestASiteTooSmallSaysSoInsteadOfPromisingATurn: "wait" would be a promise
// nobody can keep when even the WHOLE budget is below the minimum.
func TestASiteTooSmallSaysSoInsteadOfPromisingATurn(t *testing.T) {
	small := site(0)
	small.GridLimitKw = 20
	small.MinPowerKw = 30
	p := Decide(Input{Settings: small, Now: base, Sessions: []Session{sess("A#1", 240, 0)}})
	a := alloc(t, p, "A#1")
	if !a.Paused || a.Reason != ReasonBelowMinimum {
		t.Fatalf("got %+v, want a paused %q", a, ReasonBelowMinimum)
	}
	if !a.NextTurnAt.IsZero() {
		t.Fatal("a turn was promised that will never come")
	}

	// No budget at all is its own reason - the operator lever is a different one.
	p = Decide(Input{Settings: Settings{}.WithDefaults(), Now: base, Sessions: []Session{sess("A#1", 11, 0)}})
	if a := alloc(t, p, "A#1"); !a.Paused || a.Reason != ReasonNoBudget {
		t.Fatalf("got %+v, want a paused %q", a, ReasonNoBudget)
	}
}

// TestPacingHoldsSmallIncreasesButNeverADecrease: a profile write is not free
// (the Deye EEPROM lesson generalised), but a reduction protects the
// connection and a protection you postpone is not one.
func TestPacingHoldsSmallIncreasesButNeverADecrease(t *testing.T) {
	in := Input{Settings: site(0), Now: base, Sessions: []Session{sess("A#1", 100, 0), sess("B#1", 100, time.Second)}}
	p1 := Decide(in)
	near(t, "A first", alloc(t, p1, "A#1").Kw, 100)

	// B's ceiling drops a hair -> A's share grows by 0.5 kW: not worth a write.
	in.Previous = &p1
	in.Now = base.Add(5 * time.Second)
	in.Sessions = []Session{sess("A#1", 100.5, 0), sess("B#1", 100, time.Second)}
	p2 := Decide(in)
	near(t, "A held", alloc(t, p2, "A#1").Kw, 100)

	// After the hold time the same small increase goes through.
	in.Previous = &p2
	in.Now = base.Add(45 * time.Second)
	p3 := Decide(in)
	near(t, "A after the hold", alloc(t, p3, "A#1").Kw, 100.5)

	// A DECREASE is never held, however small.
	in.Previous = &p3
	in.Now = base.Add(46 * time.Second)
	in.Sessions = []Session{sess("A#1", 100.4, 0), sess("B#1", 100, time.Second)}
	if got := alloc(t, Decide(in), "A#1").Kw; got != 100.4 {
		t.Fatalf("a decrease was paced: got %v, want 100.4", got)
	}
}

// TestPacingDoesNotRenewItsOwnHold: holding must expire on schedule, not be
// refreshed by every 5-second decision - otherwise a small increase would be
// held forever.
func TestPacingDoesNotRenewItsOwnHold(t *testing.T) {
	in := Input{Settings: site(0), Now: base, Sessions: []Session{sess("A#1", 100, 0), sess("B#1", 100, time.Second)}}
	p := Decide(in)
	in.Sessions = []Session{sess("A#1", 100.5, 0), sess("B#1", 100, time.Second)}
	for i := 1; i <= 6; i++ {
		in.Previous = &p
		in.Now = base.Add(time.Duration(i) * 5 * time.Second)
		p = Decide(in)
	}
	// 30 s of 5-second decisions: the hold has expired exactly once.
	near(t, "A after six ticks", alloc(t, p, "A#1").Kw, 100.5)
}

// TestPauseAndResumeAreNeverPaced: a pause is a reduction, and a resume is the
// thing the customer is waiting for.
func TestPauseAndResumeAreNeverPaced(t *testing.T) {
	in := Input{Settings: site(167), Now: base, Sessions: []Session{
		sess("A#1", 40, 0), sess("B#1", 40, time.Second),
	}}
	p1 := Decide(in)
	for _, a := range p1.Allocations {
		if a.Paused {
			t.Fatalf("both fit in 99 kW: %+v", p1.Allocations)
		}
	}
	// A third car arrives one second later - somebody must wait AT ONCE.
	in.Previous = &p1
	in.Now = base.Add(time.Second)
	in.Sessions = append(in.Sessions, sess("C#1", 40, 2*time.Second))
	p2 := Decide(in)
	paused := 0
	for _, a := range p2.Allocations {
		if a.Paused {
			paused++
			near(t, a.Key, a.Kw, 0)
		}
	}
	if paused == 0 {
		t.Fatal("the pause was paced away")
	}
}

// TestDecideIsDeterministic: the same facts decide the same way, whatever
// order they arrive in - two boxes, two restarts, one answer.
func TestDecideIsDeterministic(t *testing.T) {
	a := []Session{sess("A#1", 240, 0), sess("A#2", 240, time.Second), sess("B#1", 240, 2*time.Second)}
	b := []Session{a[2], a[0], a[1]}
	p1 := Decide(Input{Settings: site(167), Now: base, Sessions: a})
	p2 := Decide(Input{Settings: site(167), Now: base, Sessions: b})
	if len(p1.Allocations) != len(p2.Allocations) {
		t.Fatalf("different lengths: %d vs %d", len(p1.Allocations), len(p2.Allocations))
	}
	for i := range p1.Allocations {
		x, y := p1.Allocations[i], p2.Allocations[i]
		if x.Key != y.Key || x.Kw != y.Kw || x.Paused != y.Paused || x.Reason != y.Reason {
			t.Fatalf("input order changed the decision at %d: %+v vs %+v", i, x, y)
		}
	}
}

// TestNoSessionsIsAnEmptyPlanNotAnEmptyClaim: an idle site allocates nothing
// and says nothing.
func TestNoSessionsIsAnEmptyPlan(t *testing.T) {
	p := Decide(Input{Settings: site(0), Now: base})
	if len(p.Allocations) != 0 || p.AllocatedKw != 0 {
		t.Fatalf("idle site: %+v", p)
	}
	if p.Allocations == nil {
		t.Fatal("the allocation list must be an empty list, never null")
	}
	near(t, "budget still reported", p.BudgetKw, 249.3)
}

// TestReasonTextIsNeverInvented: a word we do not understand must not become a
// sentence.
func TestReasonTextIsNeverInvented(t *testing.T) {
	for _, r := range []string{ReasonCharging, ReasonBudget, ReasonNoBudget, ReasonBelowMinimum} {
		if Text(r) == "" {
			t.Fatalf("reason %q has no German text", r)
		}
	}
	for _, r := range []string{"", "wartet", "unbekannt"} {
		if Text(r) != "" {
			t.Fatalf("reason %q was given a sentence", r)
		}
	}
}
