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
