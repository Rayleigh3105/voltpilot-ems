package csms

import (
	"testing"
	"time"
)

// A STATION-SIDE start or stop (Connector.DrawChangedAt, PowerSettled).
//
// The pairing rule (MeterInTransit) knew one kind of change: a limit WE
// commanded, which the station follows within one metering cadence. A car that
// wakes up is the other kind: the station reports Charging, the car draws
// nothing yet, then ramps over several MeterValues (Edge-Light-Pilot,
// 05.10.2026, go-e: Charging at 09:47:45, 0 kW at :49, 0.75 kW at :59, 1.58 kW
// at 09:48:09).

func TestOnlyCrossingTheChargingLineStampsTheDrawChange(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	s := recoveryServer(t, t.TempDir(), now)
	stamp := func() time.Time {
		c, _ := s.Snapshot().ChargerByID("CP")
		return c.ConnectorByID(1).DrawChangedAt
	}
	at := func(sec int) time.Time { return now.Add(time.Duration(sec) * time.Second) }

	s.onStatus("CP", 1, StatusSuspendedEVSE, "NoError", at(0))
	if !stamp().IsZero() {
		t.Fatal("a connector that never drew has not changed its draw")
	}
	s.onStatus("CP", 1, StatusCharging, "NoError", at(1))
	if !stamp().Equal(at(1)) {
		t.Fatalf("starting to draw is a change: %v", stamp())
	}
	s.onStatus("CP", 1, StatusCharging, "NoError", at(2))
	if !stamp().Equal(at(1)) {
		t.Fatal("a repeated Charging is not a new start")
	}
	s.onStatus("CP", 1, StatusSuspendedEV, "NoError", at(3))
	if !stamp().Equal(at(3)) {
		t.Fatal("stopping to draw is a change")
	}
	s.onStatus("CP", 1, StatusSuspendedEVSE, "NoError", at(4))
	if !stamp().Equal(at(3)) {
		t.Fatal("between two non-drawing states nothing changed")
	}
}

func TestAPowerSampleKeepsItsPredecessor(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	s := recoveryServer(t, t.TempDir(), now)
	first, second := 0.75, 1.58
	s.onMeterSample("CP", 1, MeterReading{PowerKw: &first}, now, now, nil)
	s.onMeterSample("CP", 1, MeterReading{PowerKw: &second}, now.Add(10*time.Second), now.Add(10*time.Second), nil)
	c, _ := s.Snapshot().ChargerByID("CP")
	con := c.ConnectorByID(1)
	if con.PrevPowerKw == nil || *con.PrevPowerKw != first || !con.PrevMeteredAt.Equal(now) || *con.PowerKw != second {
		t.Fatalf("the previous sample must be kept: %+v", con)
	}
}

func TestASampleFromBeforeTheCarWokeUpIsInTransit(t *testing.T) {
	now := time.Date(2026, 10, 5, 7, 47, 45, 0, time.UTC)
	kw := 1.58
	con := Connector{ID: 1, Status: StatusCharging, PowerKw: &kw, MeteredAt: now.Add(-time.Second), DrawChangedAt: now}
	if !con.MeterInTransit() {
		t.Fatal("a sample taken before the station started describes a draw that no longer exists")
	}
	con.MeteredAt = now.Add(time.Second)
	if con.MeterInTransit() {
		t.Fatal("a sample taken after the start describes the current draw")
	}
}

