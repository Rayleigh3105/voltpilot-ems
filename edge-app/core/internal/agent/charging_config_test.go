package agent

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// Die Verdrahtung: ein Dokument des Portals wird zu EINSTELLUNGEN dieser Box -
// und zu nichts anderem. Der Verteiler rechnet danach wie immer.
func TestThePortalConfigBecomesSettingsAndNothingElse(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	ocppStation(t, a, "saeule-1", 1, 240)
	ocppStation(t, a, "saeule-2", 1, 240)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	a.entMu.Unlock()

	before := a.OcppSettings()
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
		"device_id":"d","grid_limit_kw":277,"priority_charge_point_ids":["saeule-2"],
		"published_at":"2026-08-20T11:24:00Z"}`))

	after := a.OcppSettings()
	if after.GridLimitKw != 277 {
		t.Fatalf("die Anschlussgrenze muss ankommen, got %v", after.GridLimitKw)
	}
	// ⚠ PATCH: was das Portal NICHT nennt, bleibt wie es war.
	if after.MarginPct != before.MarginPct || after.MinPowerKw != before.MinPowerKw ||
		after.MaxHouseLoadKw != before.MaxHouseLoadKw {
		t.Fatalf("ein abwesendes Feld darf nichts zuruecksetzen: %+v -> %+v", before, after)
	}
	// Der Vorrang ist die GANZE Aussage: genannt = an, nicht genannt = aus.
	if !priorityOf(t, a, "saeule-2") || priorityOf(t, a, "saeule-1") {
		t.Fatal("genau die genannte Saeule bekommt Vorrang")
	}

	// Die Liste zurueckgenommen -> niemand hat mehr Vorrang.
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
		"device_id":"d","priority_charge_point_ids":[],"published_at":"2026-08-20T11:39:00Z"}`))
	if priorityOf(t, a, "saeule-2") {
		t.Fatal("eine leere Liste nimmt den Vorrang zurueck")
	}
	if a.OcppSettings().GridLimitKw != 277 {
		t.Fatal("und sie fasst die Anschlussgrenze nicht an")
	}
}

// Ein fremdes Dokument, eine kaputte Zahl und die Ruecknahme aendern NICHTS -
// eine Einstellung entsteht nur aus einem Dokument, das uns meint und das wir
// verstehen.
func TestAForeignOrBrokenDocumentChangesNothing(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	a.entMu.Unlock()
	limit := 200.0
	if _, err := a.OcppSaveSettings(lastmgmt.SettingsRequest{GridLimitKw: &limit}); err != nil {
		t.Fatal(err)
	}

	for _, payload := range []string{
		// fremdes Geraet
		`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"fremd",
		  "grid_limit_kw":99,"published_at":"2026-08-20T11:24:00Z"}`,
		// unplausible Grenze
		`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
		  "grid_limit_kw":0,"published_at":"2026-08-20T11:24:00Z"}`,
		// fremde Vertragsversion
		`{"schema_version":"2.0","tenant_id":"t","site_id":"s","device_id":"d",
		  "grid_limit_kw":99,"published_at":"2026-08-20T11:24:00Z"}`,
		// unlesbar
		`kein json`,
		// die Ruecknahme: die uebernommenen Werte BLEIBEN stehen
		``,
	} {
		a.onChargingConfig([]byte(payload))
		if got := a.OcppSettings().GridLimitKw; got != 200 {
			t.Fatalf("payload %q hat die Grenze auf %v veraendert", payload, got)
		}
	}
}

// Eine Box ohne OCPP-Flag hat kein Lastmanagement: das Dokument wird
// entgegengenommen und tut nichts - ein Absturz waere hier das Schlimmste.
func TestABoxWithoutOcppSurvivesTheDocument(t *testing.T) {
	a := &Agent{}
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	a.entMu.Unlock()
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
		"device_id":"d","grid_limit_kw":277,"published_at":"2026-08-20T11:24:00Z"}`))
}

func priorityOf(t *testing.T, a *Agent, id string) bool {
	t.Helper()
	for _, c := range a.OcppChargers() {
		if c.ID == id {
			return c.Priority
		}
	}
	t.Fatalf("unbekannte Saeule %s", id)
	return false
}

// --- Stufe 4: the two SOURCE choices ride the same document ----------------

// chargingCfgAgent is a box with OCPP on and a known cloud identity.
func chargingCfgAgent(t *testing.T) *Agent {
	t.Helper()
	a := ocppAgent(t, nil)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	a.entMu.Unlock()
	return a
}

// TestThePortalCanSetTheSourceChoiceAndAbsenceKeepsIt is the PATCH promise of
// the two new fields.
func TestThePortalCanSetTheSourceChoiceAndAbsenceKeepsIt(t *testing.T) {
	a := chargingCfgAgent(t)
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","surplus_policy":"nur_sonne","storage_priority":"auto_vor_speicher",
	  "published_at":"2026-08-20T13:24:00Z"}`))
	set := a.OcppSettings()
	if set.SurplusPolicy != lastmgmt.PolicySolarOnly || set.StoragePriority != lastmgmt.CarsBeforeStorage {
		t.Fatalf("the portal's choice did not arrive: %+v", set)
	}
	// A later document that says nothing about the source KEEPS it - the whole
	// point of PATCH, and the reason absent is not the same as „schnell".
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","grid_limit_kw":300,"published_at":"2026-08-20T13:30:00Z"}`))
	set = a.OcppSettings()
	if set.SurplusPolicy != lastmgmt.PolicySolarOnly || set.StoragePriority != lastmgmt.CarsBeforeStorage {
		t.Fatalf("an absent field must keep the customer's choice: %+v", set)
	}
	if set.GridLimitKw != 300 {
		t.Fatalf("the limit of the same document must apply: %v", set.GridLimitKw)
	}
}

