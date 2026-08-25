package agent

// Steuerung Stufe 3 „Vorrang technisch" (Konzept vp-steuerung-konzept-b3
// §3.7 A3): the SIMULATOR proof of „Regel gewinnt".
//
// Before this stage a customer rule (source flow, class flow, rank 40) lost
// the battery to the plan (class market, rank 60) every single second, because
// runPlanExecutors re-injected the plan's active slot on every tick. The fix
// does NOT touch the arbiter, the priority classes or D-4/D-5/D-6: the cloud
// stamps `owner_claimed` on the claimed component, and the plan executors then
// inject NOTHING for it - the rule wins because no competitor exists.
//
// The chain proven here is the real one, in-process, end to end:
//
//	R1  a v2 plan commands the battery; a rule desire LOSES (today's state)
//	R2  a registry push carrying owner_claimed makes the plan release the
//	    battery CLEANLY (no failsafe blip) and the rule takes it over
//	R3  the plan keeps commanding every UNCLAIMED component (the producer)
//	R4  withdrawing the claim gives the battery back to the plan
//
// A registry push without the field is byte-for-byte the pre-Stufe-3 case -
// that is R1 itself, which runs against the unmodified `registryPush`.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// claimedRegistryPush is `registryPush` with owner_claimed stamped on the
// battery - exactly the additive field EntityRegistryService.composePush adds.
func claimedRegistryPush(t *testing.T, revision string, claimBattery bool) []byte {
	t.Helper()
	var push map[string]any
	if err := json.Unmarshal(registryPush(revision, true), &push); err != nil {
		t.Fatal(err)
	}
	ents, _ := push["entities"].([]any)
	for _, raw := range ents {
		e, _ := raw.(map[string]any)
		if e["entity_id"] == entBattery && claimBattery {
			e["owner_claimed"] = true
		}
	}
	out, err := json.Marshal(push)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Regression for the cross-PR authority boundary caught during PR 514's
// independent review: the additive idle-slot market follower runs late in
// applySetpoint, after E2 arbitration. It must never reinterpret a technical
// rule's granted neutral 0 kW as permission to discharge into screenshot A's
// 14.7 kW house deficit.
func TestOwnerClaimedNeutralCommandBlocksUnplannedIdleFollower(t *testing.T) {
	a := followAgent(t)
	now := time.Now().UTC().Truncate(time.Second)
	reg, skipped, err := entities.ParseRegistryPush(
		claimedRegistryPush(t, "rev-owner-idle", true),
		entities.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("claimed registry parse: skipped=%v err=%v", skipped, err)
	}
	a.applyEntityRegistry(reg)
	a.arb.Submit(entBattery, desiredPayload(
		entBattery, "regel-speicher-halten", 0, 900, false))
	a.arb.Tick()

	yes, floor := true, 35.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &yes, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: now, BatterySetpointKw: 0, UnplannedLoadDischarge: true,
		}},
	}
	a.lastReading = guards.Reading{
		SocPct: 95, PvKw: 22.1, LoadKw: 36.8, GridLimitKw: guards.Unknown(),
	}
	a.lastReadingAt = now
	a.mu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now}
	})

	a.applySetpoint(now)
	snap := a.State.Get()
	if snap.Mode != state.ModeDesired || snap.SetpointKw != 0 {
		t.Fatalf("owner-claimed technical neutral = mode %q, %.3f kW; want desired, 0 kW",
			snap.Mode, snap.SetpointKw)
	}
	if snap.Follow != nil {
		t.Fatalf("owner-claimed technical neutral must have no market follow claim: %+v", snap.Follow)
	}
}

// Finalreview d6 reproduced the retained-plan transition the earlier idle-only
// regression missed: the established cover_load_from_battery flag is market
// authority too. An owner claim must stop it immediately, including the small
// registry-push window before the technical holder's first command arrives;
// once that neutral rule command holds, it must remain exactly neutral.
func TestIndependentOwnerClaimBlocksEstablishedMarketFollower(t *testing.T) {
	a := followAgent(t)
	now := time.Now().UTC().Truncate(time.Second)
	reg, skipped, err := entities.ParseRegistryPush(
		registryPush("rev-legacy-owner-0", true),
		entities.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("unclaimed registry parse: skipped=%v err=%v", skipped, err)
	}
	a.applyEntityRegistry(reg)
	setRetainedLegacyCoverScenario(a, now)

	// Establish the adversarial starting point: the retained market duty is
	// active and rewrites the idle plan to screenshot A's -14.7 kW.
	a.applySetpoint(now)
	assertLegacyFollow(t, a.State.Get(), -14.7, true, state.ModeSchedule)

	claimed, skipped, err := entities.ParseRegistryPush(
		claimedRegistryPush(t, "rev-legacy-owner-1", true),
		entities.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("claimed registry parse: skipped=%v err=%v", skipped, err)
	}
	a.applyEntityRegistry(claimed)

	// Race boundary: owner_claimed is already authoritative even before the
	// rule publisher's first desired reaches the arbiter.
	a.applySetpoint(now.Add(time.Second))
	assertLegacyFollow(t, a.State.Get(), 0, false, state.ModeSchedule)

	a.arb.Submit(entBattery, desiredPayload(
		entBattery, "regel-speicher-halten-legacy", 0, 900, false))
	a.arb.Tick()
	a.applySetpoint(now.Add(2 * time.Second))
	assertLegacyFollow(t, a.State.Get(), 0, false, state.ModeDesired)
}

