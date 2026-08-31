package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/goe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// Verbrauchsmanagement v1 / P6 — die go-e-WALLBOX tritt dem Ladepark-Rahmen
// bei: EINE Anschlussgrenze, EINE Quellen-Bahn, EINE Rangliste, zwei
// Protokolle.

const wbEntity = "11111111-2222-3333-4444-555555555555"

// wallboxSite richtet einen Standort mit genau EINER Wallbox im Rahmen ein.
func wallboxSite(t *testing.T, a *Agent, w lastmgmt.Wallbox, storageRank int) lastmgmt.Settings {
	t.Helper()
	set := lastmgmt.Settings{
		GridLimitKw: 30, MarginPct: 10, MinPowerKw: 4,
		RotationPeriod: 15 * time.Minute, MaxHouseLoadKw: 10,
		StorageRank: storageRank,
		Wallboxes:   []lastmgmt.Wallbox{w},
	}.WithDefaults()
	a.ocpp.mu.Lock()
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()
	if err := a.ocpp.store.Save(set); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	return set
}

// wallboxMeasures gibt der Wallbox-Entität einen frischen eigenen Messwert.
func wallboxMeasures(a *Agent, kw float64, now time.Time) {
	a.entMu.Lock()
	if a.entReadings == nil {
		a.entReadings = map[string]entReading{}
	}
	a.entReadings[wbEntity] = entReading{
		channels: map[string]float64{"power_kw": kw}, ts: now, recv: now,
	}
	a.entMu.Unlock()
}

// wallboxGranted lässt den Arbiter der Wallbox einen Sollwert erteilen.
func wallboxGranted(t *testing.T, a *Agent, kw float64) {
	t.Helper()
	maxKw := 11.0
	reg := entities.Registry{Revision: "rev-wb", Entities: []entities.Entity{{
		ID: wbEntity, Type: entities.TypeWallbox, Label: "Wallbox Garage",
		Capabilities: entities.Capabilities{
			Measure: []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}},
			Actuate: []entities.ActuateCap{
				{Command: entities.CmdSetpointKw, Min: ptr(0), Max: ptr(11)},
				{Command: entities.CmdOnOff},
			},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw},
			Failsafe: entities.Failsafe{Behavior: "release"},
		},
	}}}
	arb := minimalArbiter(reg)
	arb.SubmitInternal(&desired.Desired{
		EntityID: wbEntity, RequestID: "req-wb",
		Source:        desired.Source{Kind: desired.SourceFlow, FlowID: "f1", NodeID: "n1"},
		Priority:      desired.ClassFlow,
		TTL:           time.Hour,
		IssuedAt:      time.Now().UTC(),
		Commands:      entities.Commands{SetpointKw: ptr(kw)},
		RequestedType: entities.CmdSetpointKw,
	})
	arb.Tick()
	a.entMu.Lock()
	a.entRegistry = reg
	a.entMu.Unlock()
	a.arb = arb
}

// TestAWallboxWithoutAMeasurementNeverTakesPartAndIsNamed: die ehrliche Hälfte
// von §4.3 — ohne Leistungsmessung kein Budget-Beitrag, keine Deckelung, und
// die Box SAGT es.
func TestAWallboxWithoutAMeasurementNeverTakesPartAndIsNamed(t *testing.T) {
	a := ocppAgent(t, nil)
	set := wallboxSite(t, a, lastmgmt.Wallbox{EntityID: wbEntity, RatedKw: 11, MinKw: 4.2, Rank: 1}, 0)
	wallboxGranted(t, a, 11)
	now := time.Now()

	if s := a.wallboxSessions(set, 27, now); len(s) != 0 {
		t.Fatalf("ohne Messung darf sie nicht mitspielen: %+v", s)
	}
	if kw := a.wallboxChargingKw(set, now); kw != 0 {
		t.Fatalf("ohne Messung wird nichts zurückaddiert, got %v", kw)
	}
	if note := a.WallboxNote(wbEntity); note == "" {
		t.Fatal("eine nicht teilnehmende Wallbox muss BENANNT werden")
	}
	// Und sie wird auch nicht gedeckelt: das erteilte Kommando bleibt, wie es ist.
	cmd := a.capWallboxCommand(wbEntity, goe.Command{SetpointKw: ptr(11)})
	if cmd.SetpointKw == nil || *cmd.SetpointKw != 11 {
		t.Fatalf("ohne Teilnahme darf nichts gedeckelt werden: %+v", cmd)
	}
}

