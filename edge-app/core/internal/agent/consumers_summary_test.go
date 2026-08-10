package agent

// The heartbeat's additive `consumers` block (Verbrauchssteuerung Inkrement 3,
// D9/§15.1). Proves: a device without consumer entities emits NO block (the
// heartbeat stays byte-identical), the §14.13/§15 vocabulary is derived
// honestly (running vs waiting vs offline, cycle-guard reasons, readback
// tri-state), actual_kw comes only from fresh own telemetry (never a
// fabricated 0), and the day counters ride requirement_progress.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

func f64p(v float64) *float64 { return &v }

func consumerRegistry() entities.Registry {
	return entities.Registry{Revision: "rev-consumers", Entities: []entities.Entity{
		{
			ID: "batt-1", Type: entities.TypeBatteryHybrid,
			Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "setpoint_kw"}}},
			Guards: entities.Guards{
				Limits:   entities.GuardLimits{MaxChargeKw: f64p(10), MaxDischargeKw: f64p(10)},
				Failsafe: entities.Failsafe{Behavior: "self-consumption"},
			},
		},
		{
			ID: "rod-1", Type: entities.TypeHeatingRod,
			Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: "on_off"}}},
			Guards: entities.Guards{
				Limits: entities.GuardLimits{MaxConsumptionKw: f64p(6),
					MinOffSeconds: f64p(3600)},
				Failsafe: entities.Failsafe{Behavior: "off"},
			},
		},
		{
			ID: "wb-1", Type: entities.TypeWallbox,
			Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{
				{Command: "setpoint_kw", Max: f64p(11)}, {Command: "on_off"}}},
			Guards: entities.Guards{
				Limits:   entities.GuardLimits{MaxConsumptionKw: f64p(11)},
				Failsafe: entities.Failsafe{Behavior: "release"},
			},
		},
	}}
}

func planOnOff(entity string, on bool, ttl time.Duration) *desired.Desired {
	v := on
	return &desired.Desired{
		EntityID:  entity,
		RequestID: "plan:" + entity,
		Source:    desired.Source{Kind: desired.SourcePlanExecutor},
		Priority:  desired.ClassMarket,
		TTL:       ttl,
		IssuedAt:  time.Now().UTC(),
		Commands:  entities.Commands{OnOff: &v},
	}
}

func TestConsumersSummaryIsAbsentWithoutConsumerEntities(t *testing.T) {
	a := newGateTestAgent(t)
	if sum := a.consumersSummary(); sum != nil {
		t.Fatalf("a registry-less device must emit no consumers block, got %+v", sum)
	}
	// A registry with only a battery is not a consumer either.
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(entities.Registry{Revision: "r", Entities: consumerRegistry().Entities[:1]})
	if sum := a.consumersSummary(); sum != nil {
		t.Fatalf("a battery-only registry must emit no consumers block, got %+v", sum)
	}
}

func TestConsumersSummaryDerivesRunningWaitingAndReasons(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(consumerRegistry())

	// The plan turns the rod ON.
	a.arb.SubmitInternal(planOnOff("rod-1", true, 10*time.Minute))
	sum := a.consumersSummary()
	if sum == nil {
		t.Fatal("consumers block missing")
	}
	if _, ok := sum["batt-1"]; ok {
		t.Fatal("the battery must never appear in the consumers block")
	}
	rod := sum["rod-1"]
	if rod.State != "running_optimized" || rod.ReasonCode != "" {
		t.Fatalf("running rod wrong: %+v", rod)
	}
	if rod.RequirementProgress == nil || rod.RequirementProgress.StartsToday != 1 {
		t.Fatalf("day counters wrong: %+v", rod.RequirementProgress)
	}
	if rod.ActualKw != nil {
		t.Fatalf("no telemetry -> no actual_kw, got %v", *rod.ActualKw)
	}
	if rod.Confirmed != nil {
		t.Fatalf("no readback -> confirmed must be absent, got %v", *rod.Confirmed)
	}
	// The idle wallbox (release failsafe, nothing commanded) waits.
	if wb := sum["wb-1"]; wb.State != "waiting" || wb.ReasonCode != "" {
		t.Fatalf("idle wallbox wrong: %+v", wb)
	}

	// Off, then an immediate restart wish: the cycle guard holds with the
	// honest reason - waiting + guard_min_off.
	a.arb.SubmitInternal(planOnOff("rod-1", false, 10*time.Minute))
	a.arb.SubmitInternal(planOnOff("rod-1", true, 10*time.Minute))
	rod = a.consumersSummary()["rod-1"]
	if rod.State != "waiting" || rod.ReasonCode != guards.CycleReasonMinOff {
		t.Fatalf("held rod wrong: %+v", rod)
	}
}

