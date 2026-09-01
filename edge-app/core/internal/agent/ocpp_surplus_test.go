package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// This file proves the STUFE-4 wiring AT THE STATIONS: what the vehicles are
// actually allowed to draw, read out of the charging profiles the box really
// installed - never a receipt.

// ocppPolicy stores a source choice the way the setup surface would.
func ocppPolicy(t *testing.T, a *Agent, policy lastmgmt.SurplusPolicy, storage lastmgmt.StoragePriority) {
	t.Helper()
	p, s := string(policy), string(storage)
	if _, err := a.OcppSaveSettings(lastmgmt.SettingsRequest{
		SurplusPolicy: &p, StoragePriority: &s,
	}); err != nil {
		t.Fatalf("save policy: %v", err)
	}
}

// measureSurplus feeds ONE paired measurement of an EXPORTING site: the
// building draws houseKw, the plant produces pvKw, the battery takes battKw,
// and the vehicles take whatever they are measured taking - so the grid value
// is exactly what a real meter at the connection point would see.
func measureSurplus(t *testing.T, a *Agent, houseKw, pvKw, battKw float64, stations ...*ocppsim.Station) {
	t.Helper()
	publishAndSettle(t, a, stations...)
	now := time.Now().UTC()
	charging, _ := a.ocpp.srv.Snapshot().ChargingTotal(now, ocppMeterMaxAge)
	// ⚠ Die Batterie wird als ARGUMENT uebergeben, nicht ueber die Messwert-
	// Karte: genau so kommt sie auch im Betrieb an (onLocalTelemetry parst sie
	// als internen Kanal). Dass die Verdrahtung wirklich haelt, prueft
	// TestTheBatteryReachesTheSurplusSplitThroughTheRealTelemetryPath - hier
	// wird die REGEL geprueft, dort der WEG.
	batt := battKw
	a.ocppObserve(now, map[string]float64{
		"power_kw": houseKw + battKw + charging - pvKw,
	}, &batt)
}

// TestNurSonnenstromCapsTheVehiclesAtTheMeasuredSurplus is the headline of the
// stage, measured where it counts: the connection is wide open, and the cars
// still only get what the sun offers.
func TestNurSonnenstromCapsTheVehiclesAtTheMeasuredSurplus(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0) // 249,3 kW physically free
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	// PV 120, building 20 -> 100 kW would leave the site if nobody charged.
	for i := 0; i < 4; i++ {
		measureSurplus(t, a, 20, 120, 0, s1)
		a.ocppStep(context.Background())
		info := a.State.Get().Ocpp
		if !info.SurplusActive || info.SurplusMode != string(lastmgmt.SurplusMeasured) {
			t.Fatalf("pass %d: the source lane is not measured (%q / %s)", i, info.SurplusMode, info.SurplusNote)
		}
		nearKw(t, "the physical budget stays wide", info.BudgetKw, 249.3)
		nearKw(t, "the car draws the surplus, not the connection", s1.DrawKw(1), 100)
	}
	if note := a.State.Get().Ocpp.SurplusNote; !strings.Contains(note, "Nur Sonnenstrom") {
		t.Fatalf("the sentence must name the customer's own priority: %q", note)
	}
}

// TestWithoutASourceChoiceTheStationsAreByteForByteStufe3 is the compatibility
// promise: the SAME site, the SAME sun, and the untouched default lets the
// vehicle take the whole connection.
func TestWithoutASourceChoiceTheStationsAreByteForByteStufe3(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	for i := 0; i < 3; i++ {
		measureSurplus(t, a, 20, 120, 0, s1)
		a.ocppStep(context.Background())
	}
	if info := a.State.Get().Ocpp; info.SurplusActive {
		t.Fatalf("a site nobody asked must have no source lane: %+v", info.SurplusNote)
	}
	// Its own nameplate is now the only ceiling (249,3 kW would be free).
	nearKw(t, "the car keeps everything its station can deliver", s1.DrawKw(1), 240)
}

// TestJetztVollLadenExemptsOneSessionAndSaysSo - the override, measured.
func TestJetztVollLadenExemptsOneSessionAndSaysSo(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	// No sun at all: „Nur Sonnenstrom" pauses the vehicle, with ITS OWN word.
	for i := 0; i < 2; i++ {
		measureSurplus(t, a, 20, 0, 0, s1)
		a.ocppStep(context.Background())
	}
	nearKw(t, "paused without sun", s1.DrawKw(1), 0)
	if con := ocppConnectorView(t, a, "SAEULE-1", 1); con.Reason != lastmgmt.ReasonNoSurplus {
		t.Fatalf("reason = %q, want the source word", con.Reason)
	} else if !strings.Contains(con.ReasonText, "Nur Sonnenstrom") {
		t.Fatalf("the sentence must name the customer's lever: %q", con.ReasonText)
	}

	res, err := a.OcppBoost(lastmgmt.BoostRequest{ChargePointID: "SAEULE-1", Connector: 1})
	if err != nil {
		t.Fatalf("boost: %v", err)
	}
	if !res.Active || !strings.Contains(res.Note, "Anschlussgrenze") {
		t.Fatalf("the confirmation must say what stays: %+v", res)
	}
	measureSurplus(t, a, 20, 0, 0, s1)
	a.ocppStep(context.Background())
	// 249,3 kW planable minus the 20 kW the building is MEASURED taking - the
	// physical budget still binds a boosted session, which is exactly the
	// dialog's third consequence.
	nearKw(t, "the boosted car draws the connection budget", s1.DrawKw(1), 229.3)
	if con := ocppConnectorView(t, a, "SAEULE-1", 1); !con.Boost {
		t.Fatal("the surface must show that this charge is an override")
	}

	// And it ends when the customer says so.
	if _, err := a.OcppBoost(lastmgmt.BoostRequest{
		ChargePointID: "SAEULE-1", Connector: 1, Cancel: true,
	}); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	measureSurplus(t, a, 20, 0, 0, s1)
	a.ocppStep(context.Background())
	nearKw(t, "back to the customer's priority", s1.DrawKw(1), 0)
}