// TestAWallboxWithoutALiveCommandStaysBuildingLoad: die zweite Hälfte der
// Teilnahme-Regel — was wir nicht deckeln können, darf auch nicht ins Budget
// zurückaddiert werden.
func TestAWallboxWithoutALiveCommandStaysBuildingLoad(t *testing.T) {
	a := ocppAgent(t, nil)
	set := wallboxSite(t, a, lastmgmt.Wallbox{EntityID: wbEntity, RatedKw: 11, MinKw: 4.2, Rank: 1}, 0)
	now := time.Now()
	wallboxMeasures(a, 7.4, now) // sie misst, aber niemand steuert sie

	if s := a.wallboxSessions(set, 27, now); len(s) != 0 {
		t.Fatalf("ohne erteilten Befehl darf sie nicht mitspielen: %+v", s)
	}
	if kw := a.wallboxChargingKw(set, now); kw != 0 {
		t.Fatalf("ohne erteilten Befehl wird nichts zurückaddiert, got %v", kw)
	}
	if note := a.WallboxNote(wbEntity); note == "" {
		t.Fatal("auch dieser Fall muss benannt werden")
	}
}

// TestAClaimingWallboxTakesBudgetAndIsCapped: der Fall des Auftrags — die
// go-e nimmt dem Ladepark Budget weg und wird über den BESTEHENDEN
// Verbraucher-Sollwert gedeckelt, nie über OCPP.
func TestAClaimingWallboxTakesBudgetAndIsCapped(t *testing.T) {
	a := ocppAgent(t, nil)
	set := wallboxSite(t, a, lastmgmt.Wallbox{EntityID: wbEntity, RatedKw: 11, MinKw: 4.2, Rank: 1}, 0)
	wallboxGranted(t, a, 11)
	now := time.Now()
	wallboxMeasures(a, 7.4, now)

	// Sie ist eine virtuelle Sitzung mit ihrer Rangliste-Position.
	sessions := a.wallboxSessions(set, 27, now)
	if len(sessions) != 1 {
		t.Fatalf("erwartet genau eine virtuelle Sitzung, got %+v", sessions)
	}
	if sessions[0].Key != lastmgmt.WallboxKey(wbEntity) || sessions[0].Rank != 1 {
		t.Fatalf("Schlüssel/Rang falsch: %+v", sessions[0])
	}
	if sessions[0].Priority {
		t.Fatal("eine Wallbox hat keinen Vorrang-Satz - ihr Platz ist ihr Rang")
	}
	// ⚠ Und ihre gemessene Leistung wird ins Budget zurückaddiert — sonst
	// schwänge die Schleife (sie steckt schon im gemessenen Netzbezug).
	if kw := a.wallboxChargingKw(set, now); kw != 7.4 {
		t.Fatalf("die gemessene Leistung muss zurückaddiert werden, got %v", kw)
	}

	// Der Verteiler entscheidet: die Anlage hat 27 kW, eine 22-kW-Säule steht
	// auf Rang 2 - der Wallbox auf Rang 1 gehören ihre 11 kW.
	plan := lastmgmt.Decide(lastmgmt.Input{
		Settings: set, BudgetKw: ptr(27), Now: now,
		Sessions: append(sessions, lastmgmt.Session{
			Key: "SAEULE#1", MinKw: 4, MaxKw: 22, Rank: 2, Since: now,
		}),
	})
	a.noteWallboxCaps(plan)
	cap, ok := a.WallboxCapKw(wbEntity)
	if !ok {
		t.Fatal("die Wallbox muss eine Zuteilung bekommen")
	}
	nearKw(t, "Wallbox", cap, 11)
	if got, _ := plan.Get("SAEULE#1"); got.Kw > 16.05 {
		t.Fatalf("die Säule bekommt nur den Rest: %+v", got)
	}

	// Der Deckel wirkt RESTRICT-ONLY auf dem bestehenden Verbraucher-Weg.
	cmd := a.capWallboxCommand(wbEntity, goe.Command{SetpointKw: ptr(11)})
	if cmd.SetpointKw == nil || *cmd.SetpointKw != 11 {
		t.Fatalf("ein Deckel über dem Befehl ändert nichts: %+v", cmd)
	}
}

