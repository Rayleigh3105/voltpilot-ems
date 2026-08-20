package csms

import (
	"testing"
	"time"
)

// ChargingTotal is the second half of the Stufe-2 control law, so its two
// rules are asserted here rather than left to the caller.
func TestChargingTotalCountsOnlyWhatItCanProve(t *testing.T) {
	now := time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)
	fresh := now.Add(-5 * time.Second)
	old := now.Add(-2 * time.Minute)

	session := &Session{TransactionID: 1, StartedAt: now.Add(-time.Hour)}
	mk := func(id int, kw *float64, at time.Time) Connector {
		return Connector{ID: id, Status: StatusCharging, Session: session, PowerKw: kw, MeteredAt: at}
	}

	t.Run("two measured connectors add up", func(t *testing.T) {
		snap := Snapshot{Chargers: []ChargerState{{
			Charger: Charger{ID: "A"}, Connected: true,
			Connectors: []Connector{mk(1, f(20), fresh), mk(2, f(15.5), fresh)},
		}}}
		kw, complete := snap.ChargingTotal(now, time.Minute)
		if !complete || kw != 35.5 {
			t.Fatalf("kw=%v complete=%v, want 35.5/true", kw, complete)
		}
	})

	t.Run("a connector without a measurement makes it incomplete", func(t *testing.T) {
		snap := Snapshot{Chargers: []ChargerState{{
			Charger: Charger{ID: "A"}, Connected: true,
			Connectors: []Connector{mk(1, f(20), fresh), mk(2, nil, time.Time{})},
		}}}
		if _, complete := snap.ChargingTotal(now, time.Minute); complete {
			t.Fatal("an authorised head we cannot measure must make the number incomplete")
		}
	})

	t.Run("a stale measurement is no measurement", func(t *testing.T) {
		snap := Snapshot{Chargers: []ChargerState{{
			Charger: Charger{ID: "A"}, Connected: true,
			Connectors: []Connector{mk(1, f(20), old)},
		}}}
		if _, complete := snap.ChargingTotal(now, time.Minute); complete {
			t.Fatal("a two-minute-old sample must not count as fresh")
		}
	})

	t.Run("an unreachable station is not our power to add back", func(t *testing.T) {
		snap := Snapshot{Chargers: []ChargerState{
			{Charger: Charger{ID: "A"}, Connected: true, Connectors: []Connector{mk(1, f(20), fresh)}},
			// Disconnected: it is holding its own safe default, and that draw
			// is already inside the measured grid power.
			{Charger: Charger{ID: "B"}, Connectors: []Connector{mk(1, nil, time.Time{})}},
		}}
		kw, complete := snap.ChargingTotal(now, time.Minute)
		if !complete || kw != 20 {
			t.Fatalf("kw=%v complete=%v, want 20/true", kw, complete)
		}
	})

	t.Run("a connector that claims no budget need not report", func(t *testing.T) {
		snap := Snapshot{Chargers: []ChargerState{{
			Charger: Charger{ID: "A"}, Connected: true,
			Connectors: []Connector{
				mk(1, f(20), fresh),
				{ID: 2, Status: StatusAvailable}, // free plug, no session
			},
		}}}
		kw, complete := snap.ChargingTotal(now, time.Minute)
		if !complete || kw != 20 {
			t.Fatalf("kw=%v complete=%v, want 20/true", kw, complete)
		}
	})

	t.Run("an empty site measures zero, completely", func(t *testing.T) {
		kw, complete := Snapshot{}.ChargingTotal(now, time.Minute)
		if !complete || kw != 0 {
			t.Fatalf("kw=%v complete=%v, want 0/true", kw, complete)
		}
	})

	t.Run("a negative reported power never inflates the add-back", func(t *testing.T) {
		snap := Snapshot{Chargers: []ChargerState{{
			Charger: Charger{ID: "A"}, Connected: true,
			Connectors: []Connector{mk(1, f(-5), fresh)},
		}}}
		if kw, _ := snap.ChargingTotal(now, time.Minute); kw != 0 {
			t.Fatalf("kw=%v, want 0", kw)
		}
	})
}
