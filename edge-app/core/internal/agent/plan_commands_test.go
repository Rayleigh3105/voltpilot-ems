package agent

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flexfallback"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
)

// Plan und Deadline-Fallback sprechen das Verbraucher-Wort `setpoint_kw`; eine
// OCPP-Säule kennt nur `limit_kw` (Bericht vp-wallbox-modi-konzept §3.4).
// consumerCommandsFor übersetzt genau diesen Fall und keinen anderen.

func ocppChargerEntity() entities.Entity {
	return entities.Entity{
		ID: "lp-1", Type: "ev-charger", ChargePointID: "SAEULE-1",
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "limit_kw", Max: f64p(11)}}},
		Guards: entities.Guards{Limits: entities.GuardLimits{MaxConsumptionKw: f64p(11)},
			Failsafe: entities.Failsafe{Behavior: "release"}},
	}
}

func TestConsumerCommandsForALimitOnlyConsumerBecomeItsLimit(t *testing.T) {
	for _, kw := range []float64{0, 11} {
		v := kw
		got := consumerCommandsFor(ocppChargerEntity(), entities.Commands{SetpointKw: &v}, 0)
		if got.SetpointKw != nil {
			t.Fatalf("setpoint_kw %v bleibt stehen - die Säule würde den Plan abweisen", kw)
		}
		if got.LimitKw == nil || *got.LimitKw != kw {
			t.Fatalf("setpoint_kw %v -> limit_kw %v, erwartet %v", kw, got.LimitKw, kw)
		}
	}
}

func TestConsumerCommandsForKeepEveryOtherWordUnchanged(t *testing.T) {
	sp := 3.5
	on := true
	limit := 7.0
	goe := entities.Entity{ID: "wb-1", Type: entities.TypeWallbox,
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{
			{Command: "setpoint_kw"}, {Command: "on_off"}, {Command: "limit_kw"}}},
		Guards: entities.Guards{Limits: entities.GuardLimits{MaxConsumptionKw: f64p(11)}}}
	rod := rodRegistry(0).Entities[0]
	batt := entities.Entity{ID: "b-1", Type: entities.TypeBatteryHybrid,
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{
			{Command: "setpoint_kw"}, {Command: "limit_kw"}}}}
	cases := []struct {
		name string
		e    entities.Entity
		c    entities.Commands
	}{
		{"go-e kennt setpoint_kw", goe, entities.Commands{SetpointKw: &sp}},
		{"Schaltlast mit on_off", rod, entities.Commands{OnOff: &on}},
		{"Speicher", batt, entities.Commands{SetpointKw: &sp}},
		{"Säule mit einem Plan-Deckel", ocppChargerEntity(), entities.Commands{LimitKw: &limit}},
	}
	for _, tc := range cases {
		got := consumerCommandsFor(tc.e, tc.c, 22)
		want, _ := json.Marshal(tc.c)
		have, _ := json.Marshal(got)
		if string(want) != string(have) {
			t.Fatalf("%s: %s wurde zu %s", tc.name, want, have)
		}
	}
}

// Über den ECHTEN Planpfad (onPlanV2 -> runPlanExecutors -> Arbiter ->
// Brücke): ein Aus-Slot des Plans erreicht die Säule als Deckel 0, ein
// An-Slot als Deckel mit Befreiung aus der Quellen-Bahn.
func TestPlanSlotsHoldAnOcppStationThroughTheBridge(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(entities.Registry{Revision: "lp", Entities: []entities.Entity{ocppChargerEntity()}})

	plan := func(kw float64) []byte {
		raw, _ := json.Marshal(map[string]any{
			"schema_version": "2.0",
			"tenant_id":      "t", "site_id": "s", "device_id": "d",
			"plan_id":      "11111111-2222-3333-4444-555555555555",
			"generated_at": time.Now().UTC().Format(time.RFC3339),
			"slot_minutes": 15,
			"entities": []map[string]any{{
				"entity_id": "lp-1", "kind": "consumer",
				"slots": []map[string]any{{
					"start":    time.Now().UTC().Truncate(15 * time.Minute).Format(time.RFC3339),
					"commands": map[string]any{"setpoint_kw": kw},
				}},
			}},
		})
		return raw
	}

	for _, tc := range []struct {
		kw     float64
		exempt bool
	}{{0, true}, {11, true}} {
		a.onPlanV2(plan(tc.kw))
		a.arb.Tick()
		h, ok := ocppBridgeDecision(a.arb.DecisionFor("lp-1"))
		if !ok {
			t.Fatalf("Plan-Slot %v kW: kein Halter an der Säule - sie fährt allein ihre Bahn", tc.kw)
		}
		if h.capKw == nil || *h.capKw != tc.kw {
			t.Fatalf("Plan-Slot %v kW: Deckel %v", tc.kw, h.capKw)
		}
		if h.exempt != tc.exempt {
			t.Fatalf("Plan-Slot %v kW: befreit=%v", tc.kw, h.exempt)
		}
	}
	if h, _ := ocppBridgeDecision(a.arb.DecisionFor("lp-1")); h.reason != "plan" {
		t.Fatalf("eine Pause des Plans heisst „plan\", nicht %q", h.reason)
	}
}