// TestABoostBelongsToItsSession - „bis das Fahrzeug voll ist" ends when its
// session does; the next vehicle must not inherit a grid charge.
func TestABoostBelongsToItsSession(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	if _, err := a.OcppBoost(lastmgmt.BoostRequest{ChargePointID: "SAEULE-1", Connector: 1}); err != nil {
		t.Fatalf("boost: %v", err)
	}
	if err := s1.Unplug(1); err != nil {
		t.Fatalf("unplug: %v", err)
	}
	waitUntil(t, "the session ended", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 0
	})
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("re-plug: %v", err)
	}
	waitUntil(t, "the NEW session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
	for i := 0; i < 2; i++ {
		measureSurplus(t, a, 20, 0, 0, s1)
		a.ocppStep(context.Background())
	}
	nearKw(t, "the next vehicle keeps the customer's priority", s1.DrawKw(1), 0)
}

// TestABoostIsRefusedOnAnEmptyPlug - a promise about a vehicle that is not
// there would be invented.
func TestABoostIsRefusedOnAnEmptyPlug(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	ocppStation(t, a, "SAEULE-1", 1, 240)
	if _, err := a.OcppBoost(lastmgmt.BoostRequest{ChargePointID: "SAEULE-1", Connector: 1}); err == nil {
		t.Fatal("an empty plug must be refused")
	}
	if _, err := a.OcppBoost(lastmgmt.BoostRequest{}); err == nil {
		t.Fatal("a request without a session must be refused")
	}
}

// TestAutoVorSpeicherCapsTheBatteryAndNothingElse is the OTHER half of the
// cars-first choice: without it the customer's decision would be a wish.
func TestAutoVorSpeicherCapsTheBatteryAndNothingElse(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	s1 := ocppStation(t, a, "SAEULE-1", 1, 240)
	if err := s1.Plug(1, ocppsim.Vehicle{DemandKw: 240, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "the session is known", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	// Storage-first (the default): the battery keeps its 20 kW and the cars
	// get what is left - and the battery is NOT capped.
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	for i := 0; i < 3; i++ {
		measureSurplus(t, a, 20, 120, 20, s1)
		a.ocppStep(context.Background())
	}
	nearKw(t, "cars get the remainder", s1.DrawKw(1), 80)
	if _, ok := a.OcppBatteryChargeCap(time.Now().UTC()); ok {
		t.Fatal("storage-first must never touch the battery")
	}

	// Cars-first: the vehicles claim the battery's share too, and the battery
	// is capped at what they leave.
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.CarsBeforeStorage)
	for i := 0; i < 3; i++ {
		measureSurplus(t, a, 20, 120, 20, s1)
		a.ocppStep(context.Background())
	}
	nearKw(t, "cars get the whole surplus", s1.DrawKw(1), 100)
	cap, ok := a.OcppBatteryChargeCap(time.Now().UTC())
	if !ok {
		t.Fatal("cars-first with a measured surplus must cap the battery")
	}
	// The cars are MEASURED at their previous 80 kW while they ramp, so the cap
	// is what is left of the 100 kW surplus - never negative, never a guess.
	if cap < 0 || cap > 100 {
		t.Fatalf("battery cap %v kW is outside the measured surplus", cap)
	}
}

// TestTheBatteryCapIsRestrictOnlyAndChargeOnly - it can never raise a setpoint
// and never touch a discharge, so no guard above it can be violated by it.
func TestTheBatteryCapIsRestrictOnlyAndChargeOnly(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0)
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.CarsBeforeStorage)
	// No station, no vehicle drawing -> nothing to take from the battery.
	if _, ok := a.OcppBatteryChargeCap(time.Now().UTC()); ok {
		t.Fatal("without a charging vehicle the battery is not ours to cap")
	}
	// And a box with the feature off never caps at all.
	b := &Agent{}
	if _, ok := b.OcppBatteryChargeCap(time.Now().UTC()); ok {
		t.Fatal("a box without charge points must not cap its battery")
	}
}

