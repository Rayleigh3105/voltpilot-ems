package agent

// Der EINE Applier, an der Verdrahtung geprueft (Einheitsmodell Stufe 1). Die
// REGELN liegen in internal/componentapply und sind dort ohne Agent bewiesen;
// hier geht es um genau die Fragen, die nur der Agent beantworten kann:
//
//   - Aendert sich fuer eine BESTANDSANLAGE wirklich nichts? (die
//     Betriebs-Auflage dieses PRs - ein laufender Kunde darf durch diesen
//     Merge kein anderes Verhalten bekommen)
//   - Landet ein angewandter Plan wirklich in beiden Speichern UND auf beiden
//     retained Topics - und nur dann?
//   - Bleibt bei einer Verweigerung der vorherige Zustand VOLLSTAENDIG stehen?
//   - Ueberlebt „portal-verwaltet" einen Neustart?

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

const applyDeyeDriver = `{"brand":"deye","model":"sun-30k-sg01hp3","family":"hybrid_3p",
  "communication":"solarman_v5",
  "connection":{"ip":"192.168.0.28","port":8899,"serial":"2985159064","mb_slave_id":1}}`

const applyFroniusDriver = `{"role":"pv-generation","brand":"fronius_sunspec",
  "model":"fronius-eco-27-3-s","communication":"fronius_sunspec","capacity_kwp":27,
  "connection":{"ip":"192.168.210.40","port":502,"unit_id":1}}`

func applyEntity(id, typ, driver string) entities.Entity {
	e := entities.Entity{ID: id, Type: typ}
	if driver != "" {
		e.Driver = json.RawMessage(driver)
	}
	return e
}

func portalPush(rev string, ents ...entities.Entity) entities.Registry {
	return entities.Registry{
		Revision:           rev,
		ComponentAuthority: componentapply.AuthorityPortal,
		Entities:           ents,
	}
}

// localState is everything a push could possibly change locally.
type localState struct {
	inverterSet bool
	inverterIP  string
	sourceIDs   []string
	authority   string
	applied     string
}

func snapshotLocal(a *Agent) localState {
	st := localState{}
	if sel, ok := a.GetInverter(); ok {
		st.inverterSet = true
		st.inverterIP = sel.Connection.IP
	}
	a.srcMu.Lock()
	for _, s := range a.srcs {
		st.sourceIDs = append(st.sourceIDs, s.ID)
	}
	a.srcMu.Unlock()
	rec := a.componentRecord()
	st.authority, st.applied = rec.Authority, rec.Revision
	return st
}

// --- Die Betriebs-Auflage: eine Bestandsanlage bleibt unberuehrt ------------

func TestABoxManagedPlantIsByteIdenticalUnderEveryPush(t *testing.T) {
	a := newGateTestAgent(t)
	// Eine eingerichtete Bestandsanlage, so wie sie heute auf :8484 entsteht.
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: "deye", Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "10.0.0.5", Port: 8899, Serial: "111", MbSlaveID: 1},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.AddSource(sources.Request{
		Role: sources.RoleErzeuger, Brand: inverter.BrandGenericModbus, Model: inverter.FamSunSpec,
		Connection: inverter.Connection{IP: "10.0.0.9", UnitID: 2},
	}); err != nil {
		t.Fatal(err)
	}
	before := snapshotLocal(a)

	// EIN Push OHNE Autoritaets-Feld - genau das, was ein aelterer Cloud-Stand
	// sendet, und was jede heute laufende Anlage bekommt.
	a.applyEntityRegistry(entities.Registry{
		Revision: "r1",
		Entities: []entities.Entity{
			applyEntity("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid,
				applyDeyeDriver),
			applyEntity("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer,
				applyFroniusDriver),
		},
	})

	after := snapshotLocal(a)
	if after.inverterIP != before.inverterIP || len(after.sourceIDs) != len(before.sourceIDs) {
		t.Fatalf("eine box-verwaltete Anlage wurde veraendert: %+v -> %+v", before, after)
	}
	if a.PortalManagedComponents() {
		t.Fatal("ohne ausdrueckliches portal darf die Anlage nie portal-verwaltet werden")
	}
	// Und der Herzschlag behauptet nichts ueber einen Applier, den es hier
	// nicht gibt.
	if a.componentApplySummary() != nil {
		t.Fatal("eine box-verwaltete Anlage sendet keinen component_apply-Block")
	}
	// Lokal bearbeiten geht weiter - unveraendert.
	if err := a.refuseIfPortalManaged(); err != nil {
		t.Fatalf("lokale Bearbeitung muss erlaubt bleiben: %v", err)
	}
}

