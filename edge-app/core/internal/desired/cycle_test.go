package desired

// The consumer CYCLE GUARD on the arbitration path (Verbrauchssteuerung
// Inkrement 3, §13.1): min-on/min-off/starts-per-day/ramp are enforced on the
// execution path of EVERY consumer command - plan desires, flow desires and
// the failsafe run through the same clamp - restrict-only, with the honest
// machine-readable reason in the arbitration event and the Decision.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

func rodEntity() entities.Entity {
	return entities.Entity{
		ID:   "rod-1",
		Type: entities.TypeHeatingRod,
		Capabilities: entities.Capabilities{
			Actuate: []entities.ActuateCap{{Command: "on_off"}},
		},
		Guards: entities.Guards{
			Limits: entities.GuardLimits{
				MaxConsumptionKw: f64(6),
				MinOnSeconds:     f64(120),
				MinOffSeconds:    f64(60),
				MaxStartsPerDay:  f64(3),
			},
			Failsafe: entities.Failsafe{Behavior: "off"},
		},
	}
}

func wallboxEntity() entities.Entity {
	return entities.Entity{
		ID:   "wb-1",
		Type: entities.TypeWallbox,
		Capabilities: entities.Capabilities{
			Actuate: []entities.ActuateCap{{Command: "setpoint_kw", Max: f64(11)}, {Command: "on_off"}},
		},
		Guards: entities.Guards{
			Limits:   entities.GuardLimits{MaxConsumptionKw: f64(11)},
			Failsafe: entities.Failsafe{Behavior: "release"},
		},
	}
}

func newConsumerHarness(t *testing.T) *harness {
	h := newHarness(t)
	h.arb.SetEntities(entities.Registry{Revision: "rev-c", Entities: []entities.Entity{
		batteryEntity(), rodEntity(), wallboxEntity(),
	}})
	return h
}

func onOffDesire(entity string, on bool, ttlS int, issued time.Time) *Desired {
	v := on
	return &Desired{
		EntityID:  entity,
		RequestID: "plan:" + entity + ":" + issued.Format(time.RFC3339),
		Source:    Source{Kind: SourcePlanExecutor},
		Priority:  ClassMarket,
		TTL:       time.Duration(ttlS) * time.Second,
		IssuedAt:  issued,
		Commands:  entities.Commands{OnOff: &v},
	}
}

func (h *harness) onOffOf(entity string) bool {
	h.t.Helper()
	cmd, ok := h.lastCommand(entity)
	if !ok {
		h.t.Fatalf("command for %s is cleared", entity)
	}
	cmds := cmd["commands"].(map[string]any)
	v, ok := cmds["on_off"].(bool)
	if !ok {
		h.t.Fatalf("command carries no on_off: %v", cmd)
	}
	return v
}

func TestMinOffPauseHoldsAPlanSwitchOnWithTheHonestReason(t *testing.T) {
	h := newConsumerHarness(t)

	// On, run past min-on, then off.
	h.arb.SubmitInternal(onOffDesire("rod-1", true, 600, h.clock))
	if !h.onOffOf("rod-1") {
		t.Fatal("initial on refused")
	}
	h.clock = h.clock.Add(3 * time.Minute)
	h.arb.SubmitInternal(onOffDesire("rod-1", false, 600, h.clock))
	if h.onOffOf("rod-1") {
		t.Fatal("switch-off refused after min-on elapsed")
	}

	// A restart wish 20 s later is HELD OFF: the command stays off, the event
	// carries the cycle stage, the Decision the reason code.
	h.clock = h.clock.Add(20 * time.Second)
	h.arb.SubmitInternal(onOffDesire("rod-1", true, 600, h.clock))
	if h.onOffOf("rod-1") {
		t.Fatal("min-off pause violated: the device was switched on")
	}
	e := h.lastEvent()
	found := false
	for _, r := range e.Reasons {
		if r.Stage == guards.StageCycleMinOff {
			found = true
		}
	}
	if !found {
		raw, _ := json.Marshal(e.Reasons)
		t.Fatalf("event reasons miss %s: %s", guards.StageCycleMinOff, raw)
	}
	dec, ok := h.arb.DecisionFor("rod-1")
	if !ok || dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMinOff {
		t.Fatalf("Decision.Cycle = %+v, want guard_min_off", dec.Cycle)
	}
	if st, ok := h.arb.CycleStateFor("rod-1"); !ok || st.Hold == nil || st.Hold.Text != "wartet - Mindestpause" {
		t.Fatalf("cycle state misses the German sentence: %+v", st)
	}

	// After the pause the standing wish passes on the next tick - no flapping
	// in between (the command flips exactly once).
	h.clock = h.clock.Add(50 * time.Second)
	h.arb.Tick()
	if !h.onOffOf("rod-1") {
		t.Fatal("switch-on after the pause refused")
	}
	if dec, _ := h.arb.DecisionFor("rod-1"); dec.Cycle != nil {
		t.Fatalf("hold must clear after release: %+v", dec.Cycle)
	}
}

func TestStartBudgetHoldsFurtherStartsOnThePlanPath(t *testing.T) {
	h := newConsumerHarness(t)
	for i := 0; i < 3; i++ {
		h.arb.SubmitInternal(onOffDesire("rod-1", true, 600, h.clock))
		if !h.onOffOf("rod-1") {
			t.Fatalf("start %d refused", i+1)
		}
		h.clock = h.clock.Add(3 * time.Minute)
		h.arb.SubmitInternal(onOffDesire("rod-1", false, 600, h.clock))
		h.clock = h.clock.Add(2 * time.Minute)
	}
	h.arb.SubmitInternal(onOffDesire("rod-1", true, 600, h.clock))
	if h.onOffOf("rod-1") {
		t.Fatal("fourth start of the day must be held (max_starts_per_day 3)")
	}
	dec, _ := h.arb.DecisionFor("rod-1")
	if dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMaxStarts {
		t.Fatalf("Decision.Cycle = %+v, want guard_max_starts", dec.Cycle)
	}
}