// ocppConnectorView reads ONE plug out of the surface the page renders.
func ocppConnectorView(t *testing.T, a *Agent, chargerID string, connector int) (out struct {
	Reason     string
	ReasonText string
	Boost      bool
}) {
	t.Helper()
	info := a.State.Get().Ocpp
	if info == nil {
		t.Fatal("no ocpp view")
	}
	for _, c := range info.Chargers {
		if c.ID != chargerID {
			continue
		}
		for _, con := range c.Connectors {
			if con.ID == connector {
				out.Reason, out.ReasonText, out.Boost = con.Reason, con.ReasonText, con.Boost
				return out
			}
		}
	}
	t.Fatalf("connector %s#%d not in the view", chargerID, connector)
	return out
}

// TestTheBatteryReachesTheSurplusSplitThroughTheRealTelemetryPath is the guard
// for the seam every other test in this file skips.
//
// ⚠ Der Kanal `battery_power_kw` wird in `onLocalTelemetry` bewusst NICHT in
// die Messwert-Karte gelegt (er ist ein interner Kanal, kein veroeffentlichter
// Messwert). Die Speicher-Arbitrierung las ihn aber genau von dort - sie war
// damit auf JEDER echten Box tot, waehrend die Tests hier ihre Karte von Hand
// fuellten und gruen blieben. Aufgefallen ist es am Rig (L8), nicht im Test.
// Dieser Fall faehrt deshalb den ECHTEN Weg: rohe Telemetrie hinein, und die
// Frage ist allein, ob der Speicher in der Aufteilung ankommt.
func TestTheBatteryReachesTheSurplusSplitThroughTheRealTelemetryPath(t *testing.T) {
	a := fullOcppAgent(t)
	ocppSite(t, a, 0)
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)

	// Kleine Schritte aus dem kalten Start: der Despiker haelt einen grossen
	// Sprung zwischen zwei Messungen fest, und dieser Fall prueft die
	// VERDRAHTUNG, nicht die Regel.
	//
	// Der Standort speist 10 kW ein, waehrend der Speicher 4 kW nimmt: der
	// ganze Ueberschuss ist also 14 kW, und die Fahrzeuge bekommen bei
	// „Speicher vor Auto" die 10 kW, die uebrig bleiben.
	for i := 0; i < 2; i++ {
		a.onLocalTelemetry("edge/telemetry",
			[]byte(`{"power_kw":-10,"battery_power_kw":4}`))
	}

	v := a.ocpp.budget.Surplus(time.Now().UTC(),
		lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	if !v.Active || v.Mode != lastmgmt.SurplusMeasured {
		t.Fatalf("die Quellen-Bahn misst nicht (%q / %s)", v.Mode, v.Reason)
	}
	if v.BatteryKw == nil {
		t.Fatal("der Speicher ist in der Aufteilung nicht angekommen - " +
			"genau der Fehler, den das Rig gefunden hat")
	}
	nearKw(t, "der gemeldete Speicher", *v.BatteryKw, 4)
	if v.TotalKw == nil {
		t.Fatal("ohne Gesamt-Ueberschuss kann keine Prioritaet etwas bewegen")
	}
	nearKw(t, "der ganze Ueberschuss", *v.TotalKw, 14)
	nearKw(t, "was den Fahrzeugen bleibt", v.Kw, 10)

	// Und die Gegenprobe: dieselbe Messung OHNE den Kanal darf keinen Speicher
	// behaupten - unbekannt ist nie eine gemessene Null.
	b := fullOcppAgent(t)
	ocppSite(t, b, 0)
	ocppPolicy(t, b, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	for i := 0; i < 2; i++ {
		b.onLocalTelemetry("edge/telemetry", []byte(`{"power_kw":-10}`))
	}
	w := b.ocpp.budget.Surplus(time.Now().UTC(),
		lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	if w.BatteryKw != nil {
		t.Fatalf("ohne gemeldeten Kanal wird ein Speicher behauptet (%v kW)", *w.BatteryKw)
	}
	nearKw(t, "ohne Speicher ist der ganze Ueberschuss das, was ankommt", w.Kw, 10)
}

// fullOcppAgent baut einen VOLLSTAENDIGEN Agenten (nicht die schmale
// Test-Attrappe der uebrigen Faelle): nur er hat die Gates, durch die eine
// echte Telemetrie-Nachricht laeuft - und genau darum geht es hier.
func fullOcppAgent(t *testing.T) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.OcppEnabled = true
	cfg.OcppPort = 0
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// ⚠ Ein EIGENER, kuendbarer Kontext: `Stop()` wartet auf die Goroutinen des
	// Agenten, und die OCPP-Schleife endet allein an ihrem Kontext. Mit
	// context.Background() wartet der Test hier fuer immer. Aufraeumer laufen
	// LIFO, also wird zuerst gekuendigt und dann gestoppt.
	ctx, cancel := context.WithCancel(context.Background())
	if err := a.startOcpp(ctx); err != nil {
		cancel()
		t.Fatalf("startOcpp: %v", err)
	}
	t.Cleanup(a.Stop)
	t.Cleanup(cancel)
	return a
}