func TestTheDrawSettlesOnTwoAgreeingSamplesAfterTheChange(t *testing.T) {
	changed := time.Date(2026, 10, 5, 7, 47, 45, 0, time.UTC)
	kw := func(v float64) *float64 { return &v }
	sample := func(sec int) time.Time { return changed.Add(time.Duration(sec) * time.Second) }
	limit := kw(1.72)
	cases := []struct {
		name    string
		con     Connector
		settled bool
	}{
		{"no station-side change", Connector{Status: StatusCharging, PowerKw: kw(1.58), MeteredAt: sample(4)}, true},
		{"one sample since the change", Connector{Status: StatusCharging, PowerKw: kw(0.75), MeteredAt: sample(14),
			PrevPowerKw: kw(0), PrevMeteredAt: sample(-6), DrawChangedAt: changed, CommandedKw: limit}, false},
		{"ramping", Connector{Status: StatusCharging, PowerKw: kw(1.58), MeteredAt: sample(24),
			PrevPowerKw: kw(0.75), PrevMeteredAt: sample(14), DrawChangedAt: changed, CommandedKw: limit}, false},
		{"settled at its draw", Connector{Status: StatusCharging, PowerKw: kw(1.59), MeteredAt: sample(34),
			PrevPowerKw: kw(1.58), PrevMeteredAt: sample(24), DrawChangedAt: changed, CommandedKw: limit}, true},
		{"car still waking up", Connector{Status: StatusCharging, PowerKw: kw(0), MeteredAt: sample(14),
			PrevPowerKw: kw(0), PrevMeteredAt: sample(4), DrawChangedAt: changed, CommandedKw: limit}, false},
		{"paused, settled at zero", Connector{Status: StatusSuspendedEVSE, PowerKw: kw(0), MeteredAt: sample(14),
			PrevPowerKw: kw(0), PrevMeteredAt: sample(4), DrawChangedAt: changed, CommandedKw: kw(0)}, true},
		{"within the relative tolerance", Connector{Status: StatusCharging, PowerKw: kw(10.5), MeteredAt: sample(24),
			PrevPowerKw: kw(11.0), PrevMeteredAt: sample(14), DrawChangedAt: changed, CommandedKw: kw(11)}, true},
	}
	for _, tc := range cases {
		if got := tc.con.PowerSettled(); got != tc.settled {
			t.Errorf("%s: settled=%v, want %v", tc.name, got, tc.settled)
		}
	}
}

func TestChargingPairNamesTheMomentOfASettlingConnector(t *testing.T) {
	now := time.Date(2026, 10, 5, 7, 48, 4, 600_000_000, time.UTC)
	const maxAge, window = 30 * time.Second, 3 * time.Second
	kw := func(v float64) *float64 { return &v }
	settling := func(id int, meteredAt time.Time) Connector {
		return Connector{ID: id, Status: StatusCharging, Session: &Session{TransactionID: id},
			PowerKw: kw(0.75), MeteredAt: meteredAt, PrevPowerKw: kw(0), PrevMeteredAt: meteredAt.Add(-10 * time.Second),
			DrawChangedAt: meteredAt.Add(-14 * time.Second), CommandedKw: kw(1.72)}
	}
	snap := func(cons ...Connector) Snapshot {
		return Snapshot{Chargers: []ChargerState{{Charger: Charger{ID: "goe"}, Connected: true, Connectors: cons}}}
	}

	steady := Connector{ID: 1, Status: StatusCharging, Session: &Session{TransactionID: 1}, PowerKw: kw(1.58), MeteredAt: now.Add(-5 * time.Second)}
	if total, complete, at := snap(steady).ChargingPair(now, maxAge, window); !complete || !at.IsZero() || total != 1.58 {
		t.Fatalf("a settled connector pairs with the current reading: %v %v %v", total, complete, at)
	}

	metered := now.Add(-5100 * time.Millisecond)
	total, complete, at := snap(settling(1, metered)).ChargingPair(now, maxAge, window)
	if !complete || !at.Equal(metered) || total != 0.75 {
		t.Fatalf("a settling connector's sample measures its own moment: %v %v %v", total, complete, at)
	}

	far := snap(settling(1, metered), settling(2, metered.Add(4*time.Second)))
	if _, complete, _ := far.ChargingPair(now, maxAge, window); complete {
		t.Fatal("two settling samples 4 s apart cannot share one grid reading")
	}
	near := snap(settling(1, metered), settling(2, metered.Add(time.Second)))
	if _, complete, at := near.ChargingPair(now, maxAge, window); !complete || !at.Equal(metered.Add(time.Second)) {
		t.Fatalf("two settling samples 1 s apart share the reading nearest to them: %v %v", complete, at)
	}

	stale := settling(1, now.Add(-31*time.Second))
	if _, complete, _ := snap(stale).ChargingPair(now, maxAge, window); complete {
		t.Fatal("the plain staleness rule still applies")
	}
}
