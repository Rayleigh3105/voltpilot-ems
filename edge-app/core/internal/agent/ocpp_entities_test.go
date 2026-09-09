package agent

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

func snapWith(chargers ...csms.ChargerState) csms.Snapshot {
	return csms.Snapshot{Enabled: true, Chargers: chargers}
}

// A charge point the cloud has bound to a component publishes what its station
// MEASURED - the whole point of E1, and the reason the portal can drop its
// /chargers special case for kilowatts.
func TestAChargePointPublishesItsMeasuredPowerAsEntityTelemetry(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	metered := now.Add(-5 * time.Second)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{
			ID: 1, Status: csms.StatusCharging,
			PowerKw: f64(11.04), EnergyKwh: f64(1234.5), EnergyMeasuredAt: metered, MeteredAt: metered,
		}},
	})
	got := ocppEntityReadings(snap, map[string]string{"WB-1": "ent-wb1"}, now, ocppMeterMaxAge)
	if len(got) != 1 {
		t.Fatalf("want 1 reading, got %d", len(got))
	}
	if got[0].EntityID != "ent-wb1" {
		t.Fatalf("entity = %q", got[0].EntityID)
	}
	if !got[0].Ts.Equal(metered) {
		t.Fatalf("ts = %v, want the OBSERVATION time %v", got[0].Ts, metered)
	}
	if got[0].Channels["power_kw"] != 11.04 || got[0].Channels["energy_kwh"] != 1234.5 {
		t.Fatalf("channels = %v", got[0].Channels)
	}
}

// A station's plugs are summed into ONE component: the cloud binds an entity
// per CHARGE POINT (device_charge_point.entity_id), not per plug.
func TestTheConnectorsOfOneStationSumIntoItsComponent(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	older, newer := now.Add(-8*time.Second), now.Add(-2*time.Second)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{
			{ID: 1, PowerKw: f64(7.2), EnergyKwh: f64(100), EnergyMeasuredAt: older, MeteredAt: older},
			{ID: 2, PowerKw: f64(3.8), EnergyKwh: f64(50), EnergyMeasuredAt: newer, MeteredAt: newer},
		},
	})
	got := ocppEntityReadings(snap, map[string]string{"WB-1": "ent"}, now, ocppMeterMaxAge)
	if len(got) != 1 || got[0].Channels["power_kw"] != 11 || got[0].Channels["energy_kwh"] != 150 {
		t.Fatalf("got %+v", got)
	}
	if !got[0].Ts.Equal(newer) {
		t.Fatalf("ts = %v, want the NEWEST contributing sample %v", got[0].Ts, newer)
	}
}

// Not measured is never 0: a station without MeterValues (or one that went
// silent) publishes NOTHING, so the series gaps instead of claiming zero kW.
func TestAStationWithoutFreshMeterValuesPublishesNothing(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	binding := map[string]string{"WB-1": "ent"}

	never := snapWith(csms.ChargerState{
		Charger:    csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{ID: 1, Status: csms.StatusCharging}},
	})
	if got := ocppEntityReadings(never, binding, now, ocppMeterMaxAge); len(got) != 0 {
		t.Fatalf("a station that never metered must publish nothing, got %+v", got)
	}

	stale := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{
			ID: 1, PowerKw: f64(11), MeteredAt: now.Add(-ocppMeterMaxAge - time.Second),
		}},
	})
	if got := ocppEntityReadings(stale, binding, now, ocppMeterMaxAge); len(got) != 0 {
		t.Fatalf("a stale sample is not a reading, got %+v", got)
	}
}

