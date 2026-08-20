package ocppsim

import (
	"math"
	"testing"
	"time"
)

var t0 = time.Date(2026, 8, 20, 13, 24, 0, 0, time.UTC)

func p(id, connector int, purpose string, limitW float64, d time.Duration) Profile {
	return Profile{ID: id, ConnectorD: connector, Purpose: purpose, LimitW: limitW, StartsAt: t0, Duration: d}
}

func near(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("%s = %v, want %v", what, got, want)
	}
}

// TestTheStackResolvesTheOcppWay: TxProfile beats TxDefaultProfile, both are
// capped by ChargePointMaxProfile. This is the station's job, and modelling it
// is what makes "the budget is held" measurable rather than merely acked.
func TestTheStackResolvesTheOcppWay(t *testing.T) {
	stack := []Profile{
		p(1, 0, PurposeMax, 240000, 0),
		p(2, 0, PurposeTxDefault, 15000, 0),
		p(11, 1, PurposeTx, 41000, 2*time.Minute),
	}
	got, ok := Resolve(stack, 1, t0)
	if !ok {
		t.Fatal("no limit resolved")
	}
	near(t, "connector 1", got, 41000)

	// Connector 2 has no TxProfile of its own -> the station-wide default.
	got, ok = Resolve(stack, 2, t0)
	if !ok {
		t.Fatal("no limit for connector 2")
	}
	near(t, "connector 2", got, 15000)

	// The station cap binds even a bigger TxProfile.
	capped := append(stack, p(12, 2, PurposeTx, 400000, time.Minute))
	got, _ = Resolve(capped, 2, t0)
	near(t, "capped by the station maximum", got, 240000)
}

// TestAnExpiredLiveProfileStopsApplying IS the dead man's switch, modelled at
// the station where it really happens.
func TestAnExpiredLiveProfileStopsApplying(t *testing.T) {
	stack := []Profile{
		p(2, 0, PurposeTxDefault, 15000, 0),
		p(11, 1, PurposeTx, 41000, 2*time.Minute),
	}
	got, _ := Resolve(stack, 1, t0.Add(time.Minute))
	near(t, "while fresh", got, 41000)

	got, _ = Resolve(stack, 1, t0.Add(3*time.Minute))
	near(t, "after it expired", got, 15000)

	// ... and a PERMANENT profile never expires, however long we wait.
	got, _ = Resolve(stack, 1, t0.Add(1000*time.Hour))
	near(t, "the permanent default a year later", got, 15000)
}

// TestNoProfileIsNotALimitOfZero: an unmanaged station charges at its own
// rating. Conflating "no limit" with "0" would make a load manager look like
// it works right up until the first expiry.
func TestNoProfileIsNotALimitOfZero(t *testing.T) {
	if _, ok := Resolve(nil, 1, t0); ok {
		t.Fatal("an empty stack must resolve to NO limit, not to 0")
	}
	v := Vehicle{DemandKw: 240}
	near(t, "unmanaged draw", DrawKw(v, nil, 1, t0), 240)

	// A commanded 0, by contrast, really is a stop.
	stack := []Profile{p(11, 1, PurposeTx, 0, time.Minute)}
	near(t, "a commanded pause", DrawKw(v, stack, 1, t0), 0)
}

// TestPausingBeatsStarvingIsPhysics: a car allocated below its own floor does
// not charge slower - it does not charge at all, and the power is spent on
// nothing. That is the reason the allocator pauses instead.
func TestPausingBeatsStarvingIsPhysics(t *testing.T) {
	v := Vehicle{DemandKw: 240, MinKw: 30}
	stack := []Profile{p(11, 1, PurposeTx, 27000, time.Minute)}
	near(t, "below the floor", DrawKw(v, stack, 1, t0), 0)

	stack = []Profile{p(11, 1, PurposeTx, 41000, time.Minute)}
	near(t, "above the floor", DrawKw(v, stack, 1, t0), 41)
}

// TestACarNeverDrawsMoreThanItWants: the limit is a ceiling, not a setpoint.
func TestACarNeverDrawsMoreThanItWants(t *testing.T) {
	v := Vehicle{DemandKw: 11}
	stack := []Profile{p(11, 1, PurposeTx, 240000, time.Minute)}
	near(t, "a small car under a big limit", DrawKw(v, stack, 1, t0), 11)
}

// TestResolutionIsDeterministic: two profiles of one purpose must not resolve
// by map order.
func TestResolutionIsDeterministic(t *testing.T) {
	a := Profile{ID: 20, ConnectorD: 1, Purpose: PurposeTx, StackLevel: 0, LimitW: 10000, StartsAt: t0, Duration: time.Minute}
	b := Profile{ID: 21, ConnectorD: 1, Purpose: PurposeTx, StackLevel: 3, LimitW: 20000, StartsAt: t0, Duration: time.Minute}
	first, _ := Resolve([]Profile{a, b}, 1, t0)
	second, _ := Resolve([]Profile{b, a}, 1, t0)
	if first != second {
		t.Fatalf("input order changed the answer: %v vs %v", first, second)
	}
	near(t, "the higher stack level wins", first, 20000)
}
