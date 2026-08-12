package agent

// DER BEWEIS DIESER STUFE: die Bestands-Übernahme ist auf der Box ein NO-OP.
//
// Der Ablauf, den dieser Test wirklich fährt - kein Modell davon, sondern die
// echten Bausteine beider Seiten:
//
//	 :8484 richtet ein  ->  a.localSetupSummary()          (was die Box MELDET)
//	                    ->  cloudDriverFromReport(...)     (was die Cloud daraus SCHREIBT)
//	                    ->  componentapply.Derive(...)     (was die Box daraus ABLEITET)
//	                    ->  plan.SameAs(Ist)               (== keine Änderung)
//
// `cloudDriverFromReport` ist die Test-Spiegelung von
// `EntityRegistryService.driverBlock` (Java). Sie IST die Vertragsfläche
// zwischen beiden Seiten - dass die api genau diese Form erzeugt, nagelt
// `ComponentApiTest` cloud-seitig fest; dass die Box daraus zeichengleich
// dasselbe herleitet, steht hier.
//
// Die Anlage ist Pilsting-artig, weil genau sie das Ziel dieser Stufe ist:
// ein Deye SUN-30K-SG01HP3 als führender Wechselrichter, ZWEI Fronius Eco
// hinter EINER IP (Unit 1 und 2), und die Netzmessung läuft über den CT des
// Deye - es gibt also KEINEN eigenen Netz-Zähler.

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// pilstingBox richtet eine Bestandsanlage so ein, wie sie heute auf :8484
// entsteht - inklusive der Eigenheiten, die eine Übernahme nicht verlieren darf
// (Vorzeichen-Umkehr, Leistungsskala, Schreib-Funktionscode, Lese-Kadenz, kWp,
// MaStR-Nummer).
func pilstingBox(t *testing.T) *Agent {
	t.Helper()
	a := newGateTestAgent(t)
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: "deye", Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{
			IP: "192.168.0.28", Port: 8899, Serial: "2985159064", MbSlaveID: 1,
			PowerScale: 10, InvertBattSign: true, ControlWriteFc: 16,
		},
	}); err != nil {
		t.Fatalf("Wechselrichter: %v", err)
	}
	for _, unit := range []int{1, 2} {
		if _, err := a.AddSource(sources.Request{
			Role: sources.RoleErzeuger, Brand: "fronius_sunspec", Model: "fronius-eco-27-3-s",
			Connection: inverter.Connection{
				IP: "192.168.210.40", Port: 502, UnitID: unit, CurtailWriteFc: 16,
			},
			IntervalS:      30,
			CapacityKwp:    27,
			RegistryUnitID: "SEE96683166944" + itoa(unit),
		}); err != nil {
			t.Fatalf("Erzeuger %d: %v", unit, err)
		}
	}
	return a
}

func itoa(i int) string { return strconv.Itoa(i) }

// cloudDriverFromReport baut den Treiberblock, den die Cloud aus einem
// gemeldeten local_setup-Eintrag schreibt - die Spiegelung von
// EntityRegistryService.driverBlock.
//
// Die ROLLE wird bewusst NICHT gesetzt: die Cloud sendet sie nicht (der Applier
// leitet sie aus dem Entitätstyp ab, und das v1-Rollen-Vokabular der Cloud
// kennt der Applier gar nicht).
func cloudDriverFromReport(e cloud.LocalSetupEntry) json.RawMessage {
	d := map[string]any{"communication": e.Communication}
	if e.Brand != "" {
		d["brand"] = e.Brand
	}
	if e.Model != "" {
		d["model"] = e.Model
	}
	if e.Family != "" {
		d["family"] = e.Family
	}
	if e.CapacityKwp != 0 {
		d["capacity_kwp"] = e.CapacityKwp
	}
	if e.RegistryUnitID != "" {
		d["registry_unit_id"] = e.RegistryUnitID
	}
	if e.IntervalS != 0 {
		d["interval_s"] = e.IntervalS
	}
	if len(e.Connection) > 0 {
		var conn map[string]any
		if err := json.Unmarshal(e.Connection, &conn); err == nil {
			d["connection"] = conn
		}
	}
	b, _ := json.Marshal(d)
	return b
}

