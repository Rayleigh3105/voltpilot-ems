package agent

// MB-M1 integration test: a MODBUS-GENERIC entity (open catalog type,
// measure-only, CUSTOM channel) works through the existing E1b pipeline with
// zero new plumbing. The publisher stand-in emits the EXACT edge-entity §3
// telemetry envelope the vp-modbus-read palette node publishes on
// edge/entities/{id}/telemetry - the agent must:
//
//	apply the retained registry push (open type accepted, config mirrored
//	  retained on the local bus)
//	accept the custom-channel reading, buffer it with its ORIGINAL ts and
//	  uplink it as mqtt-telemetry-2.0 (-> telemetry_v2 -> rollups -> the
//	  entity history endpoint, cloud-side)
//	report the entity's observed Ist (health ok + the channel) in the
//	  status heartbeat
//
// Measure-only discipline: the entity declares NO actuate capability, so it
// can never be commanded regardless of what anyone publishes - pinned by the
// internal/entities category units; this test pins the DATA path.

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

const entModbusMeter = "5f2a7c11-3b8d-4e92-a4b5-6c7d8e9f0a1b"

// modbusGenericRegistryPush builds a …/v2/entities payload carrying ONE
// measure-only modbus-generic entity with a custom channel (wasser_temp_c) -
// exactly what the cloud registry composes for an MB-M1 mapping target.
func modbusGenericRegistryPush(revision string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"tenant_id":      tTenant,
		"site_id":        tSite,
		"device_id":      tDevice,
		"revision":       revision,
		"published_at":   time.Now().UTC().Format(time.RFC3339),
		"entities": []map[string]any{
			{
				"entity_id":   entModbusMeter,
				"entity_type": "modbus-generic",
				"label":       "Pufferspeicher-Fühler",
				"capabilities": map[string]any{
					"measure": []any{
						map[string]any{"channel": "wasser_temp_c", "unit": "°C"},
					},
				},
				"guards": map[string]any{
					"failsafe": map[string]any{"behavior": "measure-only"},
				},
			},
		},
	})
	return raw
}

func TestModbusGenericEntityRecordsCustomChannelThroughV2Pipeline(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}

	cb := startRestartablePlainBroker(t)
	cb.publishRetained(
		fmt.Sprintf("ems/%s/%s/%s/v2/entities", tTenant, tSite, tDevice),
		modbusGenericRegistryPush("rev-mb-1"))

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

	// The open measure-only type lands as a retained local config.
	var cfgMu sync.Mutex
	configs := map[string]string{}
	sub := pahoClient(t, cfg.LocalMQTTAddr, "mb-watch")
	if tok := sub.Subscribe("edge/entities/+/config", 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			cfgMu.Lock()
			configs[msg.Topic()] = string(msg.Payload())
			cfgMu.Unlock()
		}); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}
	waitFor(t, 15*time.Second, "retained modbus-generic config", func() bool {
		cfgMu.Lock()
		defer cfgMu.Unlock()
		return len(configs["edge/entities/"+entModbusMeter+"/config"]) > 0
	})
	cfgMu.Lock()
	mbCfg := configs["edge/entities/"+entModbusMeter+"/config"]
	cfgMu.Unlock()
	if !strings.Contains(mbCfg, `"entity_type":"modbus-generic"`) ||
		!strings.Contains(mbCfg, `"wasser_temp_c"`) {
		t.Fatalf("modbus-generic config payload wrong: %s", mbCfg)
	}

	// A vp-modbus-read-shaped publisher records a reading with its own ts.
	origTs := time.Now().UTC().Truncate(time.Millisecond).Add(-2 * time.Second)
	pub := pahoClient(t, cfg.LocalMQTTAddr, "mb-pub")
	payload := fmt.Sprintf(
		`{"schema_version":"1.0","entity_id":"%s","ts":"%s","channels":{"wasser_temp_c":48.5}}`,
		entModbusMeter, origTs.Format(time.RFC3339Nano))
	if tok := pub.Publish("edge/entities/"+entModbusMeter+"/telemetry", 1, false,
		[]byte(payload)); tok.Wait() && tok.Error() != nil {
		t.Fatal(tok.Error())
	}

	// The buffered v2 uplink carries the custom channel with the ORIGINAL ts.
	waitFor(t, 15*time.Second, "v2 uplink with the custom channel", func() bool {
		for _, m := range cb.v2Telemetry() {
			if strings.Contains(m, entModbusMeter) && strings.Contains(m, `"wasser_temp_c":48.5`) {
				return true
			}
		}
		return false
	})
	var uplinked string
	for _, m := range cb.v2Telemetry() {
		if strings.Contains(m, entModbusMeter) {
			uplinked = m
		}
	}
	var frame struct {
		SchemaVersion string `json:"schema_version"`
		Ts            string `json:"ts"`
		Entities      map[string]struct {
			Channels map[string]float64 `json:"channels"`
		} `json:"entities"`
	}
	if err := json.Unmarshal([]byte(uplinked), &frame); err != nil {
		t.Fatalf("uplink not parseable: %v\n%s", err, uplinked)
	}
	if frame.SchemaVersion != "2.0" {
		t.Fatalf("uplink must be mqtt-telemetry-2.0, got %q", frame.SchemaVersion)
	}
	entity, ok := frame.Entities[entModbusMeter]
	if !ok {
		t.Fatalf("uplink frame misses the entity: %s", uplinked)
	}
	if entity.Channels["wasser_temp_c"] != 48.5 {
		t.Fatalf("channel value wrong: %v", entity.Channels)
	}
	got, err := time.Parse(time.RFC3339Nano, frame.Ts)
	if err != nil || !got.Equal(origTs) {
		t.Fatalf("uplink must carry the ORIGINAL read ts %s, got %s", origTs, frame.Ts)
	}

	// The heartbeat reports the observed Ist for the meter entity.
	waitFor(t, 25*time.Second, "observed block in heartbeat", func() bool {
		return cb.statusWith(`"observed":{"` + entModbusMeter +
			`":{"entity_type":"modbus-generic","health":"ok"`)
	})
}
