package agent

// Integration test of the E1a v2 entity layer against a real (in-process)
// PLAIN cloud broker (the dev-identity escape hatch - the mTLS link is proven
// by the full-loop test) and the real embedded local bus:
//
//	retained ems/{t}/{s}/{d}/v2/entities push  ->  agent applies the registry
//	  -> per-entity RETAINED edge/entities/{id}/config on the local bus
//	Layer-1 paho publishes edge/entities/{id}/telemetry
//	  -> agent forwards it as mqtt-telemetry-2.0 on .../v2/telemetry
//	the v1 execution path commands the battery
//	  -> retained per-entity command, clamped through the REGISTRY guard band
//	a new push omitting an entity  ->  its retained config is CLEARED
//	the status heartbeat carries the additive `entities` ack block
//
// This is the E1a slice of the simulator-rig chain (edge-simulator-v2.md):
// registry -> retained config -> per-entity guards -> v2 telemetry.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"
	mochi "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
)

const (
	entBattery  = "5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f"
	entProducer = "6a1e3d0f-7c2b-4d4e-af90-1b2c3d4e5f60"
	entMeter    = "7b2f4e10-8d3c-4e5f-b0a1-2c3d4e5f6071"
)

// plainCloudBroker is a stand-in cloud broker WITHOUT TLS (the dev-URL path),
// collecting the device's v2 telemetry + status heartbeats.
type plainCloudBroker struct {
	t      *testing.T
	server *mochi.Server
	addr   string

	mu       sync.Mutex
	v2Msgs   []string
	statuses []string
}

func startPlainCloudBroker(t *testing.T) *plainCloudBroker {
	t.Helper()
	cb := &plainCloudBroker{t: t, addr: fmt.Sprintf("127.0.0.1:%d", freePort(t))}
	cb.server = mochi.New(&mochi.Options{InlineClient: true})
	if err := cb.server.AddHook(new(auth.AllowHook), nil); err != nil {
		t.Fatal(err)
	}
	tcp := listeners.NewTCP(listeners.Config{ID: "plain-cloud", Address: cb.addr})
	if err := cb.server.AddListener(tcp); err != nil {
		t.Fatal(err)
	}
	if err := cb.server.Subscribe("ems/+/+/+/v2/telemetry", 71,
		func(cl *mochi.Client, sub packets.Subscription, pk packets.Packet) {
			cb.mu.Lock()
			cb.v2Msgs = append(cb.v2Msgs, string(pk.Payload))
			cb.mu.Unlock()
		}); err != nil {
		t.Fatal(err)
	}
	if err := cb.server.Subscribe("ems/+/+/+/status", 72,
		func(cl *mochi.Client, sub packets.Subscription, pk packets.Packet) {
			cb.mu.Lock()
			cb.statuses = append(cb.statuses, string(pk.Payload))
			cb.mu.Unlock()
		}); err != nil {
		t.Fatal(err)
	}
	go func() { _ = cb.server.Serve() }()
	t.Cleanup(func() { _ = cb.server.Close() })
	return cb
}

func (cb *plainCloudBroker) publishRetained(topic string, payload []byte) {
	if err := cb.server.Publish(topic, payload, true, 1); err != nil {
		cb.t.Fatal(err)
	}
}

func (cb *plainCloudBroker) v2Telemetry() []string {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return append([]string(nil), cb.v2Msgs...)
}

func (cb *plainCloudBroker) statusWith(substr string) bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	for _, s := range cb.statuses {
		if strings.Contains(s, substr) {
			return true
		}
	}
	return false
}

// registryPush builds a …/v2/entities payload for the dev identity: a battery
// with a DELIBERATELY TIGHT registry band (2 kW - tighter than the device
// config's 50 kW, so a clamp at 2 proves the ENTITY guard chain did it), a
// producer with a nameplate, and a measure-only grid meter.
func registryPush(revision string, includeProducer bool) []byte {
	no := false
	entities := []map[string]any{
		{
			"entity_id":   entBattery,
			"entity_type": "battery-hybrid",
			"capabilities": map[string]any{
				"measure": []any{map[string]any{"channel": "soc_pct", "unit": "%"}},
				"actuate": []any{
					map[string]any{"command": "setpoint_kw", "min": -2.0, "max": 2.0},
					map[string]any{"command": "limit_kw"},
				},
			},
			"guards": map[string]any{
				"limits": map[string]any{
					"max_charge_kw":            2.0,
					"max_discharge_kw":         2.0,
					"soc_min_pct":              5.0,
					"soc_max_pct":              95.0,
					"charge_from_grid_allowed": &no,
				},
				"failsafe": map[string]any{"behavior": "self-consumption"},
			},
		},
		{
			"entity_id":   entMeter,
			"entity_type": "grid-meter",
			"capabilities": map[string]any{
				"measure": []any{map[string]any{"channel": "power_kw", "unit": "kW"}},
			},
			"guards": map[string]any{"failsafe": map[string]any{"behavior": "measure-only"}},
		},
	}
	if includeProducer {
		entities = append(entities, map[string]any{
			"entity_id":   entProducer,
			"entity_type": "producer",
			"capabilities": map[string]any{
				"measure": []any{map[string]any{"channel": "pv_power_kw", "unit": "kW"}},
				"actuate": []any{map[string]any{"command": "limit_kw", "max": 27.0}},
			},
			"guards": map[string]any{
				"limits":   map[string]any{"max_generation_kw": 27.0},
				"failsafe": map[string]any{"behavior": "release"},
			},
		})
	}
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"revision":       revision,
		"published_at":   time.Now().UTC().Format(time.RFC3339),
		"entities":       entities,
	})
	return raw
}