// ⚠ A PARTIAL sum is not a measurement: one plug of a two-plug station going
// silent would quietly drop its share, and the remainder would read downstream
// as the station's real power. The whole station gaps instead.
func TestAPartiallySilentStationPublishesNothing(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{
			{ID: 1, PowerKw: f64(7.2), MeteredAt: now.Add(-2 * time.Second)},
			{ID: 2, PowerKw: f64(3.8), MeteredAt: now.Add(-ocppMeterMaxAge - time.Second)},
		},
	})
	if got := ocppEntityReadings(snap, map[string]string{"WB-1": "ent"}, now, ocppMeterMaxAge); len(got) != 0 {
		t.Fatalf("an incomplete station must gap, not report %v", got)
	}
}

// A plug that NEVER metered is simply not part of the sum - it is not the same
// as one that stopped. A station whose other plug measures still reports.
func TestANeverMeteredPlugDoesNotBlockItsStation(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{
			{ID: 1, PowerKw: f64(7.2), MeteredAt: now.Add(-2 * time.Second)},
			{ID: 2, Status: csms.StatusAvailable},
		},
	})
	got := ocppEntityReadings(snap, map[string]string{"WB-1": "ent"}, now, ocppMeterMaxAge)
	if len(got) != 1 || got[0].Channels["power_kw"] != 7.2 {
		t.Fatalf("got %+v", got)
	}
}

// A MEASURED zero is a fact the station reported (a plugged-in car taking
// nothing) and IS published - the other half of "not measured is never 0".
func TestAMeasuredZeroIsPublished(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{
			ID: 1, Status: csms.StatusSuspendedEV, PowerKw: f64(0), MeteredAt: now.Add(-time.Second),
		}},
	})
	got := ocppEntityReadings(snap, map[string]string{"WB-1": "ent"}, now, ocppMeterMaxAge)
	if len(got) != 1 {
		t.Fatalf("want the measured zero, got %+v", got)
	}
	if v, ok := got[0].Channels["power_kw"]; !ok || v != 0 {
		t.Fatalf("power_kw = %v (present %v), want a real 0", v, ok)
	}
}

// Without the cloud's binding NOTHING is published - there is no fallback that
// could pin a station's readings onto the wrong component, and a box paired
// with an older cloud stays byte-identical to before this feature.
func TestWithoutTheCloudBindingNothingIsPublished(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	snap := snapWith(csms.ChargerState{
		Charger:    csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{ID: 1, PowerKw: f64(11), MeteredAt: now}},
	})
	if got := ocppEntityReadings(snap, nil, now, ocppMeterMaxAge); len(got) != 0 {
		t.Fatalf("no binding must publish nothing, got %+v", got)
	}
	other := map[string]string{"WB-OTHER": "ent"}
	if got := ocppEntityReadings(snap, other, now, ocppMeterMaxAge); len(got) != 0 {
		t.Fatalf("a foreign binding must never claim this station, got %+v", got)
	}
}

// soc_pct is deliberately NOT published: it is the CAR's state of charge, and
// topology.DefaultRole maps a soc_pct capability onto the STORAGE node
// regardless of category - a wallbox would start filling in the house
// battery's SoC.
func TestTheCarsStateOfChargeIsNeverPublished(t *testing.T) {
	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{
			ID: 1, PowerKw: f64(11), SocPct: f64(62), MeteredAt: now.Add(-time.Second),
		}},
	})
	got := ocppEntityReadings(snap, map[string]string{"WB-1": "ent"}, now, ocppMeterMaxAge)
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	if _, ok := got[0].Channels["soc_pct"]; ok {
		t.Fatalf("soc_pct must never be published: %v", got[0].Channels)
	}
}

// The registry binding is read from the applied entity registry, so a charge
// point entity WITHOUT charge_point_id (an older cloud) contributes nothing.
func TestChargePointEntitiesReadsTheRegistryBinding(t *testing.T) {
	a := &Agent{}
	a.entRegistry = entities.Registry{Entities: []entities.Entity{
		{ID: "ent-wb1", Type: "ev-charger", ChargePointID: "WB-1"},
		{ID: "ent-old", Type: "ev-charger"},
		{ID: "ent-batt", Type: entities.TypeBatteryHybrid},
	}}
	got := a.chargePointEntities()
	if len(got) != 1 || got["WB-1"] != "ent-wb1" {
		t.Fatalf("binding = %v", got)
	}
}

