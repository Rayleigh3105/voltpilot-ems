package componentapply

// Die Quelle einer Anlagensteuerung (UEMS EZ-21): aus dem Treiber, den die
// Cloud einer Box mit `anlagensteuerung_quelle` schickt, entsteht eine Quelle
// der Rolle plant-controller - ohne Marke, ohne Wechselrichter-Katalog -, deren
// Kennung der Pin der Komponente ist. Die Faelle stehen in
// docs/contracts/v2/anlagensteuerung-quelle-vectors.json; Java und JS lesen sie
// ebenso.

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

type plantControllerVectors struct {
	Faehigkeit    string `json:"faehigkeit"`
	Rolle         string `json:"rolle"`
	Kommunikation string `json:"kommunikation"`
	Familie       string `json:"familie"`
	LesetaktS     int    `json:"lesetakt_s"`
	Faelle        []struct {
		Name         string          `json:"name"`
		Label        string          `json:"label"`
		EdgeSourceID string          `json:"edge_source_id"`
		Driver       json.RawMessage `json:"driver"`
		BusEintrag   json.RawMessage `json:"bus_eintrag"`
	} `json:"faelle"`
}

func loadPlantControllerVectors(t *testing.T) plantControllerVectors {
	t.Helper()
	raw, err := os.ReadFile("../../../../docs/contracts/v2/anlagensteuerung-quelle-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v plantControllerVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Faelle) == 0 {
		t.Fatal("keine Faelle")
	}
	return v
}

func steuerung(id, label, edgeSourceID string, driver json.RawMessage) entities.Entity {
	return entities.Entity{ID: id, Type: entities.TypeAnlagensteuerung, Label: label,
		EdgeSourceID: edgeSourceID, Driver: driver}
}

func jsonEqual(t *testing.T, got, want []byte) bool {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(g, w)
}

func TestPlantControllerVocabularyMatchesTheContract(t *testing.T) {
	v := loadPlantControllerVectors(t)
	if v.Rolle != sources.RolePlantController || v.Kommunikation != inverter.CommModbusTCP ||
		v.Familie != sources.FamilyErzeugerRegisterbild || v.LesetaktS != plantControllerIntervalS {
		t.Fatalf("Vokabular weicht vom Vertrag ab: %+v", v)
	}
}

// Je Fall: der Treiber ergibt genau EINE Quelle, deren Kennung der Pin ist und
// deren retained edge/sources/config-Eintrag genau der des Vertrags ist - den
// liest die Palette, um die Steuerung zu erreichen.
func TestPlantControllerDriverDerivesTheSourceThePinNames(t *testing.T) {
	v := loadPlantControllerVectors(t)
	for _, f := range v.Faelle {
		t.Run(f.Name, func(t *testing.T) {
			plan, err := Derive(portal(steuerung("00000000-0000-0000-0000-0000000e2001", f.Label,
				f.EdgeSourceID, f.Driver)), cat(), nil, now)
			if err != nil {
				t.Fatalf("Derive: %v", err)
			}
			if plan.Inverter != nil || len(plan.Sources) != 1 {
				t.Fatalf("eine Steuerung ist genau eine Quelle, kein Wechselrichter: %+v", plan)
			}
			src := plan.Sources[0]
			if src.ID != f.EdgeSourceID || sources.DeterministicID(src) != f.EdgeSourceID {
				t.Fatalf("Kennung %q (deterministisch %q), Pin %q", src.ID, sources.DeterministicID(src),
					f.EdgeSourceID)
			}
			var bus struct {
				Sources []json.RawMessage `json:"sources"`
			}
			if err := json.Unmarshal(sources.BusConfig(plan.Sources), &bus); err != nil || len(bus.Sources) != 1 {
				t.Fatalf("edge/sources/config: %v %s", err, sources.BusConfig(plan.Sources))
			}
			if !jsonEqual(t, bus.Sources[0], f.BusEintrag) {
				t.Fatalf("Eintrag in edge/sources/config\n got %s\nwant %s", bus.Sources[0], f.BusEintrag)
			}
		})
	}
}

