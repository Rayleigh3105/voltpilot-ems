package agent

// E1b integration test: the generalized entity layer end to end against a
// real (in-process) plain cloud broker + the real embedded local bus.
//
//	retained registry push carrying a WALLBOX (open E1b consumer type)
//	  -> retained edge/entities/{id}/config on the local bus
//	local wallbox telemetry -> mqtt-telemetry-2.0 uplink THROUGH the
//	  store-and-forward buffer (live while connected)
//	cloud OUTAGE -> samples buffer with their ORIGINAL timestamps
//	  -> reconnect replays them oldest-first (v2 rides the v1 discipline)
//	a flow desired on the wallbox -> E2 arbitration -> retained command
//	  clamped to the consumer band [0, max_consumption_kw]
//	the heartbeat carries the per-entity observed Ist (health/channels)
//
// This is the E1b slice of the simulator-rig chain: an arbitrary-type entity
// created in the cloud registry works end to end without any edge release
// knowing "wallbox" specially (no driver - that is E6; Layer 1 here is a
// plain paho stand-in publishing per-entity telemetry).

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

const entWallbox = "8c305f21-9e4d-4f60-c1b2-3d4e5f607182"

// restartablePlainBroker is the plain-cloud stand-in with stop/start on the
// SAME address (the outage/reconnect harness), collecting v2 telemetry and
// status heartbeats.
type restartablePlainBroker struct {
	t      *testing.T
	addr   string
	server *mochi.Server

	mu       sync.Mutex
	v2Msgs   []string
	statuses []string
	retained map[string][]byte
}

func startRestartablePlainBroker(t *testing.T) *restartablePlainBroker {
	t.Helper()
	cb := &restartablePlainBroker{t: t,
		addr:     fmt.Sprintf("127.0.0.1:%d", freePort(t)),
		retained: map[string][]byte{}}
	cb.start()
	t.Cleanup(func() { _ = cb.server.Close() })
	return cb
}

func (cb *restartablePlainBroker) start() {
	server := mochi.New(&mochi.Options{InlineClient: true})
	_ = server.AddHook(new(auth.AllowHook), nil)
	tcp := listeners.NewTCP(listeners.Config{ID: "plain-cloud", Address: cb.addr})
	if err := server.AddListener(tcp); err != nil {
		cb.t.Fatal(err)
	}
	if err := server.Subscribe("ems/+/+/+/v2/telemetry", 81,
		func(cl *mochi.Client, sub packets.Subscription, pk packets.Packet) {
			cb.mu.Lock()
			cb.v2Msgs = append(cb.v2Msgs, string(pk.Payload))
			cb.mu.Unlock()
		}); err != nil {
		cb.t.Fatal(err)
	}
	if err := server.Subscribe("ems/+/+/+/status", 82,
		func(cl *mochi.Client, sub packets.Subscription, pk packets.Packet) {
			cb.mu.Lock()
			cb.statuses = append(cb.statuses, string(pk.Payload))
			cb.mu.Unlock()
		}); err != nil {
		cb.t.Fatal(err)
	}
	go func() { _ = server.Serve() }()
	cb.server = server
	// A restarted in-process broker loses retained state; re-seed what the
	// test previously retained (a real broker keeps it - this is harness
	// bookkeeping, not product behavior).
	cb.mu.Lock()
	retained := make(map[string][]byte, len(cb.retained))
	for topic, payload := range cb.retained {
		retained[topic] = payload
	}
	cb.mu.Unlock()
	for topic, payload := range retained {
		if err := server.Publish(topic, payload, true, 1); err != nil {
			cb.t.Fatal(err)
		}
	}
}

func (cb *restartablePlainBroker) stop() { _ = cb.server.Close() }

func (cb *restartablePlainBroker) publishRetained(topic string, payload []byte) {
	cb.mu.Lock()
	cb.retained[topic] = payload
	cb.mu.Unlock()
	if err := cb.server.Publish(topic, payload, true, 1); err != nil {
		cb.t.Fatal(err)
	}
}