// --- Der Anwende-Pfad ------------------------------------------------------

func TestAPortalManagedPushBecomesTheLocalConfiguration(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(portalPush("r1",
		applyEntity("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid,
			applyDeyeDriver),
		applyEntity("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer,
			applyFroniusDriver),
	))

	sel, ok := a.GetInverter()
	if !ok || sel.Connection.IP != "192.168.0.28" || sel.Family != "hybrid_3p" {
		t.Fatalf("Wechselrichter nicht angewandt: %+v ok=%v", sel, ok)
	}
	a.srcMu.Lock()
	n := len(a.srcs)
	a.srcMu.Unlock()
	if n != 1 {
		t.Fatalf("Quellen = %d, will 1", n)
	}
	// Beide Speicher tragen den Zustand - ein Neustart faende ihn wieder.
	if stored, ok, err := a.invStore.Load(); err != nil || !ok ||
		stored.Connection.Serial != "2985159064" {
		t.Fatalf("inverter.json: %+v ok=%v err=%v", stored, ok, err)
	}
	if list, ok, err := a.srcStore.Load(); err != nil || !ok || len(list) != 1 {
		t.Fatalf("sources.json: %v ok=%v err=%v", list, ok, err)
	}
	rec := a.componentRecord()
	if rec.Authority != componentapply.AuthorityPortal || rec.Revision != "r1" {
		t.Fatalf("Anwende-Stand: %+v", rec)
	}
	sum := a.componentApplySummary()
	if sum == nil || sum.Revision != "r1" || sum.RefusedRevision != "" {
		t.Fatalf("Herzschlag-Block: %+v", sum)
	}
}

func TestAnUnchangedPushWritesNothing(t *testing.T) {
	a := newGateTestAgent(t)
	push := portalPush("r1", applyEntity("5f0d2c9e-0000-0000-0000-000000000001",
		entities.TypeBatteryHybrid, applyDeyeDriver))
	a.applyEntityRegistry(push)

	before, _, _ := a.invStore.Load()
	// Dieselbe Konfiguration unter einer neuen Revision (der retained
	// Wiederzustellungs-Fall). Sie muss als „keine Aenderung" enden.
	a.applyEntityRegistry(portalPush("r2", push.Entities...))

	after, _, _ := a.invStore.Load()
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatal("eine unveraenderte Konfiguration darf keinen Speicher-Schreibvorgang ausloesen")
	}
	if got := a.componentRecord().Revision; got != "r2" {
		t.Fatalf("die Revision muss trotzdem quittiert werden: %q", got)
	}
}

// --- Nie teilweise, nie leerraeumend ---------------------------------------

