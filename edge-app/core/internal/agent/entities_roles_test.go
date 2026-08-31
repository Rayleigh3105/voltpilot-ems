package agent

// Befund L4: die im Portal gespeicherte Rollen-Zuordnung erreicht die Box und
// gewinnt dort gegen topology.DefaultRole. Bis dahin schrieb
// PUT …/topology-roles nur die Cloud-Tabelle und der Registry-Push trug sie
// nicht - :8484 zeigte einen Energiefluss, der dem des Portals widersprechen
// konnte.
//
// Die Reise wird durch die ECHTEN Push-Bytes gefahren (die eingecheckte
// Kontrakt-Fixture, PER PFAD gelesen), damit Vertrag, Parser und Anzeige
// gemeinsam bewiesen sind statt jeder für sich.

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/topology"
)

func pushFixture(t *testing.T, name string) entities.Registry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"examples", name))
	if err != nil {
		t.Fatalf("Kontrakt-Fixture fehlt: %v", err)
	}
	reg, skipped, err := entities.ParseRegistryPush(raw, entities.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	})
	if err != nil {
		t.Fatalf("Fixture abgelehnt: %v", err)
	}
	if len(skipped) != 0 {
		t.Fatalf("Fixture-Einträge übersprungen: %v", skipped)
	}
	return reg
}

// TestPushedRolesReachTheLocalTopology fährt die ganze Strecke: Push-Bytes ->
// Registry -> Topology(). Der umgewidmete Messpunkt landet im PV-Knoten (nicht
// im Haus), und der zweite Zähler ist der maßgebliche.
func TestPushedRolesReachTheLocalTopology(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(pushFixture(t, "edge-entity.valid.registry-push-roles.json"))

	topo := a.Topology()
	pv := nodeByRole(topo, topology.RolePV)
	if pv == nil {
		t.Fatalf("kein PV-Knoten - der umgewidmete Messpunkt ist beim Default geblieben: %+v", topo)
	}
	if len(pv.Members) != 1 || pv.Members[0].Label != "Umgewidmeter Messpunkt" {
		t.Fatalf("PV-Mitglieder = %+v, want den umgewidmeten Messpunkt", pv.Members)
	}
	if haus := nodeByRole(topo, topology.RoleConsumer); haus != nil {
		t.Errorf("die umgewidmete Zeile hängt weiter am Haus-Knoten: %+v", haus)
	}

	grid := nodeByRole(topo, topology.RoleGrid)
	if grid == nil || len(grid.Members) != 2 {
		t.Fatalf("Netz-Knoten = %+v, want beide Zähler", grid)
	}
	if grid.Members[0].Primary {
		t.Error("der ERSTE Zähler ist maßgeblich geblieben, obwohl der Betreiber den zweiten gewählt hat")
	}
	if !grid.Members[1].Primary {
		t.Error("der vom Betreiber gewählte Zähler ist nicht maßgeblich")
	}
}

// TestPushedRolesDecideWhichMeterCountsForTheGridNode ist die WIRKUNG der
// maßgeblich-Wahl: der Netz-Knoten nimmt den SIGNIERTEN Wert des maßgeblichen
// Mitglieds, nie eine Summe. Ohne die gepushte Zuordnung zeigte die Box den
// Wert des ERSTEN Zählers - eine andere Zahl als das Portal.
func TestPushedRolesDecideWhichMeterCountsForTheGridNode(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(pushFixture(t, "edge-entity.valid.registry-push-roles.json"))
	// Beide Zähler melden, mit verschiedenen Werten.
	report := func(id string, kw float64) {
		t.Helper()
		a.onEntityTelemetry("edge/entities/"+id+"/telemetry",
			[]byte(fmt.Sprintf(`{"schema_version":"1.0","entity_id":%q,"channels":{"power_kw":%v}}`,
				id, kw)))
	}
	report("7b2f4e10-8d3c-4e5f-b0a1-2c3d4e5f6071", 1.0)
	report("8c3f5f21-9e4d-4f60-c1b2-3d4e5f607182", 7.5)

	grid := nodeByRole(a.Topology(), topology.RoleGrid)
	if grid == nil || grid.ValueKw == nil {
		t.Fatalf("Netz-Knoten ohne Wert: %+v", grid)
	}
	if *grid.ValueKw != 7.5 {
		t.Fatalf("Netz-Knoten = %.3f kW, want 7.5 (den maßgeblichen Zähler, nicht den ersten)",
			*grid.ValueKw)
	}
}