func (cb *restartablePlainBroker) v2Telemetry() []string {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	return append([]string(nil), cb.v2Msgs...)
}

func (cb *restartablePlainBroker) statusWith(substr string) bool {
	cb.mu.Lock()
	defer cb.mu.Unlock()
	for _, s := range cb.statuses {
		if strings.Contains(s, substr) {
			return true
		}
	}
	return false
}

// consumerRegistryPush builds a …/v2/entities payload carrying the E1b
// wallbox (consumer clamp: capability max 11 = rated max_consumption 11).
func consumerRegistryPush(revision string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"revision":       revision,
		"published_at":   time.Now().UTC().Format(time.RFC3339),
		"entities": []map[string]any{
			{
				"entity_id":   entWallbox,
				"entity_type": "wallbox",
				"label":       "Wallbox Carport",
				"capabilities": map[string]any{
					"measure": []any{
						map[string]any{"channel": "power_kw", "unit": "kW"},
						map[string]any{"channel": "energy_kwh", "unit": "kWh"},
					},
					"actuate": []any{
						map[string]any{"command": "setpoint_kw", "min": 0.0, "max": 11.0},
						map[string]any{"command": "on_off"},
						map[string]any{"command": "limit_kw", "max": 11.0},
					},
				},
				"guards": map[string]any{
					"limits":   map[string]any{"max_consumption_kw": 11.0},
					"failsafe": map[string]any{"behavior": "release"},
				},
			},
		},
	})
	return raw
}

