package agent

// Real-time agent-level reproduction of the rig's C1b/C3 sequence over the
// REAL plan path (onPlanV2 -> runPlanExecutors -> arbiter -> cycle guard):
// a rod runs from a plan slot, the window ends (withdraw -> failsafe off),
// an immediate restart wish is HELD for the Mindestpause, and the standing
// wish releases once the pause is over.

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

func rodRegistry(minOffSeconds float64) entities.Registry {
	return entities.Registry{Revision: "cycle-rt", Entities: []entities.Entity{{
		ID: "rod-1", Type: entities.TypeHeatingRod,
		Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "on_off"}}},
		Guards: entities.Guards{
			Limits: entities.GuardLimits{MaxConsumptionKw: f64p(6),
				MinOffSeconds: f64p(minOffSeconds)},
			Failsafe: entities.Failsafe{Behavior: "off"},
		},
	}}}
}

func rodPlan(slotStart time.Time, on bool) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "2.0",
		"tenant_id":      "t", "site_id": "s", "device_id": "d",
		"plan_id":      "11111111-2222-3333-4444-555555555555",
		"generated_at": time.Now().UTC().Format(time.RFC3339),
		"slot_minutes": 1,
		"entities": []map[string]any{{
			"entity_id": "rod-1", "kind": "consumer",
			"slots": []map[string]any{{
				"start":    slotStart.UTC().Format(time.RFC3339),
				"commands": map[string]any{"on_off": on},
			}},
		}},
	})
	return raw
}

func TestConsumerPlanCycleGuardOverTheRealPlanPath(t *testing.T) {
	if testing.Short() {
		t.Skip("real-time test")
	}
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(rodRegistry(2))

	tick := func() {
		a.runPlanExecutors(time.Now().UTC())
		a.arb.Tick()
	}
	grantedOn := func() (bool, string) {
		dec, ok := a.arb.DecisionFor("rod-1")
		if !ok {
			return false, "no decision"
		}
		on := dec.Granted.OnOff != nil && *dec.Granted.OnOff
		cyc := ""
		if dec.Cycle != nil {
			cyc = dec.Cycle.Code
		}
		return on, fmt.Sprintf("source=%s cycle=%s", dec.Source, cyc)
	}

	// 1. An active slot commands the rod ON.
	a.onPlanV2(rodPlan(time.Now().UTC(), true))
	tick()
	if on, info := grantedOn(); !on {
		t.Fatalf("plan run refused: %s", info)
	}

	// 2. The window ends (the plan's only slot is now in the past): withdraw
	//    -> failsafe off. Simulated by a fresh plan whose slot already ended.
	a.onPlanV2(rodPlan(time.Now().UTC().Add(-2*time.Minute), true))
	tick()
	if on, info := grantedOn(); on {
		t.Fatalf("window end must fall to failsafe off: %s", info)
	}

	// 3. An immediate restart wish is HELD (Mindestpause).
	a.onPlanV2(rodPlan(time.Now().UTC(), true))
	tick()
	if on, _ := grantedOn(); on {
		t.Fatal("Mindestpause violated on the immediate restart")
	}
	dec, _ := a.arb.DecisionFor("rod-1")
	if dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMinOff {
		t.Fatalf("hold reason missing: %+v", dec.Cycle)
	}

	// 4. The standing wish releases once the pause is over (the
	//    arbitrationLoop cadence: executor re-injection + Tick every second).
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		tick()
		if on, _ := grantedOn(); on {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	on, info := grantedOn()
	t.Fatalf("restart never released after the pause: on=%v %s", on, info)
}