func TestConsumersSummaryReadbackTriStateAndForcedRun(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(consumerRegistry())

	// A must-run flow desire (override) drives the wallbox: running_forced.
	kw := 11.0
	a.arb.SubmitInternal(&desired.Desired{
		EntityID: "wb-1", RequestID: "flow:boost",
		Source:   desired.Source{Kind: desired.SourceFlow, FlowID: "f1", FlowVersion: 1, NodeID: "n1"},
		Priority: desired.ClassFlow, Override: true,
		TTL: time.Hour, IssuedAt: time.Now().UTC(),
		Commands: entities.Commands{SetpointKw: &kw},
	})
	wb := a.consumersSummary()["wb-1"]
	if wb.State != "running_forced" {
		t.Fatalf("override run must read running_forced: %+v", wb)
	}

	// A mismatching readback flips confirmed=false + readback_mismatch.
	a.onEntityReadback("edge/entities/wb-1/readback", []byte(`{"all_match":false}`))
	wb = a.consumersSummary()["wb-1"]
	if wb.Confirmed == nil || *wb.Confirmed || wb.ReasonCode != "readback_mismatch" {
		t.Fatalf("mismatch readback wrong: %+v", wb)
	}
	// A matching readback confirms.
	a.onEntityReadback("edge/entities/wb-1/readback", []byte(`{"all_match":true}`))
	wb = a.consumersSummary()["wb-1"]
	if wb.Confirmed == nil || !*wb.Confirmed || wb.ReasonCode != "" {
		t.Fatalf("match readback wrong: %+v", wb)
	}
}

func TestConsumersSummaryActualKwAndOffline(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(consumerRegistry())

	// Fresh own telemetry -> actual_kw travels.
	a.entMu.Lock()
	a.entReadings = map[string]entReading{
		"wb-1": {channels: map[string]float64{"power_kw": 3.6}, recv: time.Now()},
	}
	a.entMu.Unlock()
	wb := a.consumersSummary()["wb-1"]
	if wb.ActualKw == nil || *wb.ActualKw != 3.6 {
		t.Fatalf("fresh telemetry must carry actual_kw: %+v", wb)
	}

	// Stale telemetry with nothing commanded -> offline + device_offline,
	// actual_kw ABSENT (a stale value is not a value).
	a.entMu.Lock()
	a.entReadings["wb-1"] = entReading{channels: map[string]float64{"power_kw": 3.6},
		recv: time.Now().Add(-10 * time.Minute)}
	a.entMu.Unlock()
	wb = a.consumersSummary()["wb-1"]
	if wb.State != "offline" || wb.ReasonCode != "device_offline" || wb.ActualKw != nil {
		t.Fatalf("stale device wrong: %+v", wb)
	}
}

func TestConsumersBlockJSONShape(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(consumerRegistry())
	a.arb.SubmitInternal(planOnOff("rod-1", true, 10*time.Minute))

	raw, err := json.Marshal(a.consumersSummary())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	rod := m["rod-1"]
	if rod["state"] != "running_optimized" {
		t.Fatalf("wire state wrong: %v", rod)
	}
	if _, ok := rod["reason_code"]; ok {
		t.Fatalf("empty reason_code must be omitted: %v", rod)
	}
	if _, ok := rod["confirmed"]; ok {
		t.Fatalf("absent readback must omit confirmed: %v", rod)
	}
	prog, ok := rod["requirement_progress"].(map[string]any)
	if !ok || prog["starts_today"] != float64(1) {
		t.Fatalf("requirement_progress wire shape wrong: %v", rod)
	}
}

// TestConsumersSummaryNamesTheGoePhaseHold: the go-e driver's paced phase
// switch (D4) surfaces per §15 as clamped + guard_phase_switch - the honest
// "wartet - Phasenumschaltpause" the cloud/portal render; cleared once the
// switch executed.
func TestConsumersSummaryNamesTheGoePhaseHold(t *testing.T) {
	a := newGateTestAgent(t)
	a.setEntityIdentity("t", "s", "d")
	a.applyEntityRegistry(consumerRegistry())

	// The wallbox is commanded to charge; the DRIVER paces a phase switch.
	a.arb.SubmitInternal(&desired.Desired{
		EntityID: "wb-1", RequestID: "r1",
		Source:   desired.Source{Kind: desired.SourcePlanExecutor},
		Priority: desired.ClassMarket, TTL: 10 * time.Minute,
		IssuedAt: time.Now().UTC(),
		Commands: entities.Commands{SetpointKw: f64p(11)}, RequestedType: entities.CmdSetpointKw,
	})
	a.noteGoeHold("wb-1", "guard_phase_switch")
	wb := a.consumersSummary()["wb-1"]
	if wb.State != "clamped" || wb.ReasonCode != "guard_phase_switch" {
		t.Fatalf("phase hold must be named (clamped + guard_phase_switch), got %+v", wb)
	}

	// Switch executed -> the hold clears -> plain running.
	a.noteGoeHold("wb-1", "")
	wb = a.consumersSummary()["wb-1"]
	if wb.State != "running_optimized" || wb.ReasonCode != "" {
		t.Fatalf("cleared hold must run plainly, got %+v", wb)
	}
}
