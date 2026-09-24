package componentapply

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

var now = time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)

func cat() inverter.Catalog { return inverter.DefaultCatalog() }

func ent(id, typ string, driver string) entities.Entity {
	e := entities.Entity{ID: id, Type: typ}
	if driver != "" {
		e.Driver = json.RawMessage(driver)
	}
	return e
}

const deyeDriver = `{"brand":"deye","model":"sun-30k-sg01hp3","family":"hybrid_3p",
  "communication":"solarman_v5",
  "connection":{"ip":"192.168.0.28","port":8899,"serial":"2985159064","mb_slave_id":1}}`

const froniusDriver = `{"role":"pv-generation","brand":"fronius_sunspec",
  "model":"fronius-eco-27-3-s","communication":"fronius_sunspec","capacity_kwp":27,
  "interval_s":5,"connection":{"ip":"192.168.210.40","port":502,"unit_id":1}}`

const meterDriver = `{"role":"grid-meter","brand":"generic_modbus","model":"sunspec",
  "communication":"modbus_tcp","connection":{"ip":"192.168.210.55","port":502,"unit_id":3}}`

func portal(ents ...entities.Entity) entities.Registry {
	return entities.Registry{Revision: "r1", ComponentAuthority: AuthorityPortal, Entities: ents}
}

// --- Die Autoritäts-Regel: ABWESEND heisst box -----------------------------

func TestAuthorityDefaultsToBoxSoAnOlderCloudIsNeverMistakenForATakeover(t *testing.T) {
	for _, raw := range []string{"", "box", "BOX", "Portal", "kommt-aus-der-zukunft"} {
		if got := Authority(raw); got != AuthorityBox {
			t.Fatalf("Authority(%q) = %q, will box", raw, got)
		}
	}
	if Authority(AuthorityPortal) != AuthorityPortal {
		t.Fatal("ein ausdrueckliches portal muss portal bleiben")
	}
	if IsPortalManaged(entities.Registry{Revision: "r1"}) {
		t.Fatal("ein Push ohne Feld darf nie als Uebernahme gelten")
	}
	if !IsPortalManaged(portal()) {
		t.Fatal("ein ausdruecklich portal-verwalteter Push muss erkannt werden")
	}
}

// --- Die Ableitung ---------------------------------------------------------

func TestDeriveBuildsInverterPlusSourcesFromTheDriverBlocks(t *testing.T) {
	reg := portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
		ent("7b2f4e10-0000-0000-0000-000000000003", entities.TypeGridMeter, meterDriver),
	)
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if plan.Revision != "r1" {
		t.Fatalf("Revision = %q", plan.Revision)
	}
	if plan.Inverter == nil || plan.Inverter.Brand != "deye" ||
		plan.Inverter.Family != "hybrid_3p" || plan.Inverter.Connection.Serial != "2985159064" {
		t.Fatalf("Wechselrichter falsch abgeleitet: %+v", plan.Inverter)
	}
	// Die Kommunikationsart kommt aus dem KATALOG der Box, nicht aus dem Push.
	if plan.Inverter.Communication != inverter.CommSolarmanV5 {
		t.Fatalf("communication = %q", plan.Inverter.Communication)
	}
	if len(plan.Sources) != 2 {
		t.Fatalf("Quellen = %d, will 2", len(plan.Sources))
	}
	byRole := map[string]sources.Source{}
	for _, s := range plan.Sources {
		byRole[s.Role] = s
	}
	erz := byRole[sources.RoleErzeuger]
	if erz.Connection.IP != "192.168.210.40" || erz.CapacityKwp != 27 || erz.IntervalS != 5 {
		t.Fatalf("Erzeuger falsch: %+v", erz)
	}
	if byRole[sources.RoleNetz].Connection.UnitID != 3 {
		t.Fatalf("Netz-Zaehler falsch: %+v", byRole[sources.RoleNetz])
	}
}

