package csms

import (
	"testing"
	"time"
)

// The PAIRING rule of the dynamic budget (Connector.MeterInTransit).
//
// `rest = grid - charging` is only a measurement of ONE moment while both
// halves describe the same moment. The grid meter follows a changed charging
// power within its own cadence; the station's MeterValues arrive on ITS
// cadence. Pairing a post-change grid reading with a pre-change charging power
// yields a `rest` wrong by exactly the step we just commanded - and the
// smoothing window's trailing MAXIMUM then makes that one sample govern the
// budget AND the surplus for a whole minute.

func meteredConnector(kw float64, meteredAt, commandChangedAt time.Time) Connector {
	return Connector{
		ID: 1, Status: StatusCharging,
		Session:            &Session{TransactionID: 1},
		PowerKw:            &kw,
		MeteredAt:          meteredAt,
		CommandedChangedAt: commandChangedAt,
	}
}

func TestAMeterSampleFromBeforeTheLastCommandIsInTransit(t *testing.T) {
	now := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	changed := now.Add(-1 * time.Second)

	t.Run("older than the change: in transit", func(t *testing.T) {
		c := meteredConnector(12, changed.Add(-500*time.Millisecond), changed)
		if !c.MeterInTransit() {
			t.Fatal("a sample taken before the station was re-commanded still describes the old limit")
		}
	})
	t.Run("newer than the change: settled", func(t *testing.T) {
		c := meteredConnector(22, changed.Add(500*time.Millisecond), changed)
		if c.MeterInTransit() {
			t.Fatal("a sample taken after the change describes the current limit")
		}
	})
	t.Run("never commanded: never in transit", func(t *testing.T) {
		c := meteredConnector(12, now, time.Time{})
		if c.MeterInTransit() {
			t.Fatal("without a command there is no regime to be behind")
		}
	})
	t.Run("never metered: the plain rules already reject it", func(t *testing.T) {
		c := Connector{ID: 1, CommandedChangedAt: changed}
		if c.MeterInTransit() {
			t.Fatal("a connector that never metered must be handled by the missing-sample rule")
		}
	})
}

// ⚠ THE BOUND: the new test can never hold a connector back LONGER than the
// plain staleness rule already does. If MeteredAt predates CommandedChangedAt
// and the change is itself older than maxAge, MeteredAt is older than maxAge
// too - so the drop ends at the same moment it always did.
func TestInTransitNeverOutlastsThePlainStalenessRule(t *testing.T) {
	now := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	const maxAge = 30 * time.Second
	// The command changed 31 s ago and the station never reported since.
	changed := now.Add(-31 * time.Second)
	snap := Snapshot{Chargers: []ChargerState{{
		Charger: Charger{ID: "A"}, Connected: true,
		Connectors: []Connector{meteredConnector(12, changed.Add(-time.Second), changed)},
	}}}
	if _, complete := snap.ChargingTotal(now, maxAge); complete {
		t.Fatal("the sample is stale by the plain rule already")
	}
	// And with a FRESH command the in-transit window is exactly one metering
	// cadence, not a minute.
	fresh := now.Add(-1 * time.Second)
	snap.Chargers[0].Connectors = []Connector{meteredConnector(22, now, fresh)}
	if _, complete := snap.ChargingTotal(now, maxAge); !complete {
		t.Fatal("a station that reported under its new limit is settled again")
	}
}

// The whole point, at the level ChargingTotal owns: an in-transit sample is
// treated exactly like a missing one, so the caller drops the PAIR instead of
// subtracting a pre-change charging power from a post-change grid reading.
func TestChargingTotalRefusesToPairAcrossACommandChange(t *testing.T) {
	now := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	changed := now.Add(-1 * time.Second)
	snap := Snapshot{Chargers: []ChargerState{{
		Charger: Charger{ID: "A"}, Connected: true,
		// Fresh by the metering rule (1,5 s old) but from BEFORE the change.
		Connectors: []Connector{meteredConnector(12, changed.Add(-500*time.Millisecond), changed)},
	}}}
	kw, complete := snap.ChargingTotal(now, 30*time.Second)
	if complete {
		t.Fatalf("a pre-change sample must not be reported as a complete pair (kw=%v)", kw)
	}
}

// recordCommand stamps CommandedChangedAt only on a REAL change of the value.
// The executor re-writes an unchanged limit on every tick (that write re-arms
// the dead man's switch), so stamping unconditionally would mark every
// connector in transit forever and starve the dynamic budget of measurements.
func TestTheChangeStampMovesOnlyWhenTheValueReallyChanges(t *testing.T) {
	now := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	s := &Server{
		chargers: map[string]*ChargerState{"A": {
			Charger:    Charger{ID: "A"},
			Connectors: []Connector{{ID: 1}},
		}},
		opts: Options{Now: func() time.Time { return now }},
	}
	kw := func(v float64) *float64 { return &v }

	s.recordCommand("A", 1, kw(12), "Accepted")
	first := s.chargers["A"].Connectors[0].CommandedChangedAt
	if first != now {
		t.Fatalf("the first command must stamp the change: %v", first)
	}

	// The unconditional per-tick refresh: same value, later moment.
	now = now.Add(20 * time.Second)
	s.recordCommand("A", 1, kw(12), "Accepted")
	con := s.chargers["A"].Connectors[0]
	if con.CommandedChangedAt != first {
		t.Fatalf("an unchanged limit must not move the change stamp: %v", con.CommandedChangedAt)
	}
	if con.CommandedAt != now {
		t.Fatalf("CommandedAt still records every write: %v", con.CommandedAt)
	}

	// A change below the noise deadband is not a new regime either.
	now = now.Add(20 * time.Second)
	s.recordCommand("A", 1, kw(12.01), "Accepted")
	if got := s.chargers["A"].Connectors[0].CommandedChangedAt; got != first {
		t.Fatalf("a 0,01 kW difference is inside the meter noise: %v", got)
	}

	// A real change does move it.
	now = now.Add(20 * time.Second)
	s.recordCommand("A", 1, kw(22), "Accepted")
	if got := s.chargers["A"].Connectors[0].CommandedChangedAt; got != now {
		t.Fatalf("a real change must stamp: %v", got)
	}

	// A transport failure records no value, so it cannot claim a change.
	stamped := now
	now = now.Add(20 * time.Second)
	s.recordCommand("A", 1, nil, "Keine Antwort der Ladesäule")
	if got := s.chargers["A"].Connectors[0].CommandedChangedAt; got != stamped {
		t.Fatalf("a failed write commanded nothing: %v", got)
	}
}