func TestEntityLayerRegistryToConfigGuardsAndV2Telemetry(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	cb := startPlainCloudBroker(t)
	// The registry is already retained when the device first connects - the
	// convergence-from-retention property the push contract relies on.
	cb.publishRetained(
		fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		registryPush("rev-1", true))

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

	// --- retained per-entity configs on the local bus (D-3) ---------------
	configs := map[string]string{}
	var cfgMu sync.Mutex
	sub := pahoClient(t, cfg.LocalMQTTAddr, "cfg-watch")
	if tok := sub.Subscribe("edge/entities/+/config", 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			cfgMu.Lock()
			configs[msg.Topic()] = string(msg.Payload())
			cfgMu.Unlock()
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "three retained entity configs", func() bool {
		cfgMu.Lock()
		defer cfgMu.Unlock()
		return len(configs[`edge/entities/`+entBattery+`/config`]) > 0 &&
			len(configs[`edge/entities/`+entProducer+`/config`]) > 0 &&
			len(configs[`edge/entities/`+entMeter+`/config`]) > 0
	})
	cfgMu.Lock()
	if !strings.Contains(configs[`edge/entities/`+entBattery+`/config`], `"self-consumption"`) ||
		!strings.Contains(configs[`edge/entities/`+entBattery+`/config`], `"revision":"rev-1"`) {
		t.Fatalf("battery config payload wrong: %s", configs[`edge/entities/`+entBattery+`/config`])
	}
	cfgMu.Unlock()

	// --- per-entity local telemetry -> mqtt-telemetry-2.0 uplink ----------
	pub := pahoClient(t, cfg.LocalMQTTAddr, "ent-pub")
	entPayload := fmt.Sprintf(
		`{"schema_version":"1.0","entity_id":"%s","ts":"%s","channels":{"pv_power_kw":44.2}}`,
		entProducer, time.Now().UTC().Format(time.RFC3339))
	if tok := pub.Publish("edge/entities/"+entProducer+"/telemetry", 1, false,
		[]byte(entPayload)); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "v2 telemetry at the cloud broker", func() bool {
		return len(cb.v2Telemetry()) >= 1
	})
	var v2 struct {
		SchemaVersion string `json:"schema_version"`
		TenantID      string `json:"tenant_id"`
		Entities      map[string]struct {
			Channels map[string]float64 `json:"channels"`
		} `json:"entities"`
	}
	if err := json.Unmarshal([]byte(cb.v2Telemetry()[0]), &v2); err != nil {
		t.Fatal(err)
	}
	if v2.SchemaVersion != "2.0" || v2.TenantID != tTenant ||
		v2.Entities[entProducer].Channels["pv_power_kw"] != 44.2 {
		t.Fatalf("v2 uplink payload wrong: %s", cb.v2Telemetry()[0])
	}

	// --- the ENTITY guard chain clamps the mirrored battery command -------
	// v1 telemetry: pv 5 / load 1 / soc 50 -> self-consumption fallback wants
	// +4 kW charge; the device config allows 50, the REGISTRY band only 2.
	cmdCh := make(chan string, 8)
	if tok := sub.Subscribe("edge/entities/"+entBattery+"/command", 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			select {
			case cmdCh <- string(msg.Payload()):
			default:
			}
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now(), 5, 1, 50, 100)
	var cmd struct {
		SchemaVersion string `json:"schema_version"`
		EntityID      string `json:"entity_id"`
		Source        string `json:"source"`
		Commands      struct {
			SetpointKw *float64 `json:"setpoint_kw"`
		} `json:"commands"`
	}
	waitFor(t, 15*time.Second, "clamped entity command", func() bool {
		select {
		case raw := <-cmdCh:
			if err := json.Unmarshal([]byte(raw), &cmd); err != nil {
				return false
			}
			return cmd.Commands.SetpointKw != nil
		default:
			return false
		}
	})
	// Contract vocabulary: the self-consumption fallback surfaces as source
	// "failsafe" (edge-entity-config.md §4), not the v1 "default".
	if cmd.EntityID != entBattery || cmd.Source != "failsafe" {
		t.Fatalf("entity command identity wrong: %+v", cmd)
	}
	if *cmd.Commands.SetpointKw != 2 {
		t.Fatalf("registry guard band must clamp 4 -> 2 kW, got %v", *cmd.Commands.SetpointKw)
	}

	// --- heartbeat carries the additive entities ack block ----------------
	waitFor(t, 25*time.Second, "heartbeat entities block", func() bool {
		return cb.statusWith(`"entities":{"revision":"rev-1"`)
	})

	// --- a new push omitting the producer clears its retained config ------
	cb.publishRetained(
		fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		registryPush("rev-2", false))
	waitFor(t, 15*time.Second, "producer config cleared", func() bool {
		cfgMu.Lock()
		defer cfgMu.Unlock()
		return configs[`edge/entities/`+entProducer+`/config`] == "" &&
			strings.Contains(configs[`edge/entities/`+entBattery+`/config`], `"revision":"rev-2"`)
	})
}

func pahoClient(t *testing.T, addr, id string) pahomqtt.Client {
	t.Helper()
	opts := pahomqtt.NewClientOptions().AddBroker("tcp://" + addr).SetClientID(id)
	c := pahomqtt.NewClient(opts)
	if tok := c.Connect(); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	t.Cleanup(func() { c.Disconnect(100) })
	return c
}