func TestSourceIdsAreDeterministicSoATakeoverIsANoOp(t *testing.T) {
	reg := portal(ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver))
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	// Genau die Id, die :8484 fuer dasselbe Geraet vergeben wuerde - das ist
	// der Grund, warum die Uebernahme auf der Box nichts aendert.
	want := sources.DeterministicID(plan.Sources[0])
	if plan.Sources[0].ID != want {
		t.Fatalf("id = %q, will %q", plan.Sources[0].ID, want)
	}
	// Und sie ist ueber zwei Ableitungen hinweg stabil.
	again, _ := Derive(reg, cat(), nil, now.Add(time.Hour))
	if again.Sources[0].ID != want {
		t.Fatal("die Quellen-Id darf sich zwischen zwei Ableitungen nie aendern")
	}
}

func TestDeriveIsStableRegardlessOfPushOrder(t *testing.T) {
	a := portal(
		ent("aaaa0000-0000-0000-0000-000000000001", entities.TypeProducer, froniusDriver),
		ent("bbbb0000-0000-0000-0000-000000000002", entities.TypeGridMeter, meterDriver),
	)
	b := portal(a.Entities[1], a.Entities[0])
	pa, _ := Derive(a, cat(), nil, now)
	pb, _ := Derive(b, cat(), nil, now)
	if len(pa.Sources) != 2 || pa.Sources[0].ID != pb.Sources[0].ID ||
		pa.Sources[1].ID != pb.Sources[1].ID {
		t.Fatal("dieselbe Menge in anderer Reihenfolge muss dieselbe Liste ergeben")
	}
}

// --- Was NICHT teilnimmt ---------------------------------------------------

func TestAnEntityWithoutAReachableDriverIsSkippedNotFailed(t *testing.T) {
	reg := portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		// Komponierte Zeilen: kein driver ueberhaupt.
		ent("cccc0000-0000-0000-0000-000000000003", entities.TypeGridMeter, ""),
		ent("dddd0000-0000-0000-0000-000000000004", "house-load", ""),
		// Die Vor-Stufe-1-Form: brand/model OHNE connection - kein erreichbares Geraet.
		ent("eeee0000-0000-0000-0000-000000000005", entities.TypeProducer,
			`{"brand":"fronius_sunspec","model":"fronius-eco-27-3-s"}`),
	)
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Sources) != 0 || plan.Inverter == nil {
		t.Fatalf("nur der Wechselrichter darf uebrig bleiben: %+v", plan)
	}
}

func TestAPushWithoutAnyDeviceIsNotAnInstructionToClearAnything(t *testing.T) {
	_, err := Derive(portal(ent("x1", entities.TypeGridMeter, "")), cat(), nil, now)
	if !errors.Is(err, ErrNoConfiguration) {
		t.Fatalf("err = %v, will ErrNoConfiguration", err)
	}
	_, err = Derive(portal(), cat(), nil, now)
	if !errors.Is(err, ErrNoConfiguration) {
		t.Fatalf("leerer Push: err = %v, will ErrNoConfiguration", err)
	}
}

// --- Nie teilweise ---------------------------------------------------------

func TestOneUntranslatableDriverRefusesTheWHOLEDerivation(t *testing.T) {
	reg := portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer,
			`{"role":"pv-generation","brand":"gibt-es-nicht","connection":{"ip":"192.168.0.9"}}`),
	)
	plan, err := Derive(reg, cat(), nil, now)
	if err == nil {
		t.Fatal("eine unbekannte Marke muss die GANZE Ableitung verweigern")
	}
	if plan.Inverter != nil || len(plan.Sources) != 0 {
		t.Fatal("bei einer Verweigerung darf KEIN Teilplan zurueckkommen")
	}
	// Der Grund ist der deutsche Katalog-Satz, nicht eine Go-Fehlerkette.
	if !strings.Contains(err.Error(), "Unbekannte Marke") {
		t.Fatalf("Grund = %q", err.Error())
	}
}

