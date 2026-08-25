package agent

// Steuerung Stufe 4 „Handeingriffe" (Konzept vp-steuerung-konzept-b3 §3.2 +
// §3.7 B3/B5): the EDGE half, in-process against a real cloud broker, the real
// local bus, the real arbitration and the real guard chain.
//
//	H1  „Automatik pausieren": the plan STOPS commanding, a rule's flow-class
//	    wish is IGNORED, and every entity lands on its REGISTRY FAILSAFE - the
//	    battery on self-consumption, the producer's `release` failsafe clears
//	    its retained command. That is „so, als gäbe es VoltPilot nicht".
//	H2  the pause lifts by the box's OWN clock (the push is retained, so an
//	    absolute instant is the only honest form) and the plan takes over again.
//	H3  a battery override reaches the arbiter even though the CONSUMER master
//	    switch is off - it hangs on VP_CONTROL_ENABLED + the certification
//	    instead (B3). Without that, the storage intervention would be dead on
//	    every plant.
//
// A push WITHOUT the field is byte-for-byte the pre-Stufe-4 case - that is the
// state every assertion starts from.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
)

// pausedRegistryPush is `registryPush` with the operator pause stamped on -
// exactly the additive field EntityRegistryService.composePush adds.
func pausedRegistryPush(t *testing.T, revision string, until *time.Time) []byte {
	t.Helper()
	var push map[string]any
	if err := json.Unmarshal(registryPush(revision, true), &push); err != nil {
		t.Fatal(err)
	}
	if until != nil {
		push["automation_paused_until"] = until.UTC().Format(time.RFC3339)
	}
	out, err := json.Marshal(push)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAutomationPauseFallsEveryComponentToItsFailsafeAndLiftsItself(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	cb := startPlainCloudBroker(t)
	entTopic := fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice)
	planTopic := fmt.Sprintf("ems/%s/%s/%s/v2/plan", tTenant, tSite, tDevice)
	cb.publishRetained(entTopic, registryPush("rev-pause-0", true))

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

	sub := pahoClient(t, cfg.LocalMQTTAddr, "pause-watch")
	var mu sync.Mutex
	commands := map[string][]string{}
	if tok := sub.Subscribe("edge/entities/+/command", 1,
		func(_ pahomqtt.Client, m pahomqtt.Message) {
			mu.Lock()
			commands[m.Topic()] = append(commands[m.Topic()], string(m.Payload()))
			mu.Unlock()
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	last := func(entity string) (map[string]any, bool) {
		mu.Lock()
		defer mu.Unlock()
		list := commands["edge/entities/"+entity+"/command"]
		for i := len(list) - 1; i >= 0; i-- {
			if list[i] == "" {
				return nil, false // retained clear
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

	// pv 5, load 1 -> the self-consumption failsafe wants +4, the registry band
	// caps it at 2. That is the value the pause must land on.
	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now(), 5, 1, 50, 100)

	cb.publishRetained(planTopic, planV2(time.Now(), 1.5, 20))
	waitFor(t, 90*time.Second, "plan commands the battery", func() bool {
		v, src, ok := setpointOf(entBattery)
		return ok && src == "plan" && v == 1.5
	})

	// A customer rule holds a standing wish - it must ALSO rest during a pause.
	pub := pahoClient(t, cfg.LocalMQTTAddr, "pause-rule")
	if tok := pub.Publish("edge/entities/"+entBattery+"/desired", 1, false,
		desiredPayload(entBattery, "regel", -1.75, 900, false)); tok.Wait() &&
		tok.Error() != nil {
		t.Fatal(tok.Error())
	}

	// --- H1: pause the plant.
	until := time.Now().Add(20 * time.Second)
	cb.publishRetained(entTopic, pausedRegistryPush(t, "rev-pause-1", &until))
	waitFor(t, 60*time.Second, "the battery falls to its self-consumption failsafe", func() bool {
		v, src, ok := setpointOf(entBattery)
		return ok && src == "failsafe" && v == 2
	})
	waitFor(t, 30*time.Second, "the producer's release failsafe clears its command", func() bool {
		mu.Lock()
		defer mu.Unlock()
		list := commands["edge/entities/"+entProducer+"/command"]
		return len(list) > 0 && list[len(list)-1] == ""
	})
	// A plan re-published DURING the pause changes nothing.
	cb.publishRetained(planTopic, planV2(time.Now(), 1.25, 20))
	time.Sleep(4 * time.Second)
	if v, src, _ := setpointOf(entBattery); src != "failsafe" || v != 2 {
		t.Fatalf("a fresh plan must not break the pause: %v %s", v, src)
	}

	// --- H2: the box lifts the pause by its OWN clock - no second message.
	waitFor(t, 90*time.Second, "the plan takes over again after the pause expired",
		func() bool {
			v, src, ok := setpointOf(entBattery)
			return ok && src == "plan" && v == 1.25
		})
}

func TestABatteryOverrideRidesTheInverterGateNotTheConsumerFlag(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	cb := startPlainCloudBroker(t)
	cb.publishRetained(fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		registryPush("rev-gate", true))

	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	cfg.DevTenantID, cfg.DevSiteID, cfg.DevDeviceID = tTenant, tSite, tDevice
	cfg.DevCloudURL = "tcp://" + cb.addr
	cfg.SetpointInterval = time.Second
	cfg.SetpointIntervalSeconds = 1
	cfg.ControlEnabled = true
	// ⚠ The CONSUMER master switch stays OFF - the default of every plant.
	cfg.ConsumerControlEnabled = false

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
	waitFor(t, 15*time.Second, "registry applied", func() bool {
		a.entMu.Lock()
		defer a.entMu.Unlock()
		return a.entRegistry.Find(entBattery) != nil
	})

	// A STORAGE wish is allowed by the inverter gate (no inverter configured ->
	// the empty family is certified, the dev/sim path).
	if !a.desiredDownlinkAllowed(entBattery) {
		t.Fatal("a battery override must ride VP_CONTROL_ENABLED + certification (B3)")
	}
	// A CONSUMER wish still needs the consumer master switch ...
	if a.desiredDownlinkAllowed(entProducer) {
		t.Fatal("a non-storage wish must still need VP_CONSUMER_CONTROL_ENABLED")
	}
	// ... and an UNKNOWN entity is never widened.
	if a.desiredDownlinkAllowed("00000000-0000-0000-0000-0000000000ff") {
		t.Fatal("an unknown entity must keep the strict gate")
	}

	// The whole downlink is still dead without the master control switch.
	a.Cfg.ControlEnabled = false
	sub := pahoClient(t, cfg.LocalMQTTAddr, "gate-watch")
	var mu sync.Mutex
	var seen int
	if tok := sub.Subscribe("edge/entities/"+entBattery+"/desired", 1,
		func(_ pahomqtt.Client, _ pahomqtt.Message) {
			mu.Lock()
			seen++
			mu.Unlock()
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	a.onDesiredDownlink(desiredPayload(entBattery, "hand", 0, 900, true))
	time.Sleep(time.Second)
	mu.Lock()
	forwarded := seen
	mu.Unlock()
	if forwarded != 0 {
		t.Fatalf("VP_CONTROL_ENABLED off must stop every downlink, saw %d", forwarded)
	}
}