// Der Push, wie ihn die Cloud fuer Gore schickt (Steuerung mit Treiber und Pin,
// daneben Netz und Haus, die die Cloud ueber die Box zusammensetzt - ohne
// Anbindung, EZ-20), laeuft NICHT mehr in den Halt
// „kein verbundenes Geraet“ - und das ohne den Katalog: ein leerer Katalog
// beweist, dass keine Marke und kein Modell nachgeschlagen werden.
func TestTheGorePushIsNoLongerHeldAndNeedsNoCatalog(t *testing.T) {
	v := loadPlantControllerVectors(t)
	gore := v.Faelle[0]
	push := `{"schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
	  "revision":"2026-10-23T08:00:00Z","published_at":"2026-10-23T08:00:00Z",
	  "component_authority":"portal","entities":[
	   {"entity_id":"00000000-0000-0000-0000-0000000e2010","entity_type":"grid-meter","label":"Netz",
	    "capabilities":{},"guards":{}},
	   {"entity_id":"00000000-0000-0000-0000-0000000e2011","entity_type":"house-load","label":"Haus",
	    "capabilities":{},"guards":{}},
	   {"entity_id":"00000000-0000-0000-0000-0000000e2001","entity_type":"anlagensteuerung",
	    "label":"Anlagensteuerung","edge_source_id":"` + gore.EdgeSourceID + `",
	    "capabilities":{},"guards":{},"driver":` + string(gore.Driver) + `}]}`
	reg, skipped, err := entities.ParseRegistryPush([]byte(push), entities.Identity{
		TenantID: "t1", SiteID: "s1", DeviceID: "d1"})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("Push: %v %v", err, skipped)
	}
	plan, err := Derive(reg, inverter.Catalog{}, nil, now)
	if errors.Is(err, ErrNoConfiguration) {
		t.Fatal("die Steuerung ist ein verbundenes Geraet - kein Halt")
	}
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Sources) != 1 || plan.Sources[0].ID != gore.EdgeSourceID ||
		plan.Sources[0].Role != sources.RolePlantController || plan.Sources[0].Brand != "" ||
		plan.Sources[0].DataSourceID != "DQ-1" || plan.Sources[0].Label != "Anlagensteuerung" {
		t.Fatalf("Quelle: %+v", plan.Sources)
	}
	// Die Palette erreicht die Steuerung ueber den Pin der Komponente: der
	// retained edge/entities/{id}/config traegt ihn unveraendert.
	var cfg struct {
		EdgeSourceID string `json:"edge_source_id"`
		Driver       struct {
			DataSourceID string `json:"data_source_id"`
		} `json:"driver"`
	}
	for _, e := range reg.Entities {
		if e.Type == entities.TypeAnlagensteuerung {
			if err := json.Unmarshal(e.ConfigPayload(reg.Revision), &cfg); err != nil {
				t.Fatal(err)
			}
		}
	}
	if cfg.EdgeSourceID != gore.EdgeSourceID || cfg.Driver.DataSourceID != "DQ-1" {
		t.Fatalf("edge/entities/…/config: %+v", cfg)
	}

	// Der zweite Push mit demselben Inhalt ist keine Aenderung: die laufende
	// Quelle behaelt ihre Kennung, kein Schreiben, kein neues retained Topic.
	again, err := Derive(reg, inverter.Catalog{}, plan.Sources, now.Add(60e9))
	if err != nil {
		t.Fatal(err)
	}
	if !again.SameAs(nil, plan.Sources) {
		t.Fatalf("zweiter Push ist eine Aenderung: %+v vs %+v", again.Sources, plan.Sources)
	}
}

// Heute (ohne Treiber, nur mit dem Kennzeichen der Datenquelle) bleibt eine
// Steuerung, was sie war: kein Lesepfad, also der ehrliche Halt.
func TestAControllerWithoutConnectionStaysOutOfTheReadPath(t *testing.T) {
	_, err := Derive(portal(steuerung("00000000-0000-0000-0000-0000000e2001", "Anlagensteuerung", "",
		json.RawMessage(`{"data_source_id":"DQ-1"}`))), cat(), nil, now)
	if !errors.Is(err, ErrNoConfiguration) {
		t.Fatalf("ohne connection kein Geraet: %v", err)
	}
}

