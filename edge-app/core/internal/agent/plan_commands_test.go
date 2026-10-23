package agent

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// Der Plan spricht das Verbraucher-Wort `setpoint_kw`; eine OCPP-Säule kennt
// nur `limit_kw` (Bericht vp-wallbox-modi-konzept §3.4). planCommandsFor
// übersetzt genau diesen Fall und keinen anderen.

func ocppChargerEntity() entities.Entity {
	return entities.Entity{
		ID: "lp-1", Type: "ev-charger", ChargePointID: "SAEULE-1",
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "limit_kw", Max: f64p(11)}}},
		Guards: entities.Guards{Limits: entities.GuardLimits{MaxConsumptionKw: f64p(11)},
			Failsafe: entities.Failsafe{Behavior: "release"}},
	}
}

func TestPlanCommandsForALimitOnlyConsumerBecomeItsLimit(t *testing.T) {
	for _, kw := range []float64{0, 11} {
		v := kw
		got := planCommandsFor(ocppChargerEntity(), entities.Commands{SetpointKw: &v})
		if got.SetpointKw != nil {
			t.Fatalf("setpoint_kw %v bleibt stehen - die Säule würde den Plan abweisen", kw)
		}
		if got.LimitKw == nil || *got.LimitKw != kw {
			t.Fatalf("setpoint_kw %v -> limit_kw %v, erwartet %v", kw, got.LimitKw, kw)
		}
	}
}

func TestPlanCommandsForKeepEveryOtherWordUnchanged(t *testing.T) {
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
		got := planCommandsFor(tc.e, tc.c)
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