// cloudPushFromReport ist die ganze Cloud-Hälfte: aus dem gemeldeten Ist wird
// das Soll, mit der Autorität auf portal gedreht.
func cloudPushFromReport(report []cloud.LocalSetupEntry) entities.Registry {
	reg := entities.Registry{
		Revision:           "uebernahme-1",
		ComponentAuthority: componentapply.AuthorityPortal,
	}
	for i, e := range report {
		typ := entities.TypeProducer
		if e.Kind == "inverter" {
			typ = entities.TypeBatteryHybrid
		} else if e.Role == sources.RoleNetz {
			typ = entities.TypeGridMeter
		}
		reg.Entities = append(reg.Entities, entities.Entity{
			// Die Entitäts-Kennungen der Cloud sind UUIDs und haben mit den
			// Quellen-Kennungen der Box nichts zu tun - genau deshalb muss die
			// Identität deterministisch aus dem TRANSPORT entstehen.
			ID:     "00000000-0000-0000-0000-00000000000" + itoa(i+1),
			Type:   typ,
			Label:  e.Label,
			Driver: cloudDriverFromReport(e),
		})
	}
	return reg
}

// --- Der Kern-Beweis -------------------------------------------------------

func TestTakeoverOfARunningPlantChangesNothing(t *testing.T) {
	a := pilstingBox(t)

	istInverter, ok := a.GetInverter()
	if !ok {
		t.Fatal("Aufbau: kein Wechselrichter")
	}
	istSources := a.ListSources()
	if len(istSources) != 2 {
		t.Fatalf("Aufbau: %d Quellen, erwartet 2", len(istSources))
	}

	// 1 · Was die Box meldet.
	report := a.localSetupSummary()
	if len(report) != 3 {
		t.Fatalf("local_setup meldet %d Einträge, erwartet 3", len(report))
	}
	for _, e := range report {
		if len(e.Connection) == 0 || e.Communication == "" {
			t.Fatalf("Eintrag %q meldet keine Verbindung - ohne sie ist keine "+
				"Übernahme möglich", e.ID)
		}
	}

	// 2 · Was die Cloud daraus als Soll schreibt und zurückschickt.
	push := cloudPushFromReport(report)

	// 3 · Was die Box daraus ableitet.
	plan, err := componentapply.Derive(push, inverter.DefaultCatalog(), time.Now())
	if err != nil {
		t.Fatalf("das übernommene Soll ist auf der Box nicht anwendbar: %v", err)
	}

	// 4 · DIE Aussage: es ändert sich nichts.
	if !plan.SameAs(&istInverter, istSources) {
		t.Fatalf("die Übernahme ist KEIN No-op.\nIst  Wechselrichter: %+v\nSoll Wechselrichter: %+v"+
			"\nIst  Quellen: %+v\nSoll Quellen: %+v",
			istInverter, plan.Inverter, istSources, plan.Sources)
	}

	// 5 · Und der Applier tut daraufhin wirklich nichts.
	before := snapshotLocal(a)
	a.applyEntityRegistry(push)
	after := snapshotLocal(a)
	if after.inverterIP != before.inverterIP {
		t.Fatalf("der Wechselrichter wurde angefasst: %q -> %q", before.inverterIP,
			after.inverterIP)
	}
	if len(after.sourceIDs) != len(before.sourceIDs) {
		t.Fatalf("die Quellenliste änderte sich: %v -> %v", before.sourceIDs, after.sourceIDs)
	}
	for i := range before.sourceIDs {
		if before.sourceIDs[i] != after.sourceIDs[i] {
			t.Fatalf("eine Quellen-Kennung änderte sich: %v -> %v", before.sourceIDs,
				after.sourceIDs)
		}
	}
	// Ab jetzt ist die Anlage portal-verwaltet - das ist die EINZIGE Änderung,
	// die die Übernahme bewirkt.
	if !a.PortalManagedComponents() {
		t.Fatal("nach der Übernahme muss die Anlage portal-verwaltet sein")
	}
}

// --- Feld für Feld: was die Übernahme mitnimmt -----------------------------

