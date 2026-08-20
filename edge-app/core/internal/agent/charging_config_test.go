package agent

import (
	"testing"

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
