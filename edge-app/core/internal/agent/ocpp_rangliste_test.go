package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// Verbrauchsmanagement v1 / P6 — die RANGLISTE erreicht die Box, GEMESSEN AN
// DEN SÄULEN (die Ladeprofile, die der Kern wirklich installiert hat), nie an
// einer Quittung.

// tightSite ist ein Standort, an dem die Leistung wirklich knapp ist: die
// beiden 22-kW-Säulen können nicht beide voll laden.
func tightSite(t *testing.T, a *Agent, storageRank int, storage lastmgmt.StoragePriority) {
	t.Helper()
	set := lastmgmt.Settings{
		GridLimitKw: 30, MarginPct: 10, MinPowerKw: 4,
		RotationPeriod: 15 * time.Minute, MaxHouseLoadKw: 10,
		StorageRank: storageRank, StoragePriority: storage,
	}.WithDefaults()
	a.ocpp.mu.Lock()
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()
	if err := a.ocpp.store.Save(set); err != nil {
		t.Fatalf("save settings: %v", err)
	}
}

// rankStation registriert eine Säule MIT ihrer Rangliste-Position.
func rankStation(t *testing.T, a *Agent, id string, ratedKw float64, rank int) *ocppsim.Station {
	t.Helper()
	if _, err := a.ocpp.srv.Add(csms.AddRequest{ID: id, Connectors: 1, RatedKw: ratedKw, Rank: rank}); err != nil {
		t.Fatalf("register %s: %v", id, err)
	}
	st := ocppsim.New(ocppsim.Config{ID: id, Connectors: 1})
	if err := st.Connect(ocppEndpoint(a)); err != nil {
		t.Fatalf("station %s: %v", id, err)
	}
	t.Cleanup(st.Stop)
	waitUntil(t, "das CSMS sah "+id, func() bool {
		c, ok := a.ocpp.srv.Snapshot().ChargerByID(id)
		return ok && c.Connected && len(c.Connectors) == 1
	})
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: ratedKw, MinKw: 4}); err != nil {
		t.Fatalf("plug %s: %v", id, err)
	}
	return st
}

// TestTwoRankedStationsUnderScarcity: der Fall des Auftrags. Bei knapper
// Leistung bekommt die HÖHER eingeordnete Säule ihre volle Nachfrage, die
// andere den Rest — und die Anlage bleibt unter ihrem Budget.
func TestTwoRankedStationsUnderScarcity(t *testing.T) {
	a := ocppAgent(t, nil)
	tightSite(t, a, 0, lastmgmt.StorageBeforeCars)
	// 30 kW Anschluss − 10 % Abstand = 27 kW planbar, keine Gebäudereserve.
	erst := rankStation(t, a, "SAEULE-ERST", 22, 1)
	zweit := rankStation(t, a, "SAEULE-ZWEIT", 22, 2)
	a.ocpp.nudge()

	waitUntil(t, "die erstrangige Säule bekommt ihre volle Nachfrage", func() bool {
		w := findProfileSoft(erst, "TxProfile")
		return w > 21_900 && w < 22_100
	})
	nearKw(t, "Rang 1", findProfile(t, erst, "TxProfile")/1000, 22)
	// ⚠ NICHT-VAKUUM: die zweite Säule bekommt WAS ÜBRIG BLEIBT (27 − 22 = 5),
	// nicht nichts — der Rang ordnet, er sperrt nicht aus.
	waitUntil(t, "die zweitrangige Säule bekommt den Rest", func() bool {
		w := findProfileSoft(zweit, "TxProfile")
		return w > 4_900 && w < 5_100
	})
	nearKw(t, "Rang 2 bekommt den Rest", findProfile(t, zweit, "TxProfile")/1000, 5)

	if sum := (findProfile(t, erst, "TxProfile") + findProfileSoft(zweit, "TxProfile")) / 1000; sum > 27.05 {
		t.Fatalf("das Ladebudget wurde überschritten: %.3f kW", sum)
	}
}

// TestTheRanksSurviveARetainedConfigDocument: der Rang kommt aus dem Portal,
// und er wird auch auf einer SCHON BEKANNTEN Säule nachgezogen (die
// `connection`/`source`-Ausnahme).
func TestTheRanksSurviveARetainedConfigDocument(t *testing.T) {
	a := ocppAgent(t, nil)
	tightSite(t, a, 0, lastmgmt.StorageBeforeCars)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t1", SiteID: "s1", DeviceID: "d1"}
	a.entMu.Unlock()
	if _, err := a.ocpp.srv.Add(csms.AddRequest{ID: "SAEULE-A", Connectors: 1, RatedKw: 22}); err != nil {
		t.Fatalf("register: %v", err)
	}

	a.onChargingConfig([]byte(`{
      "schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
      "storage_rank":2,
      "charge_points":[{"id":"SAEULE-A","rank":1},{"id":"SAEULE-B","rank":3}],
      "published_at":"2026-08-31T09:00:00Z"}`))

	c, ok := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-A")
	if !ok || c.Rank != 1 {
		t.Fatalf("der Rang muss auch eine bekannte Säule erreichen: %+v", c)
	}
	b, ok := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-B")
	if !ok || b.Rank != 3 {
		t.Fatalf("eine neu eingetragene Säule bringt ihren Rang mit: %+v", b)
	}
	if got := a.ocpp.currentSettings().StorageRank; got != 2 {
		t.Fatalf("der Speicher-Rang muss ankommen, got %d", got)
	}
}

