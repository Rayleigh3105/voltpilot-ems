package agent

// „Ruhe bis zum Start" (UEMS AP-01 IP-4, rule R0): a plant that belongs to
// „Steuern & Optimieren" but was not started rests WITHOUT an end. The cloud
// sends `automation_paused_until_revoked: true` next to a rolling end that
// exists only for an older box. On THIS box, in-process against the real local
// bus, the real arbitration and the real guard chain:
//
//	R1  the Ruhe suppresses every setpoint the automation would write - the v1
//	    plan slot, the v2 plan executors and a manual/flow wish - even though
//	    the rolling end is ALREADY in the past;
//	R2  the guards keep running: the SoC window still clamps the local
//	    self-consumption failsafe, and a grid-class wish (above market) still
//	    binds - a rest is a gate below compliance, never a kill switch;
//	R3  no clock lifts it (days later it still rests); only a push WITHOUT the
//	    field does, and the plan takes over at once.

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// ruheRegistryPush is `registryPush` with exactly the fields
// EntityRegistryService.composePush adds for a Ruhe (override-vectors.json,
// block `push`): the rolling end for an older box and the revocation flag.
func ruheRegistryPush(t *testing.T, revision string, rollingEnd time.Time) []byte {
	t.Helper()
	var push map[string]any
	if err := json.Unmarshal(registryPush(revision, true), &push); err != nil {
		t.Fatal(err)
	}
	push["automation_paused_until"] = rollingEnd.UTC().Format(time.RFC3339)
	push["automation_paused_until_revoked"] = true
	out, err := json.Marshal(push)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func gridBatteryDesired(issued time.Time, kw float64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "entity_id": entBattery,
		"request_id": "grid:" + issued.Format(time.RFC3339Nano),
		"source":     map[string]any{"kind": desired.SourceCloudCommand},
		"priority":   desired.ClassGrid, "override": false, "ttl_s": 900,
		"issued_at": issued.UTC().Format(time.RFC3339Nano),
		"command":   map[string]any{"type": "setpoint_kw", "value": kw},
	})
	return raw
}