func TestTwoInvertersAreRefusedByName(t *testing.T) {
	reg := portal(
		ent("aaaa0000-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("bbbb0000-0000-0000-0000-000000000002", entities.TypeBatteryHybrid, deyeDriver),
	)
	if _, err := Derive(reg, cat(), nil, now); err == nil ||
		!strings.Contains(err.Error(), "zwei Wechselrichter") {
		t.Fatalf("err = %v", err)
	}
}

func TestTwoDevicesWithTheSameTransportAreAnAmbiguousSoll(t *testing.T) {
	reg := portal(
		ent("aaaa0000-0000-0000-0000-000000000001", entities.TypeProducer, froniusDriver),
		ent("bbbb0000-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
	)
	_, err := Derive(reg, cat(), nil, now)
	if err == nil || !strings.Contains(err.Error(), "dieselbe Verbindung") {
		t.Fatalf("err = %v", err)
	}
}

func TestAnUndecidableRoleIsRefusedNeverGuessed(t *testing.T) {
	reg := portal(ent("aaaa0000-0000-0000-0000-000000000001", "modbus-generic",
		`{"brand":"generic_modbus","model":"sunspec","connection":{"ip":"192.168.0.5"}}`))
	_, err := Derive(reg, cat(), nil, now)
	if err == nil || !strings.Contains(err.Error(), "welche Rolle") {
		t.Fatalf("err = %v", err)
	}
	// Mit ausdruecklicher Rolle geht es - geraten wird nie.
	reg = portal(ent("aaaa0000-0000-0000-0000-000000000001", "modbus-generic",
		`{"role":"consumer","brand":"generic_modbus","model":"sunspec","connection":{"ip":"192.168.0.5"}}`))
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil || plan.Sources[0].Role != sources.RoleConsumer {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
}

func TestAnUnknownRoleWordIsRefused(t *testing.T) {
	reg := portal(ent("aaaa0000-0000-0000-0000-000000000001", entities.TypeProducer,
		`{"role":"wallbox","brand":"generic_modbus","connection":{"ip":"192.168.0.5"}}`))
	if _, err := Derive(reg, cat(), nil, now); err == nil ||
		!strings.Contains(err.Error(), "unbekannte Rolle") {
		t.Fatalf("err = %v", err)
	}
}

func TestAConsumerCategoryEntityDerivesTheConsumerRole(t *testing.T) {
	e := ent("aaaa0000-0000-0000-0000-000000000001", "wallbox",
		`{"brand":"go-e","model":"goe_http_api","communication":"goe_http_api",
		  "connection":{"ip":"192.168.0.77"}}`)
	e.Capabilities.Actuate = []entities.ActuateCap{{Command: entities.CmdOnOff}}
	plan, err := Derive(portal(e), cat(), nil, now)
	if err != nil || plan.Sources[0].Role != sources.RoleConsumer {
		t.Fatalf("plan=%+v err=%v", plan, err)
	}
}

// --- Die No-op-Eigenschaft -------------------------------------------------

func TestSameAsIgnoresTimestampsSoARedeliveryChangesNothing(t *testing.T) {
	reg := portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
	)
	first, _ := Derive(reg, cat(), nil, now)
	// Eine Stunde spaeter erneut zugestellt: andere Zeitstempel, gleiche Geraete.
	second, _ := Derive(reg, cat(), nil, now.Add(time.Hour))
	if !second.SameAs(first.Inverter, first.Sources) {
		t.Fatal("ein unveraenderter Push muss als „keine Aenderung\" erkannt werden")
	}
}

func TestSameAsSeesEveryRealChange(t *testing.T) {
	base := portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
	)
	plan, _ := Derive(base, cat(), nil, now)

	changed := portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid,
			strings.Replace(deyeDriver, "192.168.0.28", "192.168.0.99", 1)),
		base.Entities[1],
	)
	other, _ := Derive(changed, cat(), nil, now)
	if other.SameAs(plan.Inverter, plan.Sources) {
		t.Fatal("eine geaenderte IP ist eine Aenderung")
	}

	fewer, _ := Derive(portal(base.Entities[0]), cat(), nil, now)
	if fewer.SameAs(plan.Inverter, plan.Sources) {
		t.Fatal("ein entferntes Geraet ist eine Aenderung")
	}

	onlySources, _ := Derive(portal(base.Entities[1]), cat(), nil, now)
	if onlySources.SameAs(plan.Inverter, plan.Sources) {
		t.Fatal("ein entfallener Wechselrichter ist eine Aenderung")
	}
}

