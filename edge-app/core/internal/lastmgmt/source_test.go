package lastmgmt

import (
	"testing"
	"time"
)

// This file proves the STUFE-4 source lane INSIDE the allocator: the two caps
// compose most-restrictive-wins, neither widens the other, and the „Jetzt voll
// laden"-Übersteuerung exempts from the ECONOMY, never from the PHYSICS.

func kwp(v float64) *float64 { return &v }

// TestWithoutASourceLaneTheAllocationIsByteForByteStufe3 is the compatibility
// promise: a customer who never picks a source policy sees no change.
func TestWithoutASourceLaneTheAllocationIsByteForByteStufe3(t *testing.T) {
	in := Input{
		Settings: site(0),
		Sessions: []Session{sess("a#1", 50, 0), sess("b#1", 50, time.Minute)},
		Now:      base,
	}
	p := Decide(in)
	if p.SourceBudgetKw != nil || p.SourceAllocatedKw != 0 {
		t.Fatalf("no source lane must leave no source figures: %+v", p)
	}
	near(t, "a", alloc(t, p, "a#1").Kw, 50)
	near(t, "b", alloc(t, p, "b#1").Kw, 50)
}

// TestTheLowerOfTheTwoCapsWins is the Kombinations-Streifen of the mockups
// (§2b): the load management says HOW MUCH, the surplus charging says FROM
// WHERE, and the lower one binds.
func TestTheLowerOfTheTwoCapsWins(t *testing.T) {
	// Physically 249,3 kW would be free; the sun offers 60.
	p := Decide(Input{
		Settings:       site(0),
		Sessions:       []Session{sess("a#1", 50, 0), sess("b#1", 50, time.Minute)},
		SourceBudgetKw: kwp(60),
		Now:            base,
	})
	near(t, "allocated", p.AllocatedKw, 60)
	near(t, "source covered", p.SourceAllocatedKw, 60)
	if p.SourceBudgetKw == nil || *p.SourceBudgetKw != 60 {
		t.Fatalf("the lane must be reported: %+v", p.SourceBudgetKw)
	}

	// And the other way round: a big sun cannot widen a small connection.
	small := sess("a#1", 50, 0)
	small.MinKw = 5
	q := Decide(Input{
		Settings:       site(220), // 249,3 - 220 = 29,3 kW physical
		Sessions:       []Session{small},
		SourceBudgetKw: kwp(200),
		Now:            base,
	})
	near(t, "capped by the connection", q.AllocatedKw, 29.3)
}

// TestNurSonnenstromPausesWithItsOwnWord - and the word is not
// "Budget vergeben", because the lever is a different one.
func TestNurSonnenstromPausesWithItsOwnWord(t *testing.T) {
	p := Decide(Input{
		Settings:       site(0), // 249,3 kW physically free
		Sessions:       []Session{sess("a#1", 50, 0)},
		SourceBudgetKw: kwp(5), // a cloud
		Policy:         PolicySolarOnly,
		Now:            base,
	})
	a := alloc(t, p, "a#1")
	if !a.Paused || a.Reason != ReasonNoSurplus {
		t.Fatalf("reason = %q paused=%v", a.Reason, a.Paused)
	}
	if got := TextFor(a.Reason, PolicySolarOnly); got != "wartet — kein Überschuss (Ihre Priorität: Nur Sonnenstrom)" {
		t.Fatalf("sentence = %q", got)
	}
}

// TestSonneZuerstKeepsTheVehicleAliveFromTheGrid - the concession that makes
// the default default.
func TestSonneZuerstKeepsTheVehicleAliveFromTheGrid(t *testing.T) {
	p := Decide(Input{
		Settings:            site(0),
		Sessions:            []Session{sess("a#1", 50, 0)},
		SourceBudgetKw:      kwp(5),
		SourceAllowsMinimum: true,
		Policy:              PolicySolarFirst,
		Now:                 base,
	})
	a := alloc(t, p, "a#1")
	if a.Paused {
		t.Fatal("„Sonne zuerst\" must not leave a vehicle standing")
	}
	near(t, "minimum from the grid", a.Kw, 30)
	// It never claims the sun covered it.
	if p.SourceAllocatedKw > 5.01 {
		t.Fatalf("source coverage = %v, must not exceed the lane", p.SourceAllocatedKw)
	}
}

// TestTheConcessionStillRespectsTheConnection - it is a SOURCE concession, not
// a physical one.
func TestTheConcessionStillRespectsTheConnection(t *testing.T) {
	p := Decide(Input{
		Settings:            site(230), // 19,3 kW free, below the 30 kW minimum
		Sessions:            []Session{sess("a#1", 50, 0)},
		SourceBudgetKw:      kwp(0),
		SourceAllowsMinimum: true,
		Now:                 base,
	})
	a := alloc(t, p, "a#1")
	if !a.Paused || a.Reason != ReasonBelowMinimum {
		t.Fatalf("the connection must still bind: %+v", a)
	}
}