// TestAnUnknownPushedRoleFallsBackToTheDefault: eine neuere Cloud darf eine
// Rolle nennen, die dieser Box-Build nicht kennt. Sie verliert dann die
// Zuordnung, nie ihren Energiefluss - der Push wird deswegen NIE abgelehnt.
func TestAnUnknownPushedRoleFallsBackToTheDefault(t *testing.T) {
	a := newGateTestAgent(t)
	reg := migratedRegistry()
	for i := range reg.Entities {
		if reg.Entities[i].ID == "grid-1" {
			reg.Entities[i].RoleAssignment = []entities.RoleAssignment{
				{Channel: "power_kw", Role: "waermepumpe-2027", Primary: true},
			}
		}
	}
	a.applyEntityRegistry(reg)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"soc_pct": 87, "pv_power_kw": 5.85, "load_kw": 0.7, "power_kw": -5.15}`))

	topo := a.Topology()
	grid := nodeByRole(topo, topology.RoleGrid)
	if grid == nil || grid.ValueKw == nil || *grid.ValueKw != 5.15 {
		t.Fatalf("Netz-Knoten = %+v, want den Default-Knoten mit 5.15 kW", grid)
	}
	for _, n := range topo.Nodes {
		if !topology.IsKnownRole(n.Role) {
			t.Fatalf("ein unbekanntes Rollenwort hat einen Knoten erzeugt: %+v", n)
		}
	}
}

// TestNoRoleAssignmentIsByteIdentical: eine Anlage ohne eine einzige
// gespeicherte Zuordnung - also jede Bestandsanlage und jede ältere Cloud -
// zeichnet exakt dieselbe Topologie wie vor dieser Runde.
func TestNoRoleAssignmentIsByteIdentical(t *testing.T) {
	build := func() topology.Topology {
		a := newGateTestAgent(t)
		a.applyEntityRegistry(migratedRegistry())
		a.onLocalTelemetry(localbus.TopicTelemetry,
			[]byte(`{"soc_pct": 87, "pv_power_kw": 5.85, "load_kw": 0.7, "power_kw": -5.15}`))
		return a.Topology()
	}
	want := build()
	// Dieselbe Anlage, diesmal mit einem AUSDRÜCKLICH leeren Block je Entität.
	a := newGateTestAgent(t)
	reg := migratedRegistry()
	for i := range reg.Entities {
		reg.Entities[i].RoleAssignment = []entities.RoleAssignment{}
	}
	a.applyEntityRegistry(reg)
	a.onLocalTelemetry(localbus.TopicTelemetry,
		[]byte(`{"soc_pct": 87, "pv_power_kw": 5.85, "load_kw": 0.7, "power_kw": -5.15}`))
	got := a.Topology()

	if len(got.Nodes) != len(want.Nodes) {
		t.Fatalf("Knotenzahl %d != %d", len(got.Nodes), len(want.Nodes))
	}
	for i := range want.Nodes {
		if got.Nodes[i].Role != want.Nodes[i].Role ||
			(got.Nodes[i].ValueKw == nil) != (want.Nodes[i].ValueKw == nil) {
			t.Fatalf("Knoten %d abgewichen: %+v vs %+v", i, got.Nodes[i], want.Nodes[i])
		}
		if got.Nodes[i].ValueKw != nil && *got.Nodes[i].ValueKw != *want.Nodes[i].ValueKw {
			t.Fatalf("Knoten %s = %.3f, want %.3f", got.Nodes[i].Role,
				*got.Nodes[i].ValueKw, *want.Nodes[i].ValueKw)
		}
	}
}