// TestAnUnknownSourceWordChangesNOTHING - a document we cannot read must never
// become a setting, and it must not half-apply either.
func TestAnUnknownSourceWordChangesNOTHING(t *testing.T) {
	a := chargingCfgAgent(t)
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","grid_limit_kw":277,"surplus_policy":"hoffentlich",
	  "published_at":"2026-08-20T13:24:00Z"}`))
	set := a.OcppSettings()
	if set.GridLimitKw != 0 {
		t.Fatalf("a refused document must not apply its OTHER fields either: %v", set.GridLimitKw)
	}
	if set.SurplusPolicy != lastmgmt.PolicyFast {
		t.Fatalf("the box keeps its own choice: %q", set.SurplusPolicy)
	}
}

// --- Der Anbinde-Assistent: die ALLOWLIST kommt aus dem Portal --------------

// chargerOf liefert den Eintrag der Allowlist, oder ok=false.
func chargerOf(a *Agent, id string) (csms.Charger, bool) {
	for _, c := range a.OcppChargers() {
		if c.ID == id {
			return c, true
		}
	}
	return csms.Charger{}, false
}

// ⚠ DIE Zusage dieser Stufe: die Liste FUEGT NUR HINZU. Sie ueberschreibt
// keinen bestehenden Eintrag (Label und Vorrang koennen auf :8484 gepflegt
// sein) und entfernt NIE einen - ein WEGLASSEN ist kein Loeschen. Wer loeschen
// will, sagt es in removed_charge_point_ids (siehe die Tests darunter).
func TestTheAllowlistOnlyAddsAndNeverOverwritesOrRemoves(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	if _, err := a.OcppAddCharger(csms.AddRequest{
		ID: "saeule-1", Label: "Am Geraet gepflegt", Priority: true, Connectors: 2,
	}); err != nil {
		t.Fatal(err)
	}

	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-1","label":"Aus dem Portal"},
	  {"id":"saeule-2","label":"Halle","rated_kw":22,"connectors":1}],
	  "published_at":"2026-08-21T09:15:00Z"}`))

	alt, ok := chargerOf(a, "saeule-1")
	if !ok {
		t.Fatal("der bestehende Eintrag darf nicht verschwinden")
	}
	if alt.Label != "Am Geraet gepflegt" || !alt.Priority {
		t.Fatalf("ein bestehender Eintrag wird NICHT ueberschrieben: %+v", alt)
	}
	neu, ok := chargerOf(a, "saeule-2")
	if !ok {
		t.Fatal("die neue Kennung muss uebernommen werden")
	}
	if neu.Label != "Halle" || neu.RatedKw != 22 || neu.Connectors != 1 {
		t.Fatalf("die Angaben des Betreibers reisen mit: %+v", neu)
	}

	// Ein spaeteres Dokument OHNE die Liste - und eines mit einer LEEREN -
	// entfernt nichts: abwesend und leer sind hier dasselbe.
	for _, payload := range []string{
		`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
		  "grid_limit_kw":300,"published_at":"2026-08-21T09:20:00Z"}`,
		`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
		  "charge_points":[],"published_at":"2026-08-21T09:25:00Z"}`,
	} {
		a.onChargingConfig([]byte(payload))
		if _, ok := chargerOf(a, "saeule-1"); !ok {
			t.Fatalf("payload %q hat einen Eintrag entfernt", payload)
		}
		if _, ok := chargerOf(a, "saeule-2"); !ok {
			t.Fatalf("payload %q hat einen Eintrag entfernt", payload)
		}
	}
}