// Was eine Steuerung NICHT sein darf, lehnt die Box namentlich ab - nie wird
// eine SPS still zum Wechselrichter, zur PV-Quelle oder zu einer geratenen
// Adresse.
func TestAPlantControllerDriverIsRefusedByNameWhenItIsNotAModbusController(t *testing.T) {
	for name, tc := range map[string]struct{ driver, want string }{
		"andere_rolle": {`{"role":"pv-generation","communication":"modbus_tcp",
		  "connection":{"ip":"10.0.0.5","port":502,"unit_id":1}}`, "nennt die Rolle"},
		"anderer_transport": {`{"communication":"solarman_v5",
		  "connection":{"ip":"10.0.0.5","port":8899,"serial":"1"}}`, "nur über Modbus TCP"},
		"ohne_adresse": {`{"communication":"modbus_tcp",
		  "connection":{"ip":" ","port":502,"unit_id":1}}`, "Adresse der Steuerung fehlt"},
		"ohne_port": {`{"communication":"modbus_tcp",
		  "connection":{"ip":"10.0.0.5","unit_id":1}}`, "Port 0"},
		"geraete_id_zu_gross": {`{"communication":"modbus_tcp",
		  "connection":{"ip":"10.0.0.5","port":502,"unit_id":256}}`, "Geräte-ID 256"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Derive(portal(steuerung("00000000-0000-0000-0000-0000000e2001", "", "",
				json.RawMessage(tc.driver))), cat(), nil, now)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Fehler %v, erwartet %q", err, tc.want)
			}
		})
	}
}

// Zwei Steuerungen an derselben Datenquelle (Geraete-ID 1 und 2) sind zwei
// Quellen; dieselbe Steuerung zweimal ist ein mehrdeutiges Soll.
func TestTwoControllersBehindOneGatewayAreTwoSources(t *testing.T) {
	v := loadPlantControllerVectors(t)
	a, b := v.Faelle[0], v.Faelle[1]
	plan, err := Derive(portal(
		steuerung("00000000-0000-0000-0000-0000000e2001", a.Label, a.EdgeSourceID, a.Driver),
		steuerung("00000000-0000-0000-0000-0000000e2002", b.Label, b.EdgeSourceID, b.Driver),
	), cat(), nil, now)
	if err != nil || len(plan.Sources) != 2 {
		t.Fatalf("zwei Steuerungen: %v %+v", err, plan.Sources)
	}
	if _, err := Derive(portal(
		steuerung("00000000-0000-0000-0000-0000000e2001", a.Label, a.EdgeSourceID, a.Driver),
		steuerung("00000000-0000-0000-0000-0000000e2002", a.Label, a.EdgeSourceID, a.Driver),
	), cat(), nil, now); err == nil || !strings.Contains(err.Error(), "dieselbe Verbindung") {
		t.Fatalf("dieselbe Steuerung zweimal: %v", err)
	}
}

// Die Rueckwaertskompatibilitaet, die das Faehigkeitswort noetig macht: fuer
// jeden ANDEREN Typ bleibt ein Treiber mit Verbindung und ohne Marke eine
// Ablehnung - genau so sieht ein Box-Stand vor EZ-21 auch den Treiber einer
// Steuerung, und der ganze Push wuerde verweigert.
func TestABrandlessDriverOfAnyOtherTypeIsStillRefused(t *testing.T) {
	v := loadPlantControllerVectors(t)
	_, err := Derive(portal(ent("00000000-0000-0000-0000-0000000e2001", entities.TypeProducer,
		string(v.Faelle[0].Driver))), cat(), nil, now)
	if err == nil || !strings.Contains(err.Error(), "nennt keine Marke") {
		t.Fatalf("ohne Marke: %v", err)
	}
}
