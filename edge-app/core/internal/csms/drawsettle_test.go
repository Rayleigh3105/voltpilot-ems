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

func TestTheDrawSettlesOnTwoAgreeingSamplesOfAStartedCar(t *testing.T) {
	changed := time.Date(2026, 10, 5, 7, 47, 45, 0, time.UTC)
	kw := func(v float64) *float64 { return &v }
	at := func(sec int) time.Time { return changed.Add(time.Duration(sec) * time.Second) }
	limit := kw(2.22)
	charging := func(prev, cur float64, prevAt, curAt int) Connector {
		return Connector{Status: StatusCharging, PowerKw: kw(cur), MeteredAt: at(curAt), PrevPowerKw: kw(prev),
			PrevMeteredAt: at(prevAt), DrawChangedAt: changed, CommandedKw: limit}
	}
	cases := []struct {
		name    string
		con     Connector
		now     int
		settled bool
	}{
		{"no station-side change", Connector{Status: StatusCharging, PowerKw: kw(1.58), MeteredAt: at(4)}, 5, true},
		{"one sample since the change", charging(0, 0.75, -6, 14), 15, false},
		{"ramping", charging(0.75, 1.58, 14, 24), 25, false},
		{"settled at its draw", charging(2.18, 2.2, 24, 34), 35, true},
		{"car still waking up", charging(0, 0, 4, 14), 15, false},
		// pilot 11:04: two samples 0.16 kW apart, but the car had not started
		{"barely started", charging(-0.01, 0.15, 4, 14), 15, false},
		{"within the relative tolerance", Connector{Status: StatusCharging, PowerKw: kw(10.5), MeteredAt: at(24),
			PrevPowerKw: kw(11.0), PrevMeteredAt: at(14), DrawChangedAt: changed, CommandedKw: kw(11)}, 25, true},
		{"paused, settled at zero", Connector{Status: StatusSuspendedEVSE, PowerKw: kw(0), MeteredAt: at(14),
			PrevPowerKw: kw(0), PrevMeteredAt: at(4), DrawChangedAt: changed, CommandedKw: kw(0)}, 15, true},
		{"a car that draws little settles only by timeout", charging(0.3, 0.3, 14, 24), 25, false},
		{"... and then it does", charging(0.3, 0.3, 14, 24), 40, true},
		{"the timeout ends any settling", charging(0, 0.75, -6, 14), 40, true},
	}
	for _, tc := range cases {
		if got := tc.con.PowerSettled(at(tc.now)); got != tc.settled {
			t.Errorf("%s: settled=%v, want %v", tc.name, got, tc.settled)
		}
	}
}

func TestDrawSettlingAsksEveryChargePointInsideTheMeasurement(t *testing.T) {
	now := time.Date(2026, 10, 5, 9, 4, 1, 0, time.UTC)
	kw := func(v float64) *float64 { return &v }
	settling := Connector{ID: 1, Status: StatusCharging, Session: &Session{TransactionID: 1},
		PowerKw: kw(0.15), MeteredAt: now.Add(-5 * time.Second), PrevPowerKw: kw(-0.01), PrevMeteredAt: now.Add(-15 * time.Second),
		DrawChangedAt: now.Add(-16 * time.Second), CommandedKw: kw(2.22)}
	steady := Connector{ID: 1, Status: StatusCharging, Session: &Session{TransactionID: 1}, PowerKw: kw(2.2), MeteredAt: now.Add(-5 * time.Second)}
	station := func(con Connector) ChargerState {
		return ChargerState{Charger: Charger{ID: "goe"}, Connected: true, Connectors: []Connector{con}}
	}
	if (Snapshot{Chargers: []ChargerState{station(steady)}}).DrawSettling(now) {
		t.Fatal("a settled charge point does not hold the lanes")
	}
	if !(Snapshot{Chargers: []ChargerState{station(steady), station(settling)}}).DrawSettling(now) {
		t.Fatal("one settling charge point is enough")
	}
	gone := station(settling)
	gone.Connected = false
	if (Snapshot{Chargers: []ChargerState{gone}}).DrawSettling(now) {
		t.Fatal("a disconnected station is building load, nothing to settle")
	}
}
