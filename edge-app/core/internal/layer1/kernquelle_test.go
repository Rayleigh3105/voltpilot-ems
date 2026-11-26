package layer1

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// Transports the CORE reads itself (inverter.IsCoreOwned: the Shelly relay
// executor and the Ebyte I/O module own their whole socket, source poll
// included) are read on Edge Light and Edge Industrie as on the Docker box -
// by the agent, not by Layer 1. ReadsAsSource must say so, or the core
// rejects them before it applies a portal plan.
//
// The field case (Anlage „Zuhause“, 26.11.2026, edge-light-2026.11.19): the
// heating rod over the three outputs of a Shelly Pro 3, exactly as the portal
// pushed it, was rejected with „unbekannte Kommunikation "shelly_http"“, the
// box reported no source set:0,1,2, the cloud's first binding found nothing to
// bind, and the Steuerart could not be activated („noch nicht verbunden“).

const zuhauseRodID = "c6966ca4-9af5-406d-8bd2-b15c9e3f6eb8"

// zuhauseRodDriver is the rod's driver as the portal sends it: the Shelly
// template plus the connection heizstab.ts builds (heizstabVerbindung).
const zuhauseRodDriver = `{"brand":"shelly","model":"shelly_http","family":"shelly_http","communication":"shelly_http",
  "connection":{"ip":"192.168.178.66","port":80,"channels":[0,1,2],"output_kw":[1.5,1.5,1.5],
  "stages":[1,2,3],"rotation":"daily","anschluss":"stern_mit_n"}}`

func corePush(ents ...entities.Entity) entities.Registry {
	return entities.Registry{Revision: "2026-11-26T07:33:22Z", ComponentAuthority: componentapply.AuthorityPortal,
		Entities: ents}
}

func coreEntity(id, typ, driver string) entities.Entity {
	return entities.Entity{ID: id, Type: typ, Driver: json.RawMessage(driver)}
}

func deriveOnEdgeLight(t *testing.T, reg entities.Registry) componentapply.Plan {
	t.Helper()
	plan, err := componentapply.DeriveWith(reg, inverter.DefaultCatalog(), nil, time.Now(),
		componentapply.Options{SourceReads: ReadsAsSource})
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	return plan
}

func TestEdgeLightAppliesTheHeatingRodOverAShellyOutputSet(t *testing.T) {
	// Created read-only, as the cloud does (no actuate until "Steuern
	// freigeben"): its role is still consumer.
	rod := coreEntity(zuhauseRodID, entities.TypeHeatingRod, zuhauseRodDriver)
	plan := deriveOnEdgeLight(t, corePush(rod))
	if len(plan.Rejected) != 0 {
		t.Fatalf("der Heizstab darf nicht abgelehnt werden: %+v", plan.Rejected)
	}
	if len(plan.Sources) != 1 {
		t.Fatalf("genau eine Quelle fuer den Stab: %+v", plan.Sources)
	}
	s := plan.Sources[0]
	if s.Role != sources.RoleConsumer || s.Communication != inverter.CommShellyHTTP ||
		s.Connection.IP != "192.168.178.66" || s.Connection.Port != 80 || plan.SourceEntities[s.ID] != zuhauseRodID {
		t.Fatalf("Quelle des Stabs: %+v", s)
	}
	// The identity the cloud's first binding matches (heizstab-shelly.md
	// „Erstbindung“): the output set, never a single output.
	if id := sources.TransportIdentity(s); !strings.HasSuffix(id, "\nset:0,1,2") {
		t.Fatalf("Identitaet %q endet nicht auf set:0,1,2", id)
	}
	raw, _ := json.Marshal(s.Connection)
	if !strings.Contains(string(raw), `"channels":[0,1,2]`) || strings.Contains(string(raw), "output_kw") {
		t.Fatalf("Verbindung der Quelle: %s", raw)
	}
	// The source list the core publishes for Layer 1 leaves it out: the agent
	// polls it, a second reader would break single-writer.
	plans, notes, entries, ok := parseSourcesConfig(sources.BusConfig(plan.Sources))
	if !ok || entries != 0 || len(plans) != 0 || len(notes) != 0 {
		t.Fatalf("edge/sources/config: ok=%v Eintraege=%d Plaene=%+v Hinweise=%+v", ok, entries, plans, notes)
	}
}