// Contract, grid and safety holders are not "manual" commands, but they are
// even stronger authorities. A retained legacy market flag must never rewrite
// their neutral setpoint after HolderCommand has selected them.
func TestContractGridAndSafetyHoldersBlockEstablishedMarketFollower(t *testing.T) {
	for _, tc := range []struct {
		name     string
		priority desired.Class
	}{
		{name: "contract", priority: desired.ClassContract},
		{name: "grid", priority: desired.ClassGrid},
		{name: "safety", priority: desired.ClassSafety},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := followAgent(t)
			now := time.Now().UTC().Truncate(time.Second)
			reg, skipped, err := entities.ParseRegistryPush(
				registryPush("rev-legacy-"+tc.name, true),
				entities.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice})
			if err != nil || len(skipped) != 0 {
				t.Fatalf("registry parse: skipped=%v err=%v", skipped, err)
			}
			a.applyEntityRegistry(reg)
			setRetainedLegacyCoverScenario(a, now)
			a.applySetpoint(now)
			assertLegacyFollow(t, a.State.Get(), -14.7, true, state.ModeSchedule)

			zero := 0.0
			a.arb.SubmitInternal(&desired.Desired{
				EntityID: entBattery, RequestID: "compliance-neutral-" + tc.name,
				Source:   desired.Source{Kind: desired.SourceCloudCommand},
				Priority: tc.priority, TTL: time.Minute, IssuedAt: now,
				Commands: entities.Commands{SetpointKw: &zero},
			})
			a.arb.Tick()
			a.applySetpoint(now.Add(time.Second))
			assertLegacyFollow(t, a.State.Get(), 0, false, state.ModeDesired)
		})
	}
}

func setRetainedLegacyCoverScenario(a *Agent, now time.Time) {
	yes, floor := true, 35.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
		GridChargeAllowed: &yes, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: now, BatterySetpointKw: 0, CoverLoadFromBattery: true,
		}},
	}
	a.lastReading = guards.Reading{
		SocPct: 95, PvKw: 22.1, LoadKw: 36.8, GridLimitKw: guards.Unknown(),
	}
	a.lastReadingAt = now
	a.mu.Unlock()
}

func assertLegacyFollow(t *testing.T, snap state.Snapshot, wantKw float64, active bool, wantMode state.Mode) {
	t.Helper()
	if snap.Mode != wantMode || snap.SetpointKw != wantKw {
		t.Fatalf("retained legacy cover = mode %q, %.3f kW; want %q, %.3f kW",
			snap.Mode, snap.SetpointKw, wantMode, wantKw)
	}
	if active {
		if snap.Follow == nil || !snap.Follow.Active || snap.Follow.Path != execModeFollow {
			t.Fatalf("retained legacy cover evidence = %+v, want active legacy follow", snap.Follow)
		}
		return
	}
	if snap.Follow != nil {
		t.Fatalf("non-plan authority must clear retained legacy follow evidence: %+v", snap.Follow)
	}
}