// --- Der Kontrakt-Fixture-Beweis (PER PFAD gelesen) ------------------------

func TestTheContractFixtureDerivesTheWholePlant(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"examples", "edge-entity.valid.registry-push-portal-managed.json"))
	if err != nil {
		t.Fatalf("Fixture: %v", err)
	}
	id := entities.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	}
	reg, skipped, err := entities.ParseRegistryPush(raw, id)
	if err != nil || len(skipped) != 0 {
		t.Fatalf("ParseRegistryPush: err=%v skipped=%v", err, skipped)
	}
	if !IsPortalManaged(reg) {
		t.Fatal("die Fixture ist portal-verwaltet")
	}
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if plan.Inverter == nil || plan.Inverter.Model != "sun-30k-sg01hp3" {
		t.Fatalf("Wechselrichter: %+v", plan.Inverter)
	}
	if len(plan.Sources) != 2 {
		t.Fatalf("Quellen = %d", len(plan.Sources))
	}
}

// --- Der persistierte Stand ------------------------------------------------

func TestRecordKeepsTheLastAppliedRevisionAcrossARefusal(t *testing.T) {
	rec := NewRecord(AuthorityPortal, "r5", now)
	rec = rec.WithRefusal("r6", "Unbekannte Marke.")
	if rec.Revision != "r5" {
		t.Fatal("eine Ablehnung darf den laufenden Stand nie ueberschreiben")
	}
	if rec.Refused != "r6" || rec.RefusedReason == "" {
		t.Fatalf("die Ablehnung muss sichtbar bleiben: %+v", rec)
	}
	if cleared := rec.Cleared(); cleared.Refused != "" || cleared.Revision != "r5" {
		t.Fatalf("ein spaeterer Erfolg raeumt nur die Ablehnung: %+v", cleared)
	}
}

