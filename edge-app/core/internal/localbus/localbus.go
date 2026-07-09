// Package localbus runs the embedded MQTT broker (mochi-mqtt) that Layer 1
// (Node-RED) connects to. No separate broker container - the bus lives
// in-process and the core reads/writes it through mochi's inline client.
//
// Local topic namespace (documented, small, versionless - LOCAL only, the
// binding contracts govern the cloud side):
//
//	edge/telemetry  Layer 1 -> core   flat measurement JSON:
//	                {"ts"?: RFC3339, "power_kw"?, "soc_pct"?, "pv_power_kw"?,
//	                 "load_kw"?, "grid_limit_kw"?: number}
//	edge/setpoint   core -> Layer 1   RETAINED battery setpoint command:
//	                {"battery_setpoint_kw": number, "source": "schedule"|"default",
//	                 "slot_start"?: RFC3339, "ts": RFC3339}
//	edge/status     Layer 1 -> core   inverter link state (retained):
//	                {"inverter_link": "up"|"down", "ts"?: RFC3339}
//	edge/control/readback  Layer 1 -> core   NOT retained. Per-register
//	                commanded-vs-actual result of an inverter control write, so
//	                the core can show register-level proof + fold a summary into
//	                the cloud status heartbeat. Shape:
//	                {"ts", "family", "source", "slot_start"?, "control_enabled",
//	                 "certified", "all_match", "mismatch_roles":[...],
//	                 "registers":[{"role","fc","addr","commanded_raw",
//	                   "commanded_kw"?,"actual_raw","actual_kw"?,"match"}]}
//	edge/inverter/config  core -> Layer 1   RETAINED inverter selection the
//	                customer made in the local web app (brand/family/
//	                communication/connection). Node-RED reads it to self-wire
//	                the right read adapter. Shape: edge-app/INVERTER-CONFIG.md.
//	edge/sources/config   core -> Layer 1   RETAINED array of ADDITIONAL
//	                read-only measurement points (Phase 1: Erzeuger/PV). Sibling
//	                of edge/inverter/config; Node-RED reads it to self-wire a read
//	                of each source. Shape: internal/sources (BusConfig).
//	edge/sources/{id}/telemetry  Layer 1 -> core   per-source flat measurement
//	                (same shape as edge/telemetry). The core keeps the latest per
//	                source and SUMS PV into the composite site reading; a stale
//	                source contributes nothing (absent, never a fabricated 0).
package localbus

import (
	"log/slog"

	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/hooks/auth"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"
)

// Topics of the local bus namespace.
const (
	TopicTelemetry       = "edge/telemetry"
	TopicSetpoint        = "edge/setpoint"
	TopicStatus          = "edge/status"
	TopicInverterConfig  = "edge/inverter/config"
	TopicControlReadback = "edge/control/readback"
)

// Bus wraps the embedded broker.
type Bus struct {
	server *mqtt.Server
}

// Start brings the embedded broker up on addr (e.g. ":1883").
// The bus is a LAN-local trust zone (the compose network / the device
// itself); it deliberately runs open like the dev EMQX listener.
func Start(addr string, logger *slog.Logger) (*Bus, error) {
	server := mqtt.New(&mqtt.Options{InlineClient: true})
	if logger != nil {
		server.Log = logger
	}
	if err := server.AddHook(new(auth.AllowHook), nil); err != nil {
		return nil, err
	}
	tcp := listeners.NewTCP(listeners.Config{ID: "local-bus", Address: addr})
	if err := server.AddListener(tcp); err != nil {
		return nil, err
	}
	go func() {
		if err := server.Serve(); err != nil {
			slog.Error("local bus stopped", "err", err)
		}
	}()
	return &Bus{server: server}, nil
}

// Subscribe registers an inline handler for a local topic.
func (b *Bus) Subscribe(topic string, id int, fn func(topic string, payload []byte)) error {
	return b.server.Subscribe(topic, id, func(cl *mqtt.Client, sub packets.Subscription, pk packets.Packet) {
		fn(pk.TopicName, pk.Payload)
	})
}

// Publish sends a message on the local bus.
func (b *Bus) Publish(topic string, payload []byte, retain bool) error {
	return b.server.Publish(topic, payload, retain, 1)
}

// Close shuts the broker down.
func (b *Bus) Close() error {
	return b.server.Close()
}