func TestARefusedPushLeavesTheRunningConfigurationCOMPLETELYAlone(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(portalPush("r1",
		applyEntity("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid,
			applyDeyeDriver),
		applyEntity("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer,
			applyFroniusDriver),
	))
	before := snapshotLocal(a)

	// Ein Push, dessen ZWEITES Geraet nicht uebersetzbar ist. Das erste ist
	// vollkommen gueltig - genau deshalb ist der Fall interessant.
	a.applyEntityRegistry(portalPush("r2",
		applyEntity("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid,
			strings.Replace(applyDeyeDriver, "192.168.0.28", "192.168.0.77", 1)),
		applyEntity("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer,
			`{"role":"pv-generation","brand":"gibt-es-nicht","connection":{"ip":"192.168.0.9"}}`),
	))

	after := snapshotLocal(a)
	if after.inverterIP != before.inverterIP {
		t.Fatalf("der Wechselrichter wurde halb angewandt: %q -> %q",
			before.inverterIP, after.inverterIP)
	}
	if len(after.sourceIDs) != len(before.sourceIDs) {
		t.Fatalf("die Geraeteliste wurde veraendert: %v -> %v", before.sourceIDs, after.sourceIDs)
	}
	rec := a.componentRecord()
	if rec.Revision != "r1" {
		t.Fatalf("es laeuft weiter r1, nicht %q", rec.Revision)
	}
	if rec.Refused != "r2" || rec.RefusedReason == "" {
		t.Fatalf("die Ablehnung muss mit Grund sichtbar sein: %+v", rec)
	}
	sum := a.componentApplySummary()
	if sum == nil || sum.Revision != "r1" || sum.RefusedRevision != "r2" {
		t.Fatalf("der Herzschlag muss BEIDES tragen: %+v", sum)
	}
}

func TestAPortalManagedPushWithoutDevicesClearsNothing(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(portalPush("r1", applyEntity("5f0d2c9e-0000-0000-0000-000000000001",
		entities.TypeBatteryHybrid, applyDeyeDriver)))
	before := snapshotLocal(a)

	// Der Onboarding-Normalfall: die Anlage ist portal-verwaltet, aber im
	// Portal steht (noch) kein Geraet. Das ist KEINE Anweisung zu loeschen.
	a.applyEntityRegistry(portalPush("r2",
		applyEntity("cccc0000-0000-0000-0000-000000000003", entities.TypeGridMeter, "")))

	after := snapshotLocal(a)
	if after.inverterIP != before.inverterIP || len(after.sourceIDs) != len(before.sourceIDs) {
		t.Fatalf("ein leeres Soll hat etwas geloescht: %+v -> %+v", before, after)
	}
	if rec := a.componentRecord(); rec.Revision != "r1" || rec.Refused != "" {
		t.Fatalf("weder angewandt noch abgelehnt: %+v", rec)
	}
}

// --- Autoritaet: Uebernahme, Rueckgabe, Neustart ---------------------------

func TestLocalEditsAreRefusedOnlyOnceThePortalHasReallyTakenOver(t *testing.T) {
	a := newGateTestAgent(t)
	// Der Marker ALLEIN ist keine Uebernahme: solange nichts angewandt wurde,
	// muss die Box lokal bedienbar bleiben (sonst waere eine frische, im
	// Portal noch leere Anlage nirgends einrichtbar).
	a.applyEntityRegistry(portalPush("r1",
		applyEntity("cccc0000-0000-0000-0000-000000000003", entities.TypeGridMeter, "")))
	if err := a.refuseIfPortalManaged(); err != nil {
		t.Fatalf("ohne angewandtes Soll muss lokal noch gehen: %v", err)
	}

	a.applyEntityRegistry(portalPush("r2", applyEntity("5f0d2c9e-0000-0000-0000-000000000001",
		entities.TypeBatteryHybrid, applyDeyeDriver)))

	for name, err := range map[string]error{
		"SetInverter": func() error {
			_, e := a.SetInverter(inverter.SelectionRequest{Brand: "deye",
				Model: "sun-30k-sg01hp3",
				Connection: inverter.Connection{IP: "10.0.0.1", Port: 8899, Serial: "9",
					MbSlaveID: 1}})
			return e
		}(),
		"AddSource": func() error {
			_, e := a.AddSource(sources.Request{Role: sources.RoleErzeuger,
				Brand: inverter.BrandGenericModbus, Model: inverter.FamSunSpec,
				Connection: inverter.Connection{IP: "10.0.0.2", UnitID: 1}})
			return e
		}(),
		"DeleteSource": a.DeleteSource("src-egal"),
		"RenameSource": func() error { _, e := a.RenameSource("src-egal", "neu"); return e }(),
	} {
		if err == nil {
			t.Fatalf("%s: eine portal-verwaltete Anlage darf lokal nicht bearbeitet werden", name)
		}
		// Der Satz nennt den ORT, nicht nur die Ablehnung.
		if !strings.Contains(err.Error(), "VoltPilot-Portal") {
			t.Fatalf("%s: Grund = %q", name, err.Error())
		}
	}
	// Die Wechselrichter-Auswahl steht danach unveraendert.
	if sel, _ := a.GetInverter(); sel.Connection.IP != "192.168.0.28" {
		t.Fatalf("die abgelehnte Bearbeitung hat doch etwas geaendert: %q", sel.Connection.IP)
	}
}