// A single Shelly output switching a load, and the Ebyte I/O module behind
// consumer channels: both transports the core reads itself, both applied.
func TestEdgeLightAppliesEveryConsumerTransportTheCoreReadsItself(t *testing.T) {
	const loadID, moduleID, pumpID = "d0000000-0000-0000-0000-000000000001",
		"d0000000-0000-0000-0000-000000000002", "d0000000-0000-0000-0000-000000000003"
	load := coreEntity(loadID, entities.TypeGenericLoad, `{"brand":"shelly","model":"shelly_http",
  "family":"shelly_http","communication":"shelly_http","connection":{"ip":"192.168.178.67","port":80,"channel":1}}`)
	load.Capabilities.Actuate = []entities.ActuateCap{{Command: entities.CmdOnOff}}
	module := coreEntity(moduleID, "io-module", `{"brand":"ebyte","model":"m31_axax8080g_u",
  "communication":"ebyte_modbus_tcp","connection":{"ip":"192.168.178.70","port":502,"unit_id":1,"mac":"00:54:2c:84:9b:90"}}`)
	module.Guards.Failsafe.Behavior = "measure-only"
	pump := coreEntity(pumpID, entities.TypeGenericLoad,
		`{"communication":"ebyte_modbus_tcp","io_entity_id":"`+moduleID+`","channel":4}`)
	pump.Capabilities.Actuate = []entities.ActuateCap{{Command: entities.CmdOnOff}}

	plan := deriveOnEdgeLight(t, corePush(load, module, pump))
	if len(plan.Rejected) != 0 {
		t.Fatalf("nichts darf abgelehnt werden: %+v", plan.Rejected)
	}
	byEntity := map[string]sources.Source{}
	for _, s := range plan.Sources {
		byEntity[plan.SourceEntities[s.ID]] = s
	}
	if len(plan.Sources) != 2 {
		t.Fatalf("Ausgang und Modul, der Kanal ist keine eigene Quelle: %+v", plan.Sources)
	}
	if s := byEntity[loadID]; s.Role != sources.RoleConsumer || s.Communication != inverter.CommShellyHTTP ||
		!strings.HasSuffix(sources.TransportIdentity(s), "\n1") {
		t.Fatalf("einzelner Shelly-Ausgang: %+v", s)
	}
	if s := byEntity[moduleID]; s.Role != sources.RoleConsumer || s.Communication != inverter.CommEbyteModbusTCP ||
		s.Connection.UnitID != 1 {
		t.Fatalf("Ebyte-Modul: %+v", s)
	}
}

// The fix does not widen the reader: a transport neither Layer 1 nor the core
// reads as a source stays rejected with its reason, and a switch output is
// read as a consumer only - it publishes a switch state and a load, never a
// PV or grid value.
func TestEdgeLightStillRejectsWhatNobodyReadsAsASource(t *testing.T) {
	const plenticore = "d0000000-0000-0000-0000-000000000004"
	plan, err := componentapply.DeriveWith(corePush(
		coreEntity(zuhauseRodID, entities.TypeHeatingRod, zuhauseRodDriver),
		coreEntity(plenticore, entities.TypeProducer, `{"brand":"kostal","model":"plenticore-bi-10-26",
  "communication":"kostal_modbus","connection":{"ip":"192.168.178.80","port":1502,"unit_id":71}}`),
	), inverter.DefaultCatalog(), nil, time.Now(), componentapply.Options{SourceReads: ReadsAsSource})
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Rejected) != 1 || plan.Rejected[0].EntityID != plenticore ||
		plan.Rejected[0].Reason != `unbekannte Kommunikation "kostal_modbus"` {
		t.Fatalf("die PLENTICORE als Erzeuger bleibt abgelehnt: %+v", plan.Rejected)
	}
	if len(plan.Sources) != 1 || plan.SourceEntities[plan.Sources[0].ID] != zuhauseRodID {
		t.Fatalf("der Stab laeuft daneben: %+v", plan.Sources)
	}

	if why := ReadsAsSource("zauberei", sources.RoleConsumer); why != `unbekannte Kommunikation "zauberei"` {
		t.Fatalf("unbekannte Kommunikation: %q", why)
	}
	for _, comm := range []string{inverter.CommShellyHTTP, inverter.CommEbyteModbusTCP} {
		if why := ReadsAsSource(comm, sources.RoleConsumer); why != "" {
			t.Fatalf("%s als Verbraucher: %q", comm, why)
		}
		for _, role := range []string{sources.RoleErzeuger, sources.RoleNetz} {
			if why := ReadsAsSource(comm, role); !strings.Contains(why, "als Verbraucher anlegen") {
				t.Fatalf("%s als %s: %q", comm, role, why)
			}
		}
	}
}