func TestStoreRoundTripAndFutureVersionIsIgnoredWholesale(t *testing.T) {
	dir := t.TempDir()
	st, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if _, ok, err := st.Load(); ok || err != nil {
		t.Fatalf("ohne Datei: ok=%v err=%v", ok, err)
	}
	if err := st.Save(NewRecord(AuthorityPortal, "r9", now)); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, ok, err := st.Load()
	if !ok || err != nil || got.Revision != "r9" || got.Authority != AuthorityPortal {
		t.Fatalf("Load: %+v ok=%v err=%v", got, ok, err)
	}

	// Eine Datei aus einer neueren Fassung wird GANZ ignoriert, nicht halb
	// gelesen - die sichere Richtung ist „diese Box weiss nichts davon".
	raw, _ := json.Marshal(map[string]any{"version": StateVersion + 1, "authority": "portal",
		"revision": "r10"})
	if err := os.WriteFile(filepath.Join(dir, "components-applied.json"), raw, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, ok, _ := st.Load(); ok {
		t.Fatal("eine Datei aus der Zukunft darf nicht als gueltig gelten")
	}
}

// --- Die SELBSTBAU-Komponente (Einheitsmodell Stufe 3) ----------------------

const selfBuiltDriver = `{"communication":"modbus_baukasten",
  "connection":{"transport":{"host":"192.168.1.50","port":502,"unit_id":1},
    "channels":[{"slug":"wassertemperatur","label":"Wassertemperatur","unit":"°C",
      "register":{"kind":"holding","address":100,"data_type":"s16","word_order":"big"},
      "scale":0.1,"offset":0,"min_read_interval_s":10}]}}`

// ⚠ Der eigentliche Grund für den Skip-Zweig: Derive ist alles-oder-nichts.
// Ohne ihn liefe ein selbstgebauter Sensor in roleFor auf "welche Rolle" - und
// die Anlage verlöre mit ihrem ERSTEN eigenen Gerät die Anwendung ihres
// Wechselrichters und aller Quellen.
func TestASelfBuiltDeviceIsSkippedAndNeverSinksTheWholePush(t *testing.T) {
	reg := portal(
		ent("6a1e3d0f-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
		ent("aaaa0000-0000-0000-0000-00000000000f", "modbus-generic", selfBuiltDriver),
	)
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("ein Selbstbau-Gerät darf den Push nicht scheitern lassen: %v", err)
	}
	if plan.Inverter == nil {
		t.Fatal("der Wechselrichter fehlt - genau das wäre der Schaden")
	}
	if len(plan.Sources) != 1 {
		t.Fatalf("Quellen = %d, will 1 (der Erzeuger; das Selbstbau-Gerät gehört NICHT dazu)",
			len(plan.Sources))
	}
	for _, s := range plan.Sources {
		if strings.Contains(s.Communication, "baukasten") {
			t.Fatalf("ein Selbstbau-Gerät ist in sources.json gelandet: %+v", s)
		}
	}
}

// Eine Anlage, die AUSSCHLIESSLICH Selbstbau-Geräte hat, nennt kein einziges
// Katalog-Gerät - das ist der dokumentierte „leeres Soll löscht nichts"-Fall,
// nicht ein Fehler des Kunden.
func TestAPlantWithOnlySelfBuiltDevicesDerivesNoConfigurationAtAll(t *testing.T) {
	reg := portal(ent("aaaa0000-0000-0000-0000-00000000000f", "modbus-generic", selfBuiltDriver))
	_, err := Derive(reg, cat(), nil, now)
	if !errors.Is(err, ErrNoConfiguration) {
		t.Fatalf("err = %v, will ErrNoConfiguration", err)
	}
}

// --- Die selbst angebundene BATTERIE ueber MQTT (P5 Ebene 1) ---------------

// Die Cloud pusht sie mit communication mqtt_local und der GANZEN gespeicherten
// Definition als driver.connection (UserDefinedBatteryService.definitionJson -
// ein Broker plus die Feld-Zuordnung), NIE mit einer Marke.
const mqttBatteryDriver = `{"communication":"mqtt_local",
  "connection":{"schema_version":"1.0","transport":"mqtt_local",
    "broker":{"host":"192.168.40.20","port":1883},"publish_interval_s":15,
    "mappings":[{"channel":"cell_min_mv","unit":"mV","topic":"emon/diybms/+/+",
      "path":"voltage","aggregate":"min","value_type":"number","scale":1000,
      "offset":0,"stale_s":300}]}}`

// Dieselbe Gefahr wie beim Selbstbau-Geraet, ein Transport weiter: Derive ist
// alles-oder-nichts, und eine MQTT-Batterie traegt keine Marke. Ohne den
// erweiterten Skip verloere die Anlage mit ihrer ERSTEN eigenen Batterie die
// Anwendung ihres Wechselrichters und aller Quellen.
func TestAnMqttBatteryIsSkippedAndNeverSinksTheWholePush(t *testing.T) {
	reg := portal(
		ent("6a1e3d0f-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
		ent("bbbb0000-0000-0000-0000-00000000000f", "user-defined-battery", mqttBatteryDriver),
	)
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("eine selbst angebundene Batterie darf den Push nicht scheitern lassen: %v", err)
	}
	if plan.Inverter == nil {
		t.Fatal("der Wechselrichter fehlt - genau das waere der Schaden")
	}
	if len(plan.Sources) != 1 {
		t.Fatalf("Quellen = %d, will 1 (der Erzeuger; die MQTT-Batterie gehoert NICHT dazu)",
			len(plan.Sources))
	}
	for _, s := range plan.Sources {
		if strings.Contains(s.Communication, "mqtt") {
			t.Fatalf("eine MQTT-Batterie ist in sources.json gelandet: %+v", s)
		}
	}
}

// --- Dieselbe Batterie ueber HTTP/JSON (P5 Ebene 1 "HTTP/JSON") -----------

// Der ZWEITE Lesetyp desselben Anschlusses: communication http_local, und die
// gespeicherte Definition traegt hier zusaetzlich das GEHEIMNIS des Endpunkts
// (auth_secret). Es reist ueber DIESEN Weg zur Box - nie im Flow-Dokument, das
// ueber die Portal-API lesbar waere - und wird vom vp-http-read-Knoten aus der
// per-Entitaet retained Konfiguration gelesen.
const httpBatteryDriver = `{"communication":"http_local",
  "connection":{"schema_version":"1.0","transport":"http_local",
    "endpoint":{"host":"192.168.40.21","port":80,"path":"/ha","tls":false},
    "auth":{"mode":"header","header":"ApiKey"},"auth_secret":"geheim-123",
    "publish_interval_s":15,"timeout_ms":5000,
    "mappings":[{"channel":"soc_pct","unit":"%","path":"soc",
      "aggregate":"last","value_type":"number","scale":1,"offset":0}]}}`

// Dieselbe Gefahr, ein Transport weiter: ohne den erweiterten Skip verloere
// die Anlage mit ihrer ersten HTTP-Batterie die Anwendung ihres
// Wechselrichters und aller Quellen (Derive ist alles-oder-nichts).
func TestAnHTTPBatteryIsSkippedAndNeverSinksTheWholePush(t *testing.T) {
	reg := portal(
		ent("6a1e3d0f-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		ent("6a1e3d0f-0000-0000-0000-000000000002", entities.TypeProducer, froniusDriver),
		ent("bbbb0000-0000-0000-0000-0000000000ff", "user-defined-battery", httpBatteryDriver),
	)
	plan, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("eine selbst angebundene Batterie darf den Push nicht scheitern lassen: %v", err)
	}
	if plan.Inverter == nil {
		t.Fatal("der Wechselrichter fehlt - genau das waere der Schaden")
	}
	if len(plan.Sources) != 1 {
		t.Fatalf("Quellen = %d, will 1 (der Erzeuger; die HTTP-Batterie gehoert NICHT dazu)",
			len(plan.Sources))
	}
	for _, s := range plan.Sources {
		if strings.Contains(s.Communication, "http_local") {
			t.Fatalf("eine HTTP-Batterie ist in sources.json gelandet: %+v", s)
		}
	}
}

func TestParseDriverSkipsAnHTTPBatteryBeforeTheBrandCheck(t *testing.T) {
	e := entities.Entity{ID: "batt", Type: "user-defined-battery",
		Driver: json.RawMessage(httpBatteryDriver)}
	d, ok, err := ParseDriver(e)
	if err != nil {
		t.Fatalf("kein Fehler erwartet, bekam %v", err)
	}
	if ok {
		t.Fatalf("die Batterie darf kein Treiber-Ziel sein, bekam %+v", d)
	}
}

// ParseDriver ueberspringt sie ausdruecklich - und zwar VOR der Marken-Pruefung.
// Ihr Leseplan reist als generierter Flow ueber v2/flows, nicht ueber diesen
// Weg.
func TestParseDriverSkipsAnMqttBatteryBeforeTheBrandCheck(t *testing.T) {
	e := entities.Entity{ID: "batt", Type: "user-defined-battery",
		Driver: json.RawMessage(mqttBatteryDriver)}
	d, ok, err := ParseDriver(e)
	if err != nil {
		t.Fatalf("kein Fehler erwartet, bekam %v", err)
	}
	if ok {
		t.Fatalf("die Batterie darf kein Treiber-Ziel sein, bekam %+v", d)
	}
}

// Die :8484-Geraetekarte ist Modbus-geformt (Adresse, Unit-ID, Kanalliste). Die
// MQTT-Batterie hat davon nichts - sie wird uebersprungen, aber bewusst NICHT
// als Selbstbau-Geraet gelistet, sonst stuende dort eine leere Adresse.
func TestAnMqttBatteryIsSkippedButNotListedAsASelfBuiltDevice(t *testing.T) {
	e := entities.Entity{ID: "batt", Type: "user-defined-battery",
		Driver: json.RawMessage(mqttBatteryDriver)}
	if IsSelfBuilt(e) {
		t.Fatal("die MQTT-Batterie gehoert nicht auf die Modbus-Geraetekarte")
	}
}

// TestARoleAssignmentNeverTouchesTheDerivedPlan ist die Abgrenzung von Befund
// L4: die Rollen-Zuordnung des Portals ist ANZEIGE. Sie darf die abgeleitete
// Geraete-Konfiguration (inverter.json / sources.json) um kein Byte veraendern
// - sonst wuerde ein Klick auf „Rollen & Zuordnung" die Leseplaene einer
// laufenden Anlage umschreiben, und SameAs meldete faelschlich eine Aenderung.
//
// Die Rolle einer QUELLE leitet Derive weiterhin aus dem Entitaetstyp ab
// (roleFor); das Vokabular der Topologie (pv/storage/grid/consumer) kennt es
// gar nicht.
func TestARoleAssignmentNeverTouchesTheDerivedPlan(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2",
		"examples", "edge-entity.valid.registry-push-portal-managed.json"))
	if err != nil {
		t.Fatalf("Fixture: %v", err)
	}
	id := entities.Identity{
		TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID:   "00000000-0000-0000-0000-000000000002",
		DeviceID: "00000000-0000-0000-0000-000000000003",
	}
	reg, _, err := entities.ParseRegistryPush(raw, id)
	if err != nil {
		t.Fatalf("ParseRegistryPush: %v", err)
	}
	before, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	// Derselbe Push, jede Entitaet mit einer umgewidmeten Rolle.
	for i := range reg.Entities {
		reg.Entities[i].RoleAssignment = []entities.RoleAssignment{
			{Channel: "power_kw", Role: "pv", Primary: true},
		}
	}
	after, err := Derive(reg, cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive mit Rollen: %v", err)
	}

	if !after.SameAs(before.Inverter, before.Sources) {
		t.Fatalf("die Rollen-Zuordnung hat den Geraeteplan veraendert:\nvorher %+v\nnachher %+v",
			before, after)
	}
	wantJSON, err := json.Marshal(before)
	if err != nil {
		t.Fatal(err)
	}
	gotJSON, err := json.Marshal(after)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("Plan-Bytes abgewichen:\n got %s\nwant %s", gotJSON, wantJSON)
	}
}