func TestHandingAuthorityBackNeverUndoesWhatRuns(t *testing.T) {
	a := newGateTestAgent(t)
	a.applyEntityRegistry(portalPush("r1", applyEntity("5f0d2c9e-0000-0000-0000-000000000001",
		entities.TypeBatteryHybrid, applyDeyeDriver)))
	before := snapshotLocal(a)

	// Die Cloud gibt die Autoritaet zurueck (Feld fehlt = box).
	a.applyEntityRegistry(entities.Registry{Revision: "r2",
		Entities: before2Entities()})

	after := snapshotLocal(a)
	if after.inverterIP != before.inverterIP {
		t.Fatal("die Rueckgabe der Autoritaet darf die Konfiguration nicht anfassen")
	}
	if a.PortalManagedComponents() {
		t.Fatal("nach der Rueckgabe ist die Anlage wieder box-verwaltet")
	}
	if err := a.refuseIfPortalManaged(); err != nil {
		t.Fatalf("und lokal wieder bedienbar: %v", err)
	}
}

func before2Entities() []entities.Entity {
	return []entities.Entity{applyEntity("5f0d2c9e-0000-0000-0000-000000000001",
		entities.TypeBatteryHybrid, applyDeyeDriver)}
}

func TestPortalManagedSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Defaults()
	cfg.DataDir = dir

	first, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	first.applyEntityRegistry(portalPush("r1", applyEntity(
		"5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, applyDeyeDriver)))
	first.Stop()

	// Neustart auf demselben Datenverzeichnis - noch BEVOR ein Push der neuen
	// Sitzung ankommt. Genau dann muss die Box wissen, dass sie nicht mehr
	// lokal bearbeitet wird (Offline-Fall).
	second, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Stop()
	if !second.PortalManagedComponents() {
		t.Fatal("der Autoritaets-Zustand muss den Neustart ueberleben")
	}
	if second.componentRecord().Revision != "r1" {
		t.Fatalf("Revision nach Neustart: %+v", second.componentRecord())
	}
	if sel, ok := second.GetInverter(); !ok || sel.Connection.IP != "192.168.0.28" {
		t.Fatalf("die angewandte Konfiguration muss den Neustart ueberleben: %+v", sel)
	}
}

func TestAppliedAtIsStampedNotInvented(t *testing.T) {
	a := newGateTestAgent(t)
	before := time.Now().Add(-time.Second)
	a.applyEntityRegistry(portalPush("r1", applyEntity(
		"5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, applyDeyeDriver)))
	rec := a.componentRecord()
	if rec.AppliedAt.Before(before) {
		t.Fatalf("applied_at = %v", rec.AppliedAt)
	}
	if sum := a.componentApplySummary(); sum == nil || sum.AppliedAt == "" {
		t.Fatalf("der Herzschlag traegt den Zeitpunkt: %+v", sum)
	}
}