// The reading really lands on the local bus in the E1b shape, and an unchanged
// sample is not appended twice (the pass runs on a tick AND on every station
// event, so the store-and-forward buffer would otherwise grow for nothing).
func TestThePublishedTelemetryIsTheE1bShapeAndDeduplicates(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	got, sub := busObserver(t, addr, "ocpp-ent", entities.TelemetryTopic("ent-wb1"))
	defer sub.Disconnect(0)

	a := &Agent{Bus: bus, ocpp: &ocppRuntime{}}
	a.entRegistry = entities.Registry{Entities: []entities.Entity{
		{ID: "ent-wb1", Type: "ev-charger", ChargePointID: "WB-1"},
	}}

	now := time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC)
	metered := now.Add(-3 * time.Second)
	snap := snapWith(csms.ChargerState{
		Charger: csms.Charger{ID: "WB-1"},
		Connectors: []csms.Connector{{
			ID: 1, PowerKw: f64(11.04), EnergyKwh: f64(42), EnergyMeasuredAt: metered, MeteredAt: metered,
		}},
	})
	a.publishOcppEntityTelemetry(snap, now)

	var msgs []map[string]any
	for i := 0; i < 60; i++ {
		if msgs = got(); len(msgs) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(msgs) != 1 {
		t.Fatalf("want exactly one published reading, got %d", len(msgs))
	}
	msg := msgs[0]
	if msg["schema_version"] != entities.SchemaVersion || msg["entity_id"] != "ent-wb1" {
		t.Fatalf("envelope = %+v", msg)
	}
	if msg["ts"] != metered.Format(time.RFC3339) {
		t.Fatalf("ts = %v, want the observation time", msg["ts"])
	}
	ch, _ := msg["channels"].(map[string]any)
	if ch["power_kw"] != 11.04 || ch["energy_kwh"] != float64(42) {
		t.Fatalf("channels = %v", ch)
	}

	// Same snapshot again (a station event between two ticks): nothing new.
	a.publishOcppEntityTelemetry(snap, now.Add(2*time.Second))
	time.Sleep(300 * time.Millisecond)
	if again := got(); len(again) != 1 {
		t.Fatalf("an unchanged sample must not be published twice, got %d", len(again))
	}
}

func TestEntityTelemetryKeepsIndependentChannelClocks(t *testing.T) {
	now := time.Now().UTC()
	powerAt := now.Add(-5 * time.Second)
	snap := snapWith(csms.ChargerState{Charger: csms.Charger{ID: "CP"}, Connectors: []csms.Connector{{ID: 1, PowerKw: f64(7), MeteredAt: powerAt, EnergyKwh: f64(12), EnergyMeasuredAt: now}}})
	readings := ocppEntityReadings(snap, map[string]string{"CP": "entity"}, now, ocppMeterMaxAge)
	if len(readings) != 2 || !readings[0].Ts.Equal(powerAt) || readings[0].Channels["power_kw"] != 7 || !readings[1].Ts.Equal(now) || readings[1].Channels["energy_kwh"] != 12 {
		t.Fatalf("channel clocks merged: %+v", readings)
	}
	readings = ocppEntityReadings(snap, map[string]string{"CP": "entity"}, now.Add(28*time.Second), ocppMeterMaxAge)
	if len(readings) != 1 || readings[0].Channels["energy_kwh"] != 12 {
		t.Fatalf("energy revived old power: %+v", readings)
	}
	snap.Chargers[0].Connectors[0].EnergyMeasuredAt = now.Add(time.Second)
	if len(ocppEntityReadings(snap, map[string]string{"CP": "entity"}, now, ocppMeterMaxAge)) != 1 {
		t.Fatal("future energy published")
	}
}
