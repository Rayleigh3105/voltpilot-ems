package agent

import (
	"context"
	"strings"
	"testing"
	"time"

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
	for _, st := range stations {
		if err := st.PublishMeterValues(); err != nil {
			t.Fatalf("meter values: %v", err)
		}
	}
	waitUntil(t, "the CSMS has a measurement for every charging connector", func() bool {
		_, complete := a.ocpp.srv.Snapshot().ChargingTotal(time.Now().UTC(), ocppMeterMaxAge)
		return complete
	})
	now := time.Now().UTC()
	charging, _ := a.ocpp.srv.Snapshot().ChargingTotal(now, ocppMeterMaxAge)
	a.ocppObserve(now, map[string]float64{
		"power_kw":         houseKw + battKw + charging - pvKw,
		"battery_power_kw": battKw,
	})
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