func TestARuleClaimTakesTheBatteryFromThePlanAndGivesItBack(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	cb := startPlainCloudBroker(t)
	entTopic := fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice)
	planTopic := fmt.Sprintf("ems/%s/%s/%s/v2/plan", tTenant, tSite, tDevice)
	// Start UNCLAIMED: byte-for-byte the shipped push.
	cb.publishRetained(entTopic, registryPush("rev-claim-0", true))

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = tTenant, tSite, tDevice
	cfg.DevCloudURL = "tcp://" + cb.addr
	cfg.SetpointInterval = time.Second
	cfg.SetpointIntervalSeconds = 1

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()
	waitFor(t, 15*time.Second, "cloud connected", func() bool {
		return a.State.Get().CloudConnected
	})

	sub := pahoClient(t, cfg.LocalMQTTAddr, "claim-watch")
	var mu sync.Mutex
	commands := map[string][]string{}
	var events []map[string]any
	if tok := sub.Subscribe("edge/entities/+/command", 1,
		func(_ pahomqtt.Client, m pahomqtt.Message) {
			mu.Lock()
			commands[m.Topic()] = append(commands[m.Topic()], string(m.Payload()))
			mu.Unlock()
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	if tok := sub.Subscribe("edge/entities/+/arbitration", 1,
		func(_ pahomqtt.Client, m pahomqtt.Message) {
			var e map[string]any
			if json.Unmarshal(m.Payload(), &e) == nil {
				mu.Lock()
				events = append(events, e)
				mu.Unlock()
			}
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	last := func(entity string) (map[string]any, bool) {
		mu.Lock()
		defer mu.Unlock()
		list := commands["edge/entities/"+entity+"/command"]
		for i := len(list) - 1; i >= 0; i-- {
			if list[i] == "" {
				return nil, false
			}
			var m map[string]any
			if json.Unmarshal([]byte(list[i]), &m) == nil {
				return m, true
			}
		}
		return nil, false
	}
	setpointOf := func(entity string) (float64, string, bool) {
		m, ok := last(entity)
		if !ok {
			return 0, "", false
		}
		cmds, _ := m["commands"].(map[string]any)
		v, has := cmds["setpoint_kw"].(float64)
		src, _ := m["source"].(string)
		return v, src, has
	}
	eventsSince := func(mark int) []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		if mark > len(events) {
			return nil
		}
		return append([]map[string]any(nil), events[mark:]...)
	}
	eventCount := func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(events)
	}

	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now(), 5, 1, 50, 100)

	// --- R1: today's state. The plan commands the battery, and a customer
	// rule wish on the SAME component is rejected as a same-class conflict /
	// loses to the higher market rank - it never reaches the device.
	cb.publishRetained(planTopic, planV2(time.Now(), 1.5, 20))
	waitFor(t, 90*time.Second, "plan commands the battery", func() bool {
		v, src, ok := setpointOf(entBattery)
		return ok && src == "plan" && v == 1.5
	})
	pub := pahoClient(t, cfg.LocalMQTTAddr, "rule-pub")
	rule := func(kw float64) {
		if tok := pub.Publish("edge/entities/"+entBattery+"/desired", 1, false,
			desiredPayload(entBattery, "regel-speicher-halten", kw, 900, false)); tok.Wait() &&
			tok.Error() != nil {
			t.Fatal(tok.Error())
		}
	}
	rule(0) // "Ladestand halten" - the S1 semantics
	waitFor(t, 15*time.Second, "the rule wish is seen and loses", func() bool {
		mu.Lock()
		defer mu.Unlock()
		for i := len(events) - 1; i >= 0; i-- {
			if events[i]["outcome"] == "rejected" || events[i]["outcome"] == "superseded" {
				return true
			}
		}
		return false
	})
	if v, src, _ := setpointOf(entBattery); src != "plan" || v != 1.5 {
		t.Fatalf("without a claim the PLAN must still hold the battery: %v %s", v, src)
	}

	// --- R2: the claim arrives. The plan executor injects nothing for the
	// battery any more, so the rule takes it over - and the handover is a
	// CLEAN release, never the failsafe (the component keeps being commanded
	// the whole time).
	mark := eventCount()
	cb.publishRetained(entTopic, claimedRegistryPush(t, "rev-claim-1", true))
	waitFor(t, 60*time.Second, "the rule takes the battery", func() bool {
		v, src, ok := setpointOf(entBattery)
		return ok && src == "desired" && v == 0
	})
	for _, e := range eventsSince(mark) {
		if e["entity_id"] != entBattery {
			continue
		}
		if e["outcome"] == "fallback" {
			t.Fatalf("the handover to the rule must not blip through the failsafe: %v", e)
		}
	}
	if fmt.Sprint(eventsSince(mark)) == "" {
		t.Fatal("expected at least one arbitration event for the handover")
	}

	// --- R3: every UNCLAIMED component keeps its plan command.
	waitFor(t, 30*time.Second, "the plan still caps the producer", func() bool {
		m, ok := last(entProducer)
		if !ok {
			return false
		}
		cmds, _ := m["commands"].(map[string]any)
		return m["source"] == "plan" && cmds["limit_kw"] == 20.0
	})

	// A re-published plan does NOT take the battery back while the claim
	// stands - the skip is evaluated on every executor pass, not once.
	cb.publishRetained(planTopic, planV2(time.Now(), 1.25, 20))
	time.Sleep(4 * time.Second)
	if v, src, _ := setpointOf(entBattery); src != "desired" || v != 0 {
		t.Fatalf("a fresh plan must not overrule the claim: %v %s", v, src)
	}

	// --- R4: the claim is withdrawn (the rule was switched off in the
	// portal) - the plan takes the battery back on the next push.
	cb.publishRetained(entTopic, claimedRegistryPush(t, "rev-claim-2", false))
	waitFor(t, 60*time.Second, "the plan takes the battery back", func() bool {
		v, src, ok := setpointOf(entBattery)
		return ok && src == "plan" && v == 1.25
	})
	if strings.Contains(fmt.Sprint(eventsSince(mark)), "arbitration:override") {
		t.Fatal("Stufe 3 must not use the D-5 override escape hatch")
	}
}