// Ohne frischen Plan startet der Deadline-Fallback ein Ladeziel selbst - an
// einer OCPP-Säule bis hierher nie: sein setpoint_kw fiel ebenso an der
// Fähigkeitsprüfung durch, und „Günstig + bis 7 Uhr" blieb ohne Wolke leer.
func TestTheDeadlineFallbackReachesAnOcppStation(t *testing.T) {
	a := newFlexTestAgent(t, t.TempDir())
	now := time.Now().UTC()
	from, to := windowAround(now, 2*time.Hour, 3*time.Hour)
	lp := ocppChargerEntity()
	lp.Capabilities.Measure = []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}}
	energy := 200.0 // mehr, als das Fenster hergibt: die Frist ist fällig
	lp.FlexRequirements = []entities.FlexRequirement{{
		ID: "bis_uhrzeit", Timezone: "Europe/Berlin", Days: "daily", From: from, To: to,
		EnergyKwh: &energy, PowerKw: 11, Command: entities.CmdSetpointKw,
	}}
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(entities.Registry{Revision: "lp-flex", Entities: []entities.Entity{lp}})
	payload, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "lp-1",
		"channels": map[string]float64{"power_kw": 0},
	})
	a.onEntityTelemetry("edge/entities/lp-1/telemetry", payload)

	a.runFlexFallback(now)
	dec, ok := a.arb.DecisionFor("lp-1")
	if !ok || dec.HolderKind != "deadline-fallback" {
		t.Fatalf("die fällige Frist muss die Säule halten: %+v (ok=%v)", dec, ok)
	}
	h, ok := ocppBridgeDecision(dec, ok)
	if !ok || !h.exempt || h.capKw == nil || *h.capKw != 11 {
		t.Fatalf("die Brücke muss befreien und auf 11 kW deckeln: %+v", h)
	}
}

// W-02 (Audit vp-ocpp-haushalt-audit): die Cloud legt eine OCPP-Säule mit der
// Regelart „Ein/Aus" an, der Optimierer schreibt dann `on_off`. Die Säule kennt
// nur `limit_kw` - „aus" wird ein Deckel 0, „an" ihre eigene Obergrenze.
func TestConsumerCommandsForOnOffAtALimitOnlyStationBecomesItsLimit(t *testing.T) {
	on, off := true, false
	if got := consumerCommandsFor(ocppChargerEntity(), entities.Commands{OnOff: &on}, 0); got.OnOff != nil ||
		got.LimitKw == nil || *got.LimitKw != 11 {
		t.Fatalf("on_off=true an einer 11-kW-Säule -> %+v, erwartet limit_kw 11", got)
	}
	if got := consumerCommandsFor(ocppChargerEntity(), entities.Commands{OnOff: &off}, 0); got.OnOff != nil ||
		got.LimitKw == nil || *got.LimitKw != 0 {
		t.Fatalf("on_off=false -> %+v, erwartet limit_kw 0", got)
	}

	// Die API legt die Säule OHNE Leistung an: dann gilt, was die Box über sie
	// weiss (onKw) - und ohne jede Obergrenze bleibt das Wort, wie es ist.
	bare := ocppChargerEntity()
	bare.Capabilities.Actuate = []entities.ActuateCap{{Command: "limit_kw"}}
	bare.Guards.Limits.MaxConsumptionKw = nil
	if got := consumerCommandsFor(bare, entities.Commands{OnOff: &on}, 7.4); got.LimitKw == nil || *got.LimitKw != 7.4 {
		t.Fatalf("ohne Typenschild -> %+v, erwartet die Obergrenze der Box 7,4 kW", got)
	}
	if got := consumerCommandsFor(bare, entities.Commands{OnOff: &off}, 0); got.LimitKw == nil || *got.LimitKw != 0 {
		t.Fatalf("„aus“ braucht keine Obergrenze: %+v", got)
	}
	if got := consumerCommandsFor(bare, entities.Commands{OnOff: &on}, 0); got.LimitKw != nil || got.OnOff == nil {
		t.Fatalf("ohne jede Obergrenze darf keine Grenze erfunden werden: %+v", got)
	}
}