// ⚠ Die Allowlist wird ZUERST angewandt: eine gerade eingetragene Saeule soll
// den Vorrang DESSELBEN Dokuments schon abbekommen, sonst zoege er erst beim
// naechsten Speichern.
func TestANewlyAdmittedStationGetsThePriorityOfTheSameDocument(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)

	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-neu"}],
	  "priority_charge_point_ids":["saeule-neu"],
	  "published_at":"2026-08-21T09:15:00Z"}`))

	c, ok := chargerOf(a, "saeule-neu")
	if !ok {
		t.Fatal("die Saeule muss eingetragen sein")
	}
	if !c.Priority {
		t.Fatal("und den Vorrang desselben Dokuments schon tragen")
	}
}

// Ein Dokument, das wir nicht verstehen, traegt auch keine Allowlist ins Haus -
// und eine Box ohne OCPP ueberlebt es.
func TestARefusedOrOcppLessDocumentAdmitsNothing(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	a.onChargingConfig([]byte(`{"schema_version":"2.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-fremd"}],
	  "published_at":"2026-08-21T09:15:00Z"}`))
	if _, ok := chargerOf(a, "saeule-fremd"); ok {
		t.Fatal("eine fremde Vertragsversion darf nichts eintragen")
	}
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"fremd","charge_points":[{"id":"saeule-fremd"}],
	  "published_at":"2026-08-21T09:15:00Z"}`))
	if _, ok := chargerOf(a, "saeule-fremd"); ok {
		t.Fatal("ein fremd adressiertes Dokument darf nichts eintragen")
	}

	ohne := &Agent{}
	ohne.entMu.Lock()
	ohne.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	ohne.entMu.Unlock()
	ohne.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-1"}],
	  "published_at":"2026-08-21T09:15:00Z"}`))
}

// --- Das LOESCHEN: eine eigene, ausdrueckliche Aussage ---------------------

// Die Captain-Order vom 24.08.2026 („Ebenso will ich die moeglichkeit haben
// eingebene kennungen zu loeschen"): das Portal nennt die Kennung AUSDRUECKLICH,
// und die Box nimmt sie aus der Freigabeliste.
func TestAnExplicitRemovalTakesTheStationOutOfTheAllowlist(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-1"},{"id":"saeule-2"}],
	  "published_at":"2026-08-24T09:15:00Z"}`))
	if _, ok := chargerOf(a, "saeule-2"); !ok {
		t.Fatal("Vorbedingung: beide Kennungen sind eingetragen")
	}

	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-1"}],
	  "removed_charge_point_ids":["saeule-2"],
	  "published_at":"2026-08-24T10:05:00Z"}`))

	if _, ok := chargerOf(a, "saeule-2"); ok {
		t.Fatal("die genannte Kennung muss aus der Freigabeliste sein")
	}
	if _, ok := chargerOf(a, "saeule-1"); !ok {
		t.Fatal("und die andere darf davon unberuehrt bleiben")
	}

	// ⚠ Die Grabstein-Liste reist in JEDEM folgenden Dokument mit, „schon
	// entfernt" ist also der Normalfall - und ein geraeuschloser No-op.
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-1"}],
	  "removed_charge_point_ids":["saeule-2","nie-gekannt"],
	  "published_at":"2026-08-24T10:10:00Z"}`))
	if _, ok := chargerOf(a, "saeule-1"); !ok {
		t.Fatal("eine wiederholte Loeschung darf nichts anderes anfassen")
	}
}

// ⚠ Steht eine Kennung im SELBEN Dokument in beiden Listen, gewinnt die
// LOESCHUNG - die Richtung, die weniger zulaesst. Das Portal sendet den Fall
// nie; ein Dokument aus einer anderen Quelle darf ihn nicht in eine Zulassung
// drehen.
func TestOnAContradictionTheStationIsNotAdmitted(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-widerspruch"}],
	  "removed_charge_point_ids":["saeule-widerspruch"],
	  "published_at":"2026-08-24T10:05:00Z"}`))
	if _, ok := chargerOf(a, "saeule-widerspruch"); ok {
		t.Fatal("eine widersprochene Kennung darf nicht hereinkommen")
	}
}

// Ein Dokument, das wir nicht verstehen oder das uns nicht meint, entfernt
// genauso wenig, wie es eintraegt - und eine Box ohne OCPP ueberlebt es.
func TestARefusedOrForeignDocumentRemovesNothing(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	if _, err := a.OcppAddCharger(csms.AddRequest{ID: "saeule-1"}); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{
		`{"schema_version":"2.0","tenant_id":"t","site_id":"s","device_id":"d",
		  "removed_charge_point_ids":["saeule-1"],"published_at":"2026-08-24T10:05:00Z"}`,
		`{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"fremd",
		  "removed_charge_point_ids":["saeule-1"],"published_at":"2026-08-24T10:05:00Z"}`,
		// Die Ruecknahme des ganzen Dokuments raeumt die Freigabeliste NICHT ab.
		``,
	} {
		a.onChargingConfig([]byte(payload))
		if _, ok := chargerOf(a, "saeule-1"); !ok {
			t.Fatalf("payload %q hat eine Kennung entfernt", payload)
		}
	}

	ohne := &Agent{}
	ohne.entMu.Lock()
	ohne.entIdentity = entities.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}
	ohne.entMu.Unlock()
	ohne.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","removed_charge_point_ids":["saeule-1"],
	  "published_at":"2026-08-24T10:05:00Z"}`))
}