// TestTheWallboxCapIsRestrictOnlyAndAZeroPauses.
func TestTheWallboxCapIsRestrictOnlyAndAZeroPauses(t *testing.T) {
	a := ocppAgent(t, nil)
	set := wallboxSite(t, a, lastmgmt.Wallbox{EntityID: wbEntity, RatedKw: 11, MinKw: 4.2, Rank: 5}, 0)
	wallboxGranted(t, a, 11)
	now := time.Now()
	wallboxMeasures(a, 7.4, now)

	// Ein Standort, an dem eine erstrangige 22-kW-Säule den Löwenanteil nimmt:
	// der Wallbox auf Rang 5 bleiben 27 − 22 = 5 kW.
	plan := lastmgmt.Decide(lastmgmt.Input{
		Settings: set, BudgetKw: ptr(27), Now: now,
		Sessions: append(a.wallboxSessions(set, 27, now), lastmgmt.Session{
			Key: "SAEULE#1", MinKw: 4, MaxKw: 22, Rank: 1, Since: now,
		}),
	})
	a.noteWallboxCaps(plan)

	cmd := a.capWallboxCommand(wbEntity, goe.Command{SetpointKw: ptr(11)})
	if cmd.SetpointKw == nil || *cmd.SetpointKw > 5.01 {
		t.Fatalf("der Deckel muss den Sollwert senken: %+v", cmd.SetpointKw)
	}
	if cmd.OnOff != nil {
		t.Fatal("ein Deckel über 0 schaltet nichts aus")
	}
	// ⚠ RESTRICT-ONLY: ein Befehl UNTER dem Deckel wird NICHT angehoben.
	cmd = a.capWallboxCommand(wbEntity, goe.Command{SetpointKw: ptr(3)})
	if cmd.SetpointKw == nil || *cmd.SetpointKw != 3 {
		t.Fatalf("der Deckel darf nie anheben: %+v", cmd.SetpointKw)
	}

	// Und bei einer Zuteilung von 0 pausiert sie - „pausieren statt
	// aushungern", auf dem Verbraucher-Weg ausgedrückt.
	a.wallbox.mu.Lock()
	a.wallbox.caps = map[string]float64{wbEntity: 0}
	a.wallbox.mu.Unlock()
	on := true
	cmd = a.capWallboxCommand(wbEntity, goe.Command{SetpointKw: ptr(11), OnOff: &on})
	if cmd.OnOff == nil || *cmd.OnOff || cmd.SetpointKw == nil || *cmd.SetpointKw != 0 {
		t.Fatalf("eine Zuteilung von 0 muss die Wallbox pausieren: %+v", cmd)
	}
}

// TestASiteWithoutWallboxesIsByteForBytePreP6: die Kompatibilitäts-Zusage.
func TestASiteWithoutWallboxesIsByteForBytePreP6(t *testing.T) {
	a := ocppAgent(t, nil)
	set := lastmgmt.Settings{GridLimitKw: 30, MarginPct: 10, MinPowerKw: 4}.WithDefaults()
	now := time.Now()
	wallboxMeasures(a, 7.4, now)
	wallboxGranted(t, a, 11)

	if s := a.wallboxSessions(set, 27, now); s != nil {
		t.Fatalf("ohne wallboxes[] entsteht keine Sitzung: %+v", s)
	}
	if kw := a.wallboxChargingKw(set, now); kw != 0 {
		t.Fatalf("ohne wallboxes[] wird nichts zurückaddiert, got %v", kw)
	}
	if _, ok := a.WallboxCapKw(wbEntity); ok {
		t.Fatal("ohne wallboxes[] gibt es keinen Deckel")
	}
	cmd := a.capWallboxCommand(wbEntity, goe.Command{SetpointKw: ptr(11)})
	if cmd.SetpointKw == nil || *cmd.SetpointKw != 11 {
		t.Fatalf("und das Kommando bleibt unangetastet: %+v", cmd)
	}
}