// Über den ECHTEN Planpfad, wie der Labor-Test des Audits
// (`audit_onoff_test.go`): vor dem Fix „Halter an der Säule = false" für beide
// Werte, jetzt hält der Plan die Säule - „an" befreit sie aus der Bahn
// „Nur Sonne" bis zu ihrer Nennleistung, „aus" deckelt sie auf 0.
func TestPlanWordOnOffHoldsAnOcppStationThroughTheBridge(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(entities.Registry{Revision: "lp", Entities: []entities.Entity{ocppChargerEntity()}})

	plan := func(on bool) []byte {
		raw, _ := json.Marshal(map[string]any{
			"schema_version": "2.0",
			"tenant_id":      "t", "site_id": "s", "device_id": "d",
			"plan_id":      "11111111-2222-3333-4444-555555555556",
			"generated_at": time.Now().UTC().Format(time.RFC3339),
			"slot_minutes": 15,
			"entities": []map[string]any{{
				"entity_id": "lp-1", "kind": "consumer",
				"slots": []map[string]any{{
					"start":    time.Now().UTC().Truncate(15 * time.Minute).Format(time.RFC3339),
					"commands": map[string]any{"on_off": on},
				}},
			}},
		})
		return raw
	}
	for _, tc := range []struct {
		on    bool
		capKw float64
	}{{true, 11}, {false, 0}} {
		a.onPlanV2(plan(tc.on))
		a.arb.Tick()
		h, ok := ocppBridgeDecision(a.arb.DecisionFor("lp-1"))
		deckel := "keiner"
		if h.capKw != nil {
			deckel = fmt.Sprintf("%g kW", *h.capKw)
		}
		t.Logf("Plan-Slot on_off=%v: Halter an der Säule=%v Deckel=%s befreit=%v Grund=%q",
			tc.on, ok, deckel, h.exempt, h.reason)
		if !ok {
			t.Fatalf("Plan-Slot on_off=%v: kein Halter an der Säule - sie fährt allein ihre Bahn", tc.on)
		}
		if h.capKw == nil || *h.capKw != tc.capKw {
			t.Fatalf("Plan-Slot on_off=%v: Deckel %v, erwartet %v", tc.on, h.capKw, tc.capKw)
		}
		if !h.exempt || h.reason != lastmgmt.ReasonPlan {
			t.Fatalf("Plan-Slot on_off=%v: befreit=%v Grund=%q", tc.on, h.exempt, h.reason)
		}
	}
}

// „an" ohne Typenschild im Registry ist die Obergrenze, mit der die Box die
// Säule einrichtet: Nennleistung × Stecker, sonst das planbare Budget.
func TestConsumerOnKwIsTheStationsCommissioningCeiling(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 0) // 277 kW, 10 % Abstand -> 249,3 kW planbar
	if _, err := a.OcppAddCharger(csms.AddRequest{ID: "WALLBOX-GARAGE", RatedKw: 11, Connectors: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.OcppAddCharger(csms.AddRequest{ID: "OHNE-LEISTUNG", Connectors: 1}); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]float64{"WALLBOX-GARAGE": 11, "OHNE-LEISTUNG": 249.3, "UNBEKANNT": 0} {
		if got := a.consumerOnKw(entities.Entity{ID: "lp", ChargePointID: id}); math.Abs(got-want) > 1e-9 {
			t.Fatalf("%s: „an“ = %v kW, erwartet %v", id, got, want)
		}
	}
}