// TestADocumentWithoutRanksLeavesTheStationsAlone ist die
// Kompatibilitäts-Zusage auf der Anwendungs-Seite: ein Dokument, das keine
// Ordnung nennt, nimmt einer Säule ihre gepflegte nicht weg.
func TestADocumentWithoutRanksLeavesTheStationsAlone(t *testing.T) {
	a := ocppAgent(t, nil)
	tightSite(t, a, 4, lastmgmt.StorageBeforeCars)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t1", SiteID: "s1", DeviceID: "d1"}
	a.entMu.Unlock()
	if _, err := a.ocpp.srv.Add(csms.AddRequest{ID: "SAEULE-A", Connectors: 1, RatedKw: 22, Rank: 2}); err != nil {
		t.Fatalf("register: %v", err)
	}
	a.onChargingConfig([]byte(`{
      "schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
      "charge_points":[{"id":"SAEULE-A"}],
      "published_at":"2026-08-31T09:00:00Z"}`))

	c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-A")
	if c.Rank != 2 {
		t.Fatalf("ein Dokument ohne Rang darf keinen löschen, got %d", c.Rank)
	}
	if got := a.ocpp.currentSettings().StorageRank; got != 4 {
		t.Fatalf("ebenso der Speicher-Rang, got %d", got)
	}
}

// TestTheStorageSplitFollowsTheRanglistePosition: eine Säule ÜBER dem Speicher
// greift am Speicher vorbei, eine darunter nicht — und die BATTERIE-Klemme
// folgt derselben EINEN Ableitung.
func TestTheStorageSplitFollowsTheRanglistePosition(t *testing.T) {
	a := ocppAgent(t, nil)
	// Speicher auf Platz 2: „oben" (Rang 1) steht darüber, „unten" (Rang 3)
	// darunter. Die site-weite Vorgabe sagt ausdrücklich das GEGENTEIL
	// („speicher_vor_auto"), damit der Fall nicht versehentlich besteht.
	tightSite(t, a, 2, lastmgmt.StorageBeforeCars)

	sessions, _ := ocppSessions(csms.Snapshot{Chargers: []csms.ChargerState{
		{Charger: csms.Charger{ID: "OBEN", RatedKw: 22, Rank: 1}, Connected: true,
			Connectors: []csms.Connector{{ID: 1, Status: csms.StatusCharging, Session: &csms.Session{}}}},
		{Charger: csms.Charger{ID: "UNTEN", RatedKw: 22, Rank: 3}, Connected: true,
			Connectors: []csms.Connector{{ID: 1, Status: csms.StatusCharging, Session: &csms.Session{}}}},
	}}, 27, a.ocpp.currentSettings())

	byKey := map[string]bool{}
	for _, s := range sessions {
		byKey[s.Key] = s.BeforeStorage
	}
	if !byKey["OBEN#1"] {
		t.Fatal("die Säule über dem Speicher muss am Speicher vorbeigreifen dürfen")
	}
	if byKey["UNTEN#1"] {
		t.Fatal("die Säule unter dem Speicher darf es nicht")
	}
}

// TestTheBatteryCapIsDueWheneverAChargePointSitsAboveIt: die zweite Hälfte von
// „Auto vor Speicher" folgt derselben Ordnung — nicht mehr allein der
// anlagenweiten Wahl.
func TestTheBatteryCapIsDueWheneverAChargePointSitsAboveIt(t *testing.T) {
	a := ocppAgent(t, nil)
	tightSite(t, a, 2, lastmgmt.StorageBeforeCars)
	set := a.ocpp.currentSettings()
	now := time.Now()

	// Ohne einen Ladepunkt über dem Speicher gibt es nichts zu klemmen.
	if _, _, any := a.carsBeforeStorageKw(set, now); any {
		t.Fatal("ohne Ladepunkt über dem Speicher darf die Klemme nicht fällig sein")
	}
	if _, ok := a.OcppBatteryChargeCap(now); ok {
		t.Fatal("und die Klemme selbst erst recht nicht")
	}

	// Mit einer eingeordneten Säule ÜBER dem Speicher schon.
	if _, err := a.ocpp.srv.Add(csms.AddRequest{ID: "OBEN", Connectors: 1, RatedKw: 22, Rank: 1}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, _, any := a.carsBeforeStorageKw(a.ocpp.currentSettings(), now); !any {
		t.Fatal("eine Säule über dem Speicher macht die Klemme fällig")
	}
}