// TestBoostExemptsFromTheSourceNeverFromThePhysics is the dialog's fourth
// consequence, as arithmetic.
func TestBoostExemptsFromTheSourceNeverFromThePhysics(t *testing.T) {
	boosted := sess("a#1", 50, 0)
	boosted.BoostUntil = base.Add(time.Hour)
	p := Decide(Input{
		Settings:       site(0),
		Sessions:       []Session{boosted, sess("b#1", 50, time.Minute)},
		SourceBudgetKw: kwp(10),
		Policy:         PolicySolarOnly,
		Now:            base,
	})
	a := alloc(t, p, "a#1")
	if a.Paused || !a.Boost {
		t.Fatalf("the boosted session must charge and be marked: %+v", a)
	}
	near(t, "boosted", a.Kw, 50)
	// The OTHER vehicle keeps the customer's priority - the dialog's second
	// consequence, verbatim.
	b := alloc(t, p, "b#1")
	if !b.Paused || b.Reason != ReasonNoSurplus {
		t.Fatalf("the neighbour must keep the source policy: %+v", b)
	}
	if b.Boost {
		t.Fatal("only the overridden session is boosted")
	}
	// The site figure never counts the boosted grid power as sun.
	if p.SourceAllocatedKw != 0 {
		t.Fatalf("source coverage = %v, want 0 (the sun covered nobody)", p.SourceAllocatedKw)
	}

	// And the connection still binds a boosted session.
	small := boosted
	small.MinKw = 5
	q := Decide(Input{
		Settings:       site(230), // 19,3 kW free
		Sessions:       []Session{small},
		SourceBudgetKw: kwp(0),
		Now:            base,
	})
	near(t, "a boost never widens the connection", alloc(t, q, "a#1").Kw, 19.3)
}

// TestAnExpiredBoostIsNoBoost - it ends by itself (Mockups §2a).
func TestAnExpiredBoostIsNoBoost(t *testing.T) {
	s := sess("a#1", 50, 0)
	s.BoostUntil = base.Add(-time.Second)
	p := Decide(Input{
		Settings: site(0), Sessions: []Session{s},
		SourceBudgetKw: kwp(0), Policy: PolicySolarOnly, Now: base,
	})
	a := alloc(t, p, "a#1")
	if a.Boost || !a.Paused {
		t.Fatalf("an expired boost must not exempt: %+v", a)
	}
}

// TestBoostNeverOutranksAGenuineVorrang - the override is a source exemption,
// not an escalation over the customer's standing choice.
func TestBoostNeverOutranksAGenuineVorrang(t *testing.T) {
	prio := sess("p#1", 50, time.Minute)
	prio.Priority = true
	boosted := sess("a#1", 50, 0)
	boosted.BoostUntil = base.Add(time.Hour)
	p := Decide(Input{
		Settings:       site(210), // 39,3 kW free: exactly ONE 30-kW minimum fits
		Sessions:       []Session{prio, boosted},
		SourceBudgetKw: kwp(39.3), // the sun is not the discriminator here
		Policy:         PolicySolarOnly,
		Now:            base,
	})
	if alloc(t, p, "p#1").Paused {
		t.Fatal("Vorrang is served first, boost or not")
	}
	if !alloc(t, p, "a#1").Paused {
		t.Fatal("the boosted tail session must wait behind Vorrang")
	}
}

// TestBoostIsServedBeforeTheSourceBoundOfTheSameRank - „wirkt wie temporärer
// Vorrang mit Quelle-egal" (Mockups §2a), without touching the rank.
func TestBoostIsServedBeforeTheSourceBoundOfTheSameRank(t *testing.T) {
	early := sess("b#1", 50, 0) // arrived FIRST
	boosted := sess("a#1", 50, time.Minute)
	boosted.BoostUntil = base.Add(time.Hour)
	p := Decide(Input{
		Settings:       site(210), // 39,3 kW physical, one 30-kW minimum
		Sessions:       []Session{early, boosted},
		SourceBudgetKw: kwp(39.3),
		Now:            base,
	})
	if alloc(t, p, "a#1").Paused {
		t.Fatal("the boosted session draws from the physical pool and goes first")
	}
	if !alloc(t, p, "b#1").Paused {
		t.Fatal("the source-bound neighbour then finds the pool spent")
	}
}

// TestASourceLaneOfZeroIsNotABudgetOfZero - the two words stay apart, because
// the two levers do.
func TestASourceLaneOfZeroIsNotABudgetOfZero(t *testing.T) {
	p := Decide(Input{
		Settings: site(300), // the building ate the connection
		Sessions: []Session{sess("a#1", 50, 0)},
		Now:      base,
	})
	if alloc(t, p, "a#1").Reason != ReasonNoBudget {
		t.Fatalf("no connection budget must stay its own word: %q", alloc(t, p, "a#1").Reason)
	}
}