// Der Frist-Notnagel schwieg, sobald IRGENDEIN v2-Plan frisch war - ein Plan,
// der nur den Speicher kennt, liess das Ladeziel der Säule leer. Jetzt zählt die
// Frische je Komponente: ohne Slot für die Säule startet der Notnagel sie
// selbst, mit Slot weicht er dem Plan.
func TestTheDeadlineFallbackOnlyYieldsToAPlanThatCommandsTheStation(t *testing.T) {
	a := newFlexTestAgent(t, t.TempDir())
	now := time.Now().UTC()
	from, to := windowAround(now, 2*time.Hour, 3*time.Hour)
	lp := ocppChargerEntity()
	lp.Capabilities.Measure = []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}}
	energy := 200.0 // mehr, als das Fenster hergibt: die Frist ist fällig
	lp.FlexRequirements = []entities.FlexRequirement{{
		ID: "bis_uhrzeit", Timezone: "Europe/Berlin", Days: "daily", From: from, To: to,
		EnergyKwh: &energy, PowerKw: 11, Command: entities.CmdOnOff,
	}}
	batt := entities.Entity{ID: "b-1", Type: entities.TypeBatteryHybrid,
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "setpoint_kw"}}}}
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(entities.Registry{Revision: "lp-flex", Entities: []entities.Entity{lp, batt}})
	payload, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": "lp-1",
		"channels": map[string]float64{"power_kw": 0},
	})
	a.onEntityTelemetry("edge/entities/lp-1/telemetry", payload)

	slot := now.Truncate(15 * time.Minute)
	sp, off := -2.0, false
	pass := func(planned ...plan2.Entity) (desired.Decision, bool) {
		a.arbMu.Lock()
		a.curPlan2 = &plan2.Plan{PlanID: "p", ReceivedAt: now, SlotMinutes: 15, Entities: planned}
		a.arbMu.Unlock()
		a.runPlanExecutors(now)
		a.runFlexFallback(now)
		return a.arb.DecisionFor("lp-1")
	}

	dec, ok := pass(plan2.Entity{ID: "b-1", Slots: []plan2.Slot{{Start: slot,
		Commands: entities.Commands{SetpointKw: &sp}}}})
	if !ok || dec.HolderKind != "deadline-fallback" {
		t.Fatalf("ein Plan nur für den Speicher darf die Frist der Säule nicht stummschalten: %+v (ok=%v)", dec, ok)
	}
	if h, ok := ocppBridgeDecision(dec, ok); !ok || !h.exempt || h.capKw == nil || *h.capKw != 11 {
		t.Fatalf("der Notnagel mit on_off muss die Säule befreien und auf 11 kW deckeln: %+v", h)
	}

	dec, ok = pass(
		plan2.Entity{ID: "b-1", Slots: []plan2.Slot{{Start: slot, Commands: entities.Commands{SetpointKw: &sp}}}},
		plan2.Entity{ID: "lp-1", Slots: []plan2.Slot{{Start: slot, Commands: entities.Commands{OnOff: &off}}}},
	)
	if !ok || dec.HolderKind != string(desired.SourcePlanExecutor) {
		t.Fatalf("ein Plan, der die Säule steuert, hält sie selbst: %+v (ok=%v)", dec, ok)
	}
	if h, _ := ocppBridgeDecision(dec, ok); h.capKw == nil || *h.capKw != 0 {
		t.Fatalf("der Aus-Slot des Plans gilt, nicht der Notnagel: %+v", h)
	}
	a.flexMu.Lock()
	reason := a.flexLast["lp-1"]
	a.flexMu.Unlock()
	if reason != flexfallback.ReasonPlanFresh {
		t.Fatalf("der Notnagel nennt seinen Grund %q, erwartet %q", reason, flexfallback.ReasonPlanFresh)
	}
}