func TestRuheBisZumStartSuppressesSetpointsWhileTheGuardsKeepRunning(t *testing.T) {
	a, addr := followAgentAddr(t)
	sub := subscribeSetpoint(t, addr)
	now := time.Now().UTC().Truncate(time.Second)
	id := entities.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice}
	apply := func(payload []byte) {
		t.Helper()
		reg, skipped, err := entities.ParseRegistryPush(payload, id)
		if err != nil || len(skipped) != 0 {
			t.Fatalf("registry parse: skipped=%v err=%v", skipped, err)
		}
		a.applyEntityRegistry(reg)
	}
	freshPlan := func(at time.Time, kw float64) {
		yes := true
		a.mu.Lock()
		a.currentPlan = &plan.Plan{
			SlotMinutes: 15, ReceivedAt: at, GeneratedAt: at, GridChargeAllowed: &yes,
			Slots: []plan.Slot{{Start: at, BatterySetpointKw: kw}},
		}
		a.mu.Unlock()
	}
	reading := func(at time.Time, soc, pv, load float64) {
		a.mu.Lock()
		a.lastReading = guards.Reading{SocPct: soc, PvKw: pv, LoadKw: load,
			GridLimitKw: guards.Unknown()}
		a.lastReadingAt = at
		a.mu.Unlock()
	}
	assertPhysical := func(want float64, source string) {
		t.Helper()
		waitFor(t, 5*time.Second, "physical setpoint", func() bool {
			m, ok := sub.latest()
			return ok && m["battery_setpoint_kw"] == want && m["source"] == source
		})
	}
	assertMode := func(step string, mode state.Mode, kw float64) {
		t.Helper()
		if snap := a.State.Get(); snap.Mode != mode || snap.SetpointKw != kw {
			t.Fatalf("%s = mode %q, %.3f kW; want %q, %.3f kW", step, snap.Mode,
				snap.SetpointKw, mode, kw)
		}
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})

	// Baseline: without the field the plan commands the battery (8 kW charge).
	apply(registryPush("rev-ruhe-0", true))
	freshPlan(now, 8)
	reading(now, 60, 22.1, 36.8)
	a.applySetpoint(now)
	assertPhysical(8, "schedule")
	assertMode("baseline", state.ModeSchedule, 8)

	// --- R1: the Ruhe arrives - with its rolling end ALREADY an hour in the past,
	// the worst case for an end-based pause. Only the flag keeps it resting.
	apply(ruheRegistryPush(t, "rev-ruhe-1", now.Add(-time.Hour)))
	if !a.automationPausedAt(now) {
		t.Fatal("a Ruhe with an elapsed rolling end must rest until revoked")
	}
	tA := now.Add(time.Second)
	reading(tA, 60, 22.1, 36.8)
	a.applySetpoint(tA)
	assertPhysical(-14.7, "default") // local self-consumption, not the plan's +8
	assertMode("Ruhe, plan slot", state.ModeSelfConsume, -14.7)

	// The v2 half: the plan executors inject nothing, and a manual (flow-class)
	// wish is gated away - the battery lands on its registry failsafe.
	a.runPlanExecutors(tA)
	a.arb.Submit(entBattery, manualBatteryDesired(time.Now().UTC(), 0))
	a.arb.Tick()
	if dec, ok := a.arb.DecisionFor(entBattery); !ok || dec.HolderKind != "" ||
		dec.Source != "failsafe" {
		t.Fatalf("Ruhe decision must be holderless failsafe: %+v ok=%v", dec, ok)
	}
	a.applySetpoint(tA.Add(time.Second))
	assertPhysical(-14.7, "default")

	// --- R2a: the guard chain still runs. At the SoC floor the self-consumption
	// failsafe wants to discharge 14.7 kW; the SoC window clamps it to 0.
	tB := now.Add(3 * time.Second)
	reading(tB, a.Cfg.SocMinPct, 22.1, 36.8)
	a.applySetpoint(tB)
	assertPhysical(0, "default")
	assertMode("Ruhe at the SoC floor", state.ModeSelfConsume, 0)

	// --- R2b: a grid-class wish sits above market and binds during the Ruhe.
	tC := now.Add(4 * time.Second)
	reading(tC, 60, 22.1, 36.8)
	a.arb.Submit(entBattery, gridBatteryDesired(time.Now().UTC(), -2))
	a.arb.Tick()
	if dec, ok := a.arb.DecisionFor(entBattery); !ok ||
		dec.HolderKind != string(desired.SourceCloudCommand) || dec.Source != "desired" {
		t.Fatalf("grid wish during the Ruhe must hold: %+v ok=%v", dec, ok)
	}
	a.arb.Withdraw(entBattery, desired.Source{Kind: desired.SourceCloudCommand}.Key(), false)
	a.arb.Withdraw(entBattery, desired.Source{Kind: desired.SourceLocalUI}.Key(), false)
	a.arb.Tick()

	// --- R3: no clock lifts it. Eight days later, with a FRESH plan, it rests.
	tLate := now.Add(8 * 24 * time.Hour)
	freshPlan(tLate, 8)
	reading(tLate, 60, 22.1, 36.8)
	a.applySetpoint(tLate)
	assertPhysical(-14.7, "default")
	assertMode("Ruhe eight days later", state.ModeSelfConsume, -14.7)

	// Only a push WITHOUT the field revokes it - and the plan takes over at once.
	apply(registryPush("rev-ruhe-2", true))
	tRevoked := tLate.Add(time.Second)
	reading(tRevoked, 60, 22.1, 36.8)
	a.applySetpoint(tRevoked)
	assertPhysical(8, "schedule")
	assertMode("after revocation", state.ModeSchedule, 8)
}