func TestTakeoverKeepsEveryFieldOfTheRunningConfiguration(t *testing.T) {
	a := pilstingBox(t)
	istInverter, _ := a.GetInverter()
	istSources := a.ListSources()

	plan, err := componentapply.Derive(cloudPushFromReport(a.localSetupSummary()),
		inverter.DefaultCatalog(), time.Now())
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}

	// Der Wechselrichter: Marke/Modell/Familie/Transport und JEDES
	// Verbindungsfeld, inklusive der Eigenheiten, die am Gerät belegt wurden.
	got := *plan.Inverter
	if got.Brand != istInverter.Brand || got.Model != istInverter.Model ||
		got.Family != istInverter.Family || got.Communication != istInverter.Communication {
		t.Fatalf("Wechselrichter-Identität verloren: %+v", got)
	}
	if got.Connection != istInverter.Connection {
		t.Fatalf("Verbindungsfelder des Wechselrichters verloren:\nIst  %+v\nSoll %+v",
			istInverter.Connection, got.Connection)
	}
	// Die einzelnen Eigenheiten noch einmal beim Namen - sie sind der Grund,
	// warum die Verbindung VERBATIM reist statt neu zusammengesetzt zu werden.
	if !got.Connection.InvertBattSign {
		t.Fatal("invert_batt_sign verloren - die Batterie läse danach verkehrt herum")
	}
	if got.Connection.PowerScale != 10 {
		t.Fatalf("power_scale verloren (%v) - die HV/LV-Skala entscheidet über den Faktor 10",
			got.Connection.PowerScale)
	}
	if got.Connection.ControlWriteFc != 16 {
		t.Fatalf("control_write_fc verloren (%d) - der Schreibweg fiele auf FC6 zurück",
			got.Connection.ControlWriteFc)
	}

	// Die Quellen: je Quelle die Identität UND die Stammdaten.
	byID := map[string]sources.Source{}
	for _, s := range plan.Sources {
		byID[s.ID] = s
	}
	for _, ist := range istSources {
		soll, ok := byID[ist.ID]
		if !ok {
			t.Fatalf("Quelle %q (%s Unit %d) fehlt im übernommenen Soll - die deterministische "+
				"Kennung stimmt nicht überein", ist.ID, ist.Communication, ist.Connection.UnitID)
		}
		if soll.Role != ist.Role || soll.Communication != ist.Communication ||
			soll.Family != ist.Family || soll.Brand != ist.Brand || soll.Model != ist.Model {
			t.Fatalf("Quelle %q: Identität verloren\nIst  %+v\nSoll %+v", ist.ID, ist, soll)
		}
		if soll.Connection != ist.Connection {
			t.Fatalf("Quelle %q: Verbindungsfelder verloren\nIst  %+v\nSoll %+v", ist.ID,
				ist.Connection, soll.Connection)
		}
		if soll.IntervalS != ist.IntervalS {
			t.Fatalf("Quelle %q: Lese-Kadenz verloren (%d statt %d) - die Anlage würde nach der "+
				"Übernahme anders oft gelesen", ist.ID, soll.IntervalS, ist.IntervalS)
		}
		if soll.CapacityKwp != ist.CapacityKwp {
			t.Fatalf("Quelle %q: Nennleistung verloren (%v statt %v) - die physikalische Hülle "+
				"der Box würde enger", ist.ID, soll.CapacityKwp, ist.CapacityKwp)
		}
		if soll.RegistryUnitID != ist.RegistryUnitID {
			t.Fatalf("Quelle %q: MaStR-Referenz verloren (%q statt %q)", ist.ID,
				soll.RegistryUnitID, ist.RegistryUnitID)
		}
		if soll.Label != ist.Label {
			t.Fatalf("Quelle %q: Name verloren (%q statt %q)", ist.ID, soll.Label, ist.Label)
		}
	}
}