// --- Ebyte-I/O-Modul: ein Geraet, Kanaele als Verbraucher --------------------

const ebyteDeviceDriver = `{"brand":"ebyte","model":"m31_axax8080g_u","communication":"ebyte_modbus_tcp",
  "connection":{"ip":"192.168.3.50","port":502,"unit_id":1,"mac":"00:54:2c:84:9b:90"}}`

func TestAnIOModuleBecomesOneConsumerSideSourceAndItsChannelsNone(t *testing.T) {
	dev := ent("e0000000-0000-0000-0000-00000000000a", "io-module", ebyteDeviceDriver)
	dev.Guards.Failsafe.Behavior = "measure-only"
	rod := ent("e0000000-0000-0000-0000-00000000000b", entities.TypeHeatingRod,
		`{"communication":"ebyte_modbus_tcp","io_entity_id":"e0000000-0000-0000-0000-00000000000a","channel":3}`)
	rod.Capabilities.Actuate = []entities.ActuateCap{{Command: entities.CmdOnOff}}
	pump := ent("e0000000-0000-0000-0000-00000000000c", entities.TypeGenericLoad,
		`{"communication":"ebyte_modbus_tcp","io_entity_id":"e0000000-0000-0000-0000-00000000000a","channel":4}`)
	pump.Capabilities.Actuate = []entities.ActuateCap{{Command: entities.CmdOnOff}}
	plan, err := Derive(portal(
		ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver),
		dev, rod, pump), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if plan.Inverter == nil || len(plan.Sources) != 1 {
		t.Fatalf("expected the inverter plus ONE module source, got %+v", plan)
	}
	s := plan.Sources[0]
	if s.Role != sources.RoleConsumer || s.Communication != inverter.CommEbyteModbusTCP ||
		s.Connection.MAC != "00:54:2c:84:9b:90" || s.Connection.UnitID != 1 {
		t.Fatalf("module source %+v", s)
	}
}
