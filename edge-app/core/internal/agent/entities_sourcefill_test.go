package agent

// PR 4a (vp-vier-erzeuger-p9, contract D-17): the registry push carries the
// adoption pin (edge_source_id), so the device can map its OWN source readings
// onto producer entities DETERMINISTICALLY for its LOCAL display. Before this,
// the :8484 Energiefluss showed the whole folded PV on the hybrid circle and
// "–" on every producer circle (nothing on the device produces per-entity
// telemetry for producers, and ComposeLocal deliberately feeds only the
// composed types). These tests pin the Pilsting picture in miniature:
//
//   - a pinned producer fills from its source reading (21,2 kW, not "–");
//   - the hybrid then shows its PRE-FOLD primary pv (0,2) so the PV role sum
//     stays the composite (21,4) and never double-counts;
//   - an unpinned entity (the ghost) stays honestly empty;
//   - WITHOUT any pinned fill the hybrid keeps the composite (regression);
//   - the fill is DISPLAY-ONLY: the cloud uplink buffer is untouched.

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/topology"
)

func pinnedRegistry(srcID string) entities.Registry {
	measure := func(chans ...string) entities.Capabilities {
		var m []entities.MeasureCap
		for _, c := range chans {
			m = append(m, entities.MeasureCap{Channel: c})
		}
		return entities.Capabilities{Measure: m}
	}
	return entities.Registry{
		Revision: "rev-4a",
		Entities: []entities.Entity{
			{ID: "batt-1", Type: entities.TypeBatteryHybrid, Label: "Batteriespeicher",
				Capabilities: measure("soc_pct", "pv_power_kw", "battery_power_kw")},
			{ID: "wr2", Type: "producer", Label: "Fronius WR2", EdgeSourceID: srcID,
				Capabilities: measure("pv_power_kw")},
			{ID: "geist", Type: "producer", Label: "Geist",
				Capabilities: measure("pv_power_kw")},
		},
	}
}

func memberByEntity(n *topology.FlowNode, entityID string) *topology.FlowMember {
	if n == nil {
		return nil
	}
	for i := range n.Members {
		if n.Members[i].EntityID == entityID {
			return &n.Members[i]
		}
	}
	return nil
}

func TestTopologyFillsPinnedProducersFromOwnSourceReadings(t *testing.T) {
	a := newGateTestAgent(t)
	src := addErzeuger(t, a, 27)
	a.applyEntityRegistry(pinnedRegistry(src.ID))

	feedSource(a, src.ID, 21.2)
	// Primary sample pre-fold: its OWN pv is 0,2; the fold makes the composite
	// 21,4 which ComposeLocal puts on the hybrid.
	feedPrimary(a, 0.2, 5.5, -15, 62)

	topo := a.Topology()
	pv := nodeByRole(topo, topology.RolePV)
	if pv == nil {
		t.Fatalf("pv node missing: %+v", topo)
	}

	wr2 := memberByEntity(pv, "wr2")
	if wr2 == nil || wr2.ValueKw == nil || *wr2.ValueKw != 21.2 {
		t.Fatalf("pinned producer must fill from its source reading, got %+v", wr2)
	}
	hybrid := memberByEntity(pv, "batt-1")
	if hybrid == nil || hybrid.ValueKw == nil || *hybrid.ValueKw != 0.2 {
		t.Fatalf("hybrid must show its PRE-FOLD primary pv (0.2), got %+v", hybrid)
	}
	ghost := memberByEntity(pv, "geist")
	if ghost == nil || ghost.ValueKw != nil {
		t.Fatalf("an unpinned entity stays honestly empty, got %+v", ghost)
	}
	// The role sum is still the composite - no double count, no undercount.
	if pv.ValueKw == nil || *pv.ValueKw != 21.4 {
		t.Fatalf("pv role sum = %v, want 21.4 (0.2 + 21.2)", pv.ValueKw)
	}

	// DISPLAY-ONLY boundary: exactly the one v1 site sample in the uplink
	// buffer - the fill never becomes telemetry.
	if got := a.buf.Pending(); got != 1 {
		t.Fatalf("uplink buffer must stay at the one v1 sample, got %d", got)
	}
}

func TestTopologyKeepsTheCompositeOnTheHybridWithoutPinnedFills(t *testing.T) {
	a := newGateTestAgent(t)
	src := addErzeuger(t, a, 27)
	// Same registry shape, but NO pin anywhere (an old cloud omits the field).
	reg := pinnedRegistry("")
	a.applyEntityRegistry(reg)

	feedSource(a, src.ID, 21.2)
	feedPrimary(a, 0.2, 5.5, -15, 62)

	topo := a.Topology()
	pv := nodeByRole(topo, topology.RolePV)
	hybrid := memberByEntity(pv, "batt-1")
	// Pre-4a behavior, byte-for-byte: the hybrid carries the folded composite
	// and the producers stay empty - the role total is still right.
	if hybrid == nil || hybrid.ValueKw == nil || *hybrid.ValueKw != 21.4 {
		t.Fatalf("without pins the hybrid keeps the composite, got %+v", hybrid)
	}
	if m := memberByEntity(pv, "wr2"); m == nil || m.ValueKw != nil {
		t.Fatalf("unpinned producer must not fill, got %+v", m)
	}
}