// Zwei Wechselrichter hinter EINER IP wären ohne die Unit-Id dieselbe Identität.
// Der Test belegt, dass die zwei Fronius sauber getrennt bleiben - sonst würde
// die Übernahme einen von beiden verschlucken.
func TestTakeoverKeepsTwoInvertersBehindOneAddressApart(t *testing.T) {
	a := pilstingBox(t)
	ist := a.ListSources()
	if ist[0].ID == ist[1].ID {
		t.Fatal("Aufbau: beide Fronius haben dieselbe Kennung")
	}
	plan, err := componentapply.Derive(cloudPushFromReport(a.localSetupSummary()),
		inverter.DefaultCatalog(), time.Now())
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Sources) != 2 {
		t.Fatalf("%d Quellen im Soll, erwartet 2", len(plan.Sources))
	}
	units := map[int]bool{}
	for _, s := range plan.Sources {
		units[s.Connection.UnitID] = true
	}
	if !units[1] || !units[2] {
		t.Fatalf("die beiden Unit-Ids überlebten die Übernahme nicht: %v", units)
	}
}

// Eine Anlage OHNE eigenen Netz-Zähler (Netzmessung über den CT des Deye) darf
// durch die Übernahme keinen erfinden - der Bericht nennt keinen, also steht
// auch keiner im Soll.
func TestTakeoverInventsNoGridMeter(t *testing.T) {
	a := pilstingBox(t)
	for _, e := range a.localSetupSummary() {
		if e.Role == sources.RoleNetz {
			t.Fatalf("die Box meldet einen Netz-Zähler, obwohl keiner eingerichtet ist: %+v", e)
		}
	}
	plan, err := componentapply.Derive(cloudPushFromReport(a.localSetupSummary()),
		inverter.DefaultCatalog(), time.Now())
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	for _, s := range plan.Sources {
		if s.Role == sources.RoleNetz {
			t.Fatalf("das übernommene Soll erfindet einen Netz-Zähler: %+v", s)
		}
	}
}

// Ein ÄLTERER Box-Stand meldet keine Verbindungen. Der Bericht ist dann
// unvollständig - und das muss auf den ersten Blick erkennbar sein, sonst
// entstünde daraus ein halbes Soll.
func TestAnOlderReportCarriesNoConnectionAndIsRecognisable(t *testing.T) {
	a := pilstingBox(t)
	report := a.localSetupSummary()
	// Genau die Form, die ein Stand vor dieser Stufe sendet.
	older := make([]cloud.LocalSetupEntry, 0, len(report))
	for _, e := range report {
		older = append(older, cloud.LocalSetupEntry{
			ID: e.ID, Kind: e.Kind, Role: e.Role, Brand: e.Brand, Model: e.Model, Label: e.Label,
		})
	}
	for _, e := range older {
		if len(e.Connection) != 0 || e.Communication != "" {
			t.Fatal("der Vergleichs-Bericht ist nicht die ältere Form")
		}
	}
	// Und ein daraus gebautes Soll trägt keinen Treiber, ist also für den
	// Applier gar kein Gerät - das ist die Sicherung, falls die Cloud-Regel je
	// versagt.
	push := cloudPushFromReport(older)
	if _, err := componentapply.Derive(push, inverter.DefaultCatalog(), time.Now()); err == nil {
		t.Fatal("ein Soll ohne jede Verbindung muss abgelehnt werden, nicht angewandt")
	}
}

// Die Drahtform: ein Feld, das die Box nicht hat, wird WEGGELASSEN - nie als 0
// oder "" gesendet. Nur so kann die Cloud „nicht gemeldet" von „ist 0"
// unterscheiden.
func TestReportOmitsWhatTheBoxDoesNotHave(t *testing.T) {
	a := newGateTestAgent(t)
	if _, err := a.AddSource(sources.Request{
		Role: sources.RoleNetz, Brand: inverter.BrandGenericModbus, Model: inverter.FamSunSpec,
		Connection: inverter.Connection{IP: "10.0.0.9", UnitID: 3},
	}); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(a.localSetupSummary())
	if err != nil {
		t.Fatal(err)
	}
	wire := string(raw)
	for _, absent := range []string{`"capacity_kwp"`, `"registry_unit_id"`} {
		if strings.Contains(wire, absent) {
			t.Fatalf("%s wird gesendet, obwohl die Quelle es nicht hat: %s", absent, wire)
		}
	}
	if !strings.Contains(wire, `"communication"`) || !strings.Contains(wire, `"connection"`) {
		t.Fatalf("Transport und Verbindung müssen immer mitreisen: %s", wire)
	}
}