// Cockpit Phase 1 / C1: der Anschluss reist mit - beim Anlegen UND danach.
//
// ⚠ Er ist die EINE Ausnahme von „ein bestehender Eintrag wird nicht
// überschrieben". Der Grund jener Regel ist, was ein Betreiber AN DER BOX
// gepflegt haben kann; für den Anschluss gibt es dort gar keine Oberfläche, es
// gibt also nichts zu schützen - und ein Kunde, der den Haken später setzt,
// erreichte die Box sonst nie.
func TestTheConnectionIsAdmittedAndAlsoUpdatedOnAKnownStation(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	if _, err := a.OcppAddCharger(csms.AddRequest{
		ID: "saeule-1", Label: "Am Geraet gepflegt", Priority: true,
	}); err != nil {
		t.Fatal(err)
	}

	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[
	    {"id":"saeule-1","label":"Aus dem Portal","connection":"eigen"},
	    {"id":"saeule-2","connection":"eigen"},
	    {"id":"saeule-3"}],
	  "published_at":"2026-08-28T09:15:00Z"}`))

	alt, ok := chargerOf(a, "saeule-1")
	if !ok {
		t.Fatal("der bestehende Eintrag darf nicht verschwinden")
	}
	if !alt.OwnConnection() {
		t.Fatalf("der Anschluss MUSS auch eine bekannte Saeule erreichen: %+v", alt)
	}
	// ... und sonst wird weiterhin NICHTS überschrieben.
	if alt.Label != "Am Geraet gepflegt" || !alt.Priority {
		t.Fatalf("nur der Anschluss ist die Ausnahme: %+v", alt)
	}

	neu, ok := chargerOf(a, "saeule-2")
	if !ok || !neu.OwnConnection() {
		t.Fatalf("eine neue Saeule bekommt ihn beim Anlegen: %+v", neu)
	}
	still, ok := chargerOf(a, "saeule-3")
	if !ok || still.OwnConnection() || still.ConnectionOrHaus() != csms.ConnectionHaus {
		t.Fatalf("ohne Angabe hinter dem Haus: %+v", still)
	}
}

// Bestand byte-gleich: ein Dokument OHNE das Feld - also jedes einer älteren
// Cloud - lässt den Anschluss einer bekannten Säule unangetastet.
func TestADocumentWithoutTheFieldLeavesTheConnectionAlone(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	if _, err := a.OcppAddCharger(csms.AddRequest{
		ID: "saeule-1", Connection: csms.ConnectionEigen,
	}); err != nil {
		t.Fatal(err)
	}
	a.onChargingConfig([]byte(`{"schema_version":"1.0","tenant_id":"t","site_id":"s",
	  "device_id":"d","charge_points":[{"id":"saeule-1","label":"x"}],
	  "published_at":"2026-08-28T09:20:00Z"}`))
	c, ok := chargerOf(a, "saeule-1")
	if !ok || !c.OwnConnection() {
		t.Fatalf("abwesend heisst 'nichts sagen', nicht 'haus': %+v", c)
	}
}

// Und der Herzschlag NENNT ihn - an der SÄULE, nicht je Stecker (eine
// Ladesäule hat EINEN Netzanschluss).
func TestTheHeartbeatNamesTheConnectionOfEachStation(t *testing.T) {
	a := chargingCfgAgent(t)
	ocppSite(t, a, 0)
	if _, err := a.OcppAddCharger(csms.AddRequest{ID: "haus-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.OcppAddCharger(csms.AddRequest{
		ID: "eigen-1", Connection: csms.ConnectionEigen,
	}); err != nil {
		t.Fatal(err)
	}
	sum := a.chargersSummary()
	if sum == nil || len(sum.Chargers) != 2 {
		t.Fatalf("summary = %+v", sum)
	}
	byID := map[string]string{}
	for _, c := range sum.Chargers {
		byID[c.ID] = c.Connection
	}
	// ⚠ Der AUFGELÖSTE Wert: die Karte und der Herzschlag sollen nicht beide
	// dieselbe Vorgabe-Regel führen.
	if byID["haus-1"] != csms.ConnectionHaus || byID["eigen-1"] != csms.ConnectionEigen {
		t.Fatalf("connections = %v", byID)
	}
}