func TestFailsafeOffIsHeldDuringMinimumRuntime(t *testing.T) {
	// Geräteschutz > Failsafe (§3.1): a rod that just started stays on for
	// its minimum runtime even when the commanding desire expires and the
	// 'off' failsafe takes over - with the honest reason.
	h := newConsumerHarness(t)
	h.arb.SubmitInternal(onOffDesire("rod-1", true, 30, h.clock))
	if !h.onOffOf("rod-1") {
		t.Fatal("start refused")
	}
	h.clock = h.clock.Add(60 * time.Second) // desire expired, min-on (120s) not yet met
	h.arb.Tick()
	if !h.onOffOf("rod-1") {
		t.Fatal("failsafe off must be held during the minimum runtime")
	}
	cmd, _ := h.lastCommand("rod-1")
	if cmd["source"] != "failsafe" {
		t.Fatalf("held command must still be the failsafe's: %v", cmd["source"])
	}
	dec, _ := h.arb.DecisionFor("rod-1")
	if dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonMinOn {
		t.Fatalf("Decision.Cycle = %+v, want guard_min_on", dec.Cycle)
	}
	// Once the minimum runtime is over the failsafe off goes through.
	h.clock = h.clock.Add(90 * time.Second)
	h.arb.Tick()
	if h.onOffOf("rod-1") {
		t.Fatal("failsafe off refused after min-on elapsed")
	}
}

func TestConsumerWithoutCycleLimitsIsNeverHeld(t *testing.T) {
	h := newConsumerHarness(t)
	kw := 7.0
	h.arb.SubmitInternal(&Desired{
		EntityID: "wb-1", RequestID: "plan:wb", Source: Source{Kind: SourcePlanExecutor},
		Priority: ClassMarket, TTL: 600 * time.Second, IssuedAt: h.clock,
		Commands: entities.Commands{SetpointKw: &kw},
	})
	if got := h.setpointOf("wb-1"); got != 7 {
		t.Fatalf("unconfigured cycle guard must pass the wish: %v", got)
	}
	dec, _ := h.arb.DecisionFor("wb-1")
	if dec.Cycle != nil {
		t.Fatalf("no limits -> no hold, got %+v", dec.Cycle)
	}
	// Rapid off/on passes untouched.
	off := 0.0
	h.clock = h.clock.Add(time.Second)
	h.arb.SubmitInternal(&Desired{
		EntityID: "wb-1", RequestID: "plan:wb2", Source: Source{Kind: SourcePlanExecutor},
		Priority: ClassMarket, TTL: 600 * time.Second, IssuedAt: h.clock,
		Commands: entities.Commands{SetpointKw: &off},
	})
	h.clock = h.clock.Add(time.Second)
	kw2 := 4.0
	h.arb.SubmitInternal(&Desired{
		EntityID: "wb-1", RequestID: "plan:wb3", Source: Source{Kind: SourcePlanExecutor},
		Priority: ClassMarket, TTL: 600 * time.Second, IssuedAt: h.clock,
		Commands: entities.Commands{SetpointKw: &kw2},
	})
	if got := h.setpointOf("wb-1"); got != 4 {
		t.Fatalf("rapid toggle must pass without invented protection: %v", got)
	}
}

func TestRampBindsOnAConsumerSetpointViaTheRegistryConfig(t *testing.T) {
	h := newConsumerHarness(t)
	wb := wallboxEntity()
	wb.Guards.Limits.RampKwPerMin = f64(6)
	h.arb.SetEntities(entities.Registry{Revision: "rev-r", Entities: []entities.Entity{
		batteryEntity(), rodEntity(), wb,
	}})
	kw := 11.0
	h.arb.SubmitInternal(&Desired{
		EntityID: "wb-1", RequestID: "plan:wb-ramp", Source: Source{Kind: SourcePlanExecutor},
		Priority: ClassMarket, TTL: 600 * time.Second, IssuedAt: h.clock,
		Commands: entities.Commands{SetpointKw: &kw},
	})
	if got := h.setpointOf("wb-1"); got != 0 {
		t.Fatalf("a fresh start must ramp from 0, got %v", got)
	}
	h.clock = h.clock.Add(30 * time.Second)
	h.arb.Tick()
	if got := h.setpointOf("wb-1"); got != 3 {
		t.Fatalf("after 30s at 6 kW/min the level must be 3, got %v", got)
	}
	dec, _ := h.arb.DecisionFor("wb-1")
	if dec.Cycle == nil || dec.Cycle.Code != guards.CycleReasonRamp {
		t.Fatalf("Decision.Cycle = %+v, want guard_ramp", dec.Cycle)
	}
	h.clock = h.clock.Add(2 * time.Minute)
	h.arb.Tick()
	if got := h.setpointOf("wb-1"); got != 11 {
		t.Fatalf("ramp must converge on the wish, got %v", got)
	}
}

func TestCycleGuardNeverTouchesStorageOrProducers(t *testing.T) {
	h := newConsumerHarness(t)
	if _, ok := h.arb.CycleStateFor("batt-main"); ok {
		t.Fatal("a storage entity must not carry a cycle guard")
	}
	if _, ok := h.arb.CycleStateFor("pv-roof"); ok {
		t.Fatal("a producer must not carry a cycle guard")
	}
}