// TestAWallboxInTheRahmenRidesTheRetainedDocument: der Weg vom Portal auf die
// Box - PATCH wie überall, und eine LEERE Liste ist die Aussage „keine Wallbox".
func TestAWallboxInTheRahmenRidesTheRetainedDocument(t *testing.T) {
	a := ocppAgent(t, nil)
	a.entMu.Lock()
	a.entIdentity = entities.Identity{TenantID: "t1", SiteID: "s1", DeviceID: "d1"}
	a.entMu.Unlock()

	a.onChargingConfig([]byte(`{
      "schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
      "storage_rank":3,
      "wallboxes":[{"entity_id":"` + wbEntity + `","label":"Wallbox Garage","rated_kw":11,"min_kw":4.2,"rank":1,"source":"sonne_zuerst"}],
      "published_at":"2026-08-31T09:00:00Z"}`))
	set := a.ocpp.currentSettings()
	if len(set.Wallboxes) != 1 || set.Wallboxes[0].EntityID != wbEntity ||
		set.Wallboxes[0].Rank != 1 || set.Wallboxes[0].Source != lastmgmt.PolicySolarFirst {
		t.Fatalf("die Wallbox muss ankommen: %+v", set.Wallboxes)
	}

	// Ein Dokument OHNE die Liste lässt sie stehen (PATCH).
	a.onChargingConfig([]byte(`{
      "schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
      "grid_limit_kw":44,"published_at":"2026-08-31T09:05:00Z"}`))
	if len(a.ocpp.currentSettings().Wallboxes) != 1 {
		t.Fatal("ein Dokument ohne die Liste darf sie nicht löschen")
	}

	// Eine LEERE Liste ist dagegen die Aussage „keine Wallbox nimmt teil".
	a.onChargingConfig([]byte(`{
      "schema_version":"1.0","tenant_id":"t1","site_id":"s1","device_id":"d1",
      "wallboxes":[],"published_at":"2026-08-31T09:10:00Z"}`))
	if len(a.ocpp.currentSettings().Wallboxes) != 0 {
		t.Fatal("eine leere Liste ist eine Aussage und wird angewandt")
	}
}

// TestAWallboxAboveTheStorageReachesPastTheBattery: der Speicher-Split gilt
// für sie wie für jede Säule.
func TestAWallboxAboveTheStorageReachesPastTheBattery(t *testing.T) {
	a := ocppAgent(t, nil)
	set := wallboxSite(t, a, lastmgmt.Wallbox{EntityID: wbEntity, RatedKw: 11, Rank: 1}, 2)
	wallboxGranted(t, a, 11)
	now := time.Now()
	wallboxMeasures(a, 7.4, now)

	s := a.wallboxSessions(set, 27, now)
	if len(s) != 1 || !s[0].BeforeStorage {
		t.Fatalf("Rang 1 über einem Speicher auf Platz 2 greift am Speicher vorbei: %+v", s)
	}
	// Und ihre Leistung zählt in die Klemme des Speichers.
	kw, complete, any := a.carsBeforeStorageKw(set, now)
	if !any || !complete || kw != 7.4 {
		t.Fatalf("die Wallbox über dem Speicher zählt in die Klemme: %v %v %v", kw, complete, any)
	}
}

// TestAnUnknownStationIsNeverReadAsAWallbox: die Schlüssel können nicht
// kollidieren.
func TestAnUnknownStationIsNeverReadAsAWallbox(t *testing.T) {
	a := ocppAgent(t, nil)
	a.noteWallboxCaps(lastmgmt.Plan{Allocations: []lastmgmt.Allocation{
		{Key: "SAEULE-HOF#1", Kw: 11},
		{Key: lastmgmt.WallboxKey(wbEntity), Kw: 4.2},
	}})
	if _, ok := a.WallboxCapKw("SAEULE-HOF#1"); ok {
		t.Fatal("eine OCPP-Kennung darf nie als Wallbox-Deckel auftauchen")
	}
	if kw, ok := a.WallboxCapKw(wbEntity); !ok || kw != 4.2 {
		t.Fatalf("die Wallbox aber schon: %v %v", kw, ok)
	}
	_ = csms.Snapshot{}
}