func TestWallboxEntityBuffersUplinkAndArbitratesDesired(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	cb := startRestartablePlainBroker(t)
	cb.publishRetained(
		fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		consumerRegistryPush("rev-wb-1"))

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

	// --- the open-vocabulary type lands as a retained local config --------
	var cfgMu sync.Mutex
	configs := map[string]string{}
	sub := pahoClient(t, cfg.LocalMQTTAddr, "wb-watch")
	if tok := sub.Subscribe("edge/entities/+/config", 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			cfgMu.Lock()
			configs[msg.Topic()] = string(msg.Payload())
			cfgMu.Unlock()
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "retained wallbox config", func() bool {
		cfgMu.Lock()
		defer cfgMu.Unlock()
		return len(configs["edge/entities/"+entWallbox+"/config"]) > 0
	})
	cfgMu.Lock()
	wbCfg := configs["edge/entities/"+entWallbox+"/config"]
	cfgMu.Unlock()
	if !strings.Contains(wbCfg, `"entity_type":"wallbox"`) ||
		!strings.Contains(wbCfg, `"max_consumption_kw":11`) {
		t.Fatalf("wallbox config payload wrong: %s", wbCfg)
	}

	// --- live uplink through the buffer -----------------------------------
	pub := pahoClient(t, cfg.LocalMQTTAddr, "wb-pub")
	publishWallbox := func(ts time.Time, powerKw float64) {
		payload := fmt.Sprintf(
			`{"schema_version":"1.0","entity_id":"%s","ts":"%s","channels":{"power_kw":%g}}`,
			entWallbox, ts.UTC().Format(time.RFC3339Nano), powerKw)
		if tok := pub.Publish("edge/entities/"+entWallbox+"/telemetry", 1, false,
			[]byte(payload)); tok.Wait() && tok.Error() != nil {
			t.Fatal(tok.Error())
		}
	}
	publishWallbox(time.Now(), 7.2)
	waitFor(t, 15*time.Second, "live v2 uplink", func() bool {
		return len(cb.v2Telemetry()) >= 1
	})

	// --- heartbeat observed Ist -------------------------------------------
	waitFor(t, 25*time.Second, "observed block in heartbeat", func() bool {
		return cb.statusWith(`"observed":{"` + entWallbox + `":{"entity_type":"wallbox","health":"ok"`)
	})

	// --- outage: v2 samples buffer with ORIGINAL timestamps ---------------
	cb.stop()
	waitFor(t, 15*time.Second, "link notices outage", func() bool {
		return !a.State.Get().CloudConnected
	})
	countBefore := len(cb.v2Telemetry())
	pendingBefore := a.State.Get().BufferPending
	var offlineTs []time.Time
	for i := 0; i < 3; i++ {
		ts := time.Now().UTC().Truncate(time.Millisecond)
		offlineTs = append(offlineTs, ts)
		publishWallbox(ts, 3.0+float64(i))
		time.Sleep(30 * time.Millisecond)
	}
	waitFor(t, 10*time.Second, "v2 buffer growth during outage", func() bool {
		return a.State.Get().BufferPending >= pendingBefore+3
	})

	// --- reconnect: ordered replay, original ts, entity envelope ----------
	cb.start()
	waitFor(t, 60*time.Second, "v2 replay after reconnect", func() bool {
		return len(cb.v2Telemetry()) >= countBefore+3
	})
	type v2msg struct {
		SchemaVersion string  `json:"schema_version"`
		Ts            string  `json:"ts"`
		Seq           float64 `json:"seq"`
		Entities      map[string]struct {
			Channels map[string]float64 `json:"channels"`
		} `json:"entities"`
	}
	var prevSeq float64 = -1
	matched := 0
	for _, raw := range cb.v2Telemetry()[countBefore:] {
		var m v2msg
		if err := json.Unmarshal([]byte(raw), &m); err != nil {
			t.Fatal(err)
		}
		if m.SchemaVersion != "2.0" {
			t.Fatalf("replayed v2 message wrong version: %s", raw)
		}
		if m.Seq <= prevSeq {
			t.Fatalf("v2 replay out of order: seq %v after %v", m.Seq, prevSeq)
		}
		prevSeq = m.Seq
		if _, ok := m.Entities[entWallbox]; !ok {
			t.Fatalf("replayed message lost its entity envelope: %s", raw)
		}
		ts, err := time.Parse(time.RFC3339Nano, m.Ts)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range offlineTs {
			if ts.Equal(want) {
				matched++
			}
		}
	}
	if matched < 3 {
		t.Fatalf("replayed v2 samples must keep their ORIGINAL timestamps, matched %d of 3", matched)
	}

	// --- a flow desired flows through E2 arbitration into the clamped
	// retained command (consumer band [0, 11]) ------------------------------
	cmdCh := make(chan string, 8)
	if tok := sub.Subscribe("edge/entities/"+entWallbox+"/command", 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			if len(msg.Payload()) == 0 {
				return
			}
			select {
			case cmdCh <- string(msg.Payload()):
			default:
			}
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	desired := fmt.Sprintf(`{
		"schema_version": "1.0",
		"entity_id": %q,
		"request_id": "n1:boost-1",
		"source": {"kind": "flow", "flow_id": "f1", "flow_version": 1, "node_id": "n1"},
		"priority": "flow",
		"command": {"type": "setpoint_kw", "value": 22.0},
		"ttl_s": 300,
		"issued_at": %q
	}`, entWallbox, time.Now().UTC().Format(time.RFC3339))
	if tok := pub.Publish("edge/entities/"+entWallbox+"/desired", 1, false,
		[]byte(desired)); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	var cmd struct {
		EntityID string `json:"entity_id"`
		Source   string `json:"source"`
		Commands struct {
			SetpointKw *float64 `json:"setpoint_kw"`
		} `json:"commands"`
	}
	waitFor(t, 15*time.Second, "clamped wallbox command", func() bool {
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
	if cmd.EntityID != entWallbox || cmd.Source != "desired" {
		t.Fatalf("wallbox command identity wrong: %+v", cmd)
	}
	if *cmd.Commands.SetpointKw != 11 {
		t.Fatalf("consumer clamp must cap 22 -> 11 kW, got %v", *cmd.Commands.SetpointKw)
	}
}
