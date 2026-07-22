package agent

// M-B3-local: the :8484 dashboard must show LIVE VALUES on a v1->v2 migrated
// plant. The cloud pushes the entity registry, so the dashboard flips to the
// entity-driven tiles + adaptive Energiefluss (both read /api/state's topology
// block) - but the device's Layer-1 flows still publish only the v1 composite
// site sample, so before this the entity tiles read "wartet auf Daten" / "—".
//
// These tests pin BOTH halves: the tiles fill from the local composition, and
// the CLOUD UPLINK stays byte-unchanged (the composition is display-only; the
// cloud fans the same v1 sample out itself, so uplinking it here would
// double-write telemetry_v2).

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/topology"
)

// migratedRegistry is what the cloud backfill pushes for a real plant:
// battery-hybrid + grid-meter + house-load, all composed from v1 master data.
func migratedRegistry() entities.Registry {
	measure := func(chans ...string) entities.Capabilities {
		var m []entities.MeasureCap
		for _, c := range chans {
			m = append(m, entities.MeasureCap{Channel: c})
		}
		return entities.Capabilities{Measure: m}
	}
	return entities.Registry{
		Revision: "rev-1",
		Entities: []entities.Entity{
			{ID: "batt-1", Type: entities.TypeBatteryHybrid, Label: "Batteriespeicher",
				Capabilities: measure("soc_pct", "pv_power_kw", "battery_power_kw")},
			{ID: "grid-1", Type: entities.TypeGridMeter, Label: "Netz",
				Capabilities: measure("power_kw")},
			{ID: "haus-1", Type: entities.TypeHouseLoad, Label: "Haus",
				Capabilities: measure("power_kw")},
		},
	}
}

func nodeByRole(topo topology.Topology, role string) *topology.FlowNode {
	for i := range topo.Nodes {
		if topo.Nodes[i].Role == role {
			return &topo.Nodes[i]
		}
	}
	return nil
}

func TestMigratedPlantEntityTilesFillFromTheLocalComposition(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(migratedRegistry())

	// BEFORE: registry applied, no site sample yet -> the dashboard already
	// flips to the entity tiles (nodes exist) but has nothing to show. This is
	// exactly the reported "wartet auf Daten" state.
	before := a.Topology()
	if len(before.Nodes) == 0 {
		t.Fatal("registry should already produce role nodes (the adaptive flip)")
	}
	for _, n := range before.Nodes {
		if n.ValueKw != nil || n.SocPct != nil {
			t.Fatalf("no telemetry yet, so no value may exist: %+v", n)
		}
	}

	// One site sample, the shape the Layer-1 flows publish today.
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"soc_pct": 87, "pv_power_kw": 5.85, "load_kw": 0.7, "power_kw": -5.15}`))

	after := a.Topology()
	pv := nodeByRole(after, topology.RolePV)
	storage := nodeByRole(after, topology.RoleStorage)
	grid := nodeByRole(after, topology.RoleGrid)
	consumer := nodeByRole(after, topology.RoleConsumer)
	for name, n := range map[string]*topology.FlowNode{
		"pv": pv, "storage": storage, "grid": grid, "consumer": consumer,
	} {
		if n == nil {
			t.Fatalf("%s node missing from %+v", name, after)
		}
	}
	// The read-model carries magnitude + direction (the sign lives in
	// Direction), so assert both.
	check := func(name string, n *topology.FlowNode, kw float64, dir string) {
		t.Helper()
		if n.ValueKw == nil || *n.ValueKw != kw || n.Direction != dir {
			t.Fatalf("%s tile: value=%v dir=%q, want %v %q", name, n.ValueKw, n.Direction, kw, dir)
		}
	}
	check("PV", pv, 5.85, "in")
	check("Netz", grid, 5.15, "out") // -5.15 = export
	check("Haus", consumer, 0.7, "out")
	if storage.SocPct == nil || *storage.SocPct != 87 {
		t.Fatalf("Batteriespeicher SoC tile: %v", storage.SocPct)
	}
	// battery_power_kw = power_kw - load_kw + pv_power_kw = -5.15 - 0.7 + 5.85
	check("Batteriespeicher", storage, 0, "")
	if storage.Members[0].Label != "Batteriespeicher" {
		t.Fatalf("member label lost: %+v", storage.Members)
	}
}

// THE BOUNDARY: the composition is display-only. One v1 site sample must
// produce exactly ONE buffered entry (the v1 telemetry) - never an additional
// per-entity v2 entry that would double-write against the cloud fan-out.
func TestLocalCompositionNeverGrowsTheCloudUplink(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(migratedRegistry())

	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"soc_pct": 50, "pv_power_kw": 4, "load_kw": 1, "power_kw": 2}`))

	if got := a.buf.Pending(); got != 1 {
		t.Fatalf("one site sample must buffer exactly one v1 entry, got %d", got)
	}
	e, ok := a.buf.Next()
	if !ok {
		t.Fatal("expected the v1 sample in the buffer")
	}
	if e.EntityID != "" {
		t.Fatalf("composed entity telemetry must never be uplinked, got %+v", e)
	}
	if _, ok := e.Measurements["battery_power_kw"]; ok {
		t.Fatalf("the derived battery power is display-only, not a published channel: %v", e.Measurements)
	}

	// The heartbeat's observed Ist reports what the DEVICE reports, so a purely
	// composed entity stays "never" - the cloud must not be told the edge
	// publishes per-entity telemetry it does not publish.
	sum := a.entitiesSummary()
	if sum == nil {
		t.Fatal("entities summary missing")
	}
	for id, obs := range sum.Observed {
		if obs.Health != "never" {
			t.Fatalf("%s observed health should stay 'never' (composition is local), got %q", id, obs.Health)
		}
	}
}

// A REAL per-entity publisher always wins over the composition.
func TestRealEntityTelemetryWinsOverTheComposition(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(migratedRegistry())
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"soc_pct": 50, "pv_power_kw": 4, "load_kw": 1, "power_kw": 2}`))

	payload := []byte(`{"schema_version":"1.0","entity_id":"grid-1","ts":"` +
		time.Now().UTC().Format(time.RFC3339) + `","channels":{"power_kw": -9.5}}`)
	a.onEntityTelemetry(entities.TelemetryTopic("grid-1"), payload)

	grid := nodeByRole(a.Topology(), topology.RoleGrid)
	if grid == nil || grid.ValueKw == nil || *grid.ValueKw != 9.5 || grid.Direction != "out" {
		t.Fatalf("real entity telemetry must win (want 9.5 out), got %+v", grid)
	}
}

// A device WITHOUT a pushed registry composes nothing and behaves v1.
func TestUnmigratedDeviceComposesNothing(t *testing.T) {
	a := newGateTestAgent(t)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"soc_pct": 50, "pv_power_kw": 4, "load_kw": 1, "power_kw": 2}`))
	if len(a.Topology().Nodes) != 0 {
		t.Fatal("no registry must yield an empty topology")
	}
	a.entMu.Lock()
	n := len(a.entComposed)
	a.entMu.Unlock()
	if n != 0 {
		t.Fatalf("no registry must compose nothing, got %d", n)
	}
}
