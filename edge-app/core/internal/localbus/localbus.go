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
//	                 "slot_start"?: RFC3339, "ts": RFC3339,
//	                 "control_enabled": bool, "device_certified": bool, ...}
//	                control_enabled is the core's kill-switch ANDed with the
//	                certification verdict; device_certified is that verdict ALONE
//	                (Agent.controlCertified = the env family allowlist MERGED with
//	                the persisted per-device First-Light grant), carried so the
//	                Layer-1 executor's own certification gate can honour a runtime
//	                grant it cannot otherwise see. ADDITIVE: an absent field means
//	                "no runtime grant", i.e. the pre-existing static-allowlist-only
//	                behaviour.
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
//	edge/test-read/request  core -> Layer 1   NOT retained. A one-shot
//	                "Verbindung testen" probe of an UNSAVED connection form:
//	                {request_id, schema_version, role?, brand, model, family,
//	                 communication, connection}. Node-RED runs the existing
//	                route()+decode once against it and answers on:
//	edge/test-read/result   Layer 1 -> core   NOT retained. The one-shot result:
//	                {request_id, ok, error_code?, reading?{pv_kw?,load_kw?,
//	                 grid_kw?,soc_pct?}}. Correlated to the request by request_id.
//	edge/registers/raw   Layer 1 -> core   RETAINED. The raw register blocks
//	                the inverter poll read this cycle, byte-faithful, for the
//	                Modbus-Datenspiegel (internal/mirror):
//	                {"ts": RFC3339, "unit": <mb_slave_id>, "blocks":
//	                 [{"start", "regs":[u16...], "learned"?: true,
//	                   "count"?, "error"?: string}]}.
//	                A "learned" block is one the mirror asked for (see below);
//	                a failed learned read carries error instead of regs and
//	                never aborts the primary poll. ts is the POLL time - the
//	                mirror's staleness guard keys on it, so a stale retained
//	                message after a restart serves nothing as fresh.
//	edge/registers/want  core -> Layer 1   RETAINED. The mirror's auto-learned
//	                want set: {"blocks":[{"start","count"}]}. Node-RED merges
//	                AT MOST ONE of these blocks per poll cycle into the read
//	                plan (round-robin, after the primary blocks, inside the
//	                same sv5 lock that yields to control writes) - the hard
//	                cap that bounds consumer-driven socket load. The control
//	                window 1100-1121 never appears here.
//
// v2 entity topic family (E1a; CONTRACT-grade, unlike the versionless v1
// namespace above - docs/contracts/v2/edge-desired-arbitration.md §1 +
// edge-entity-config.md; topic helpers in internal/entities):
//
//	edge/entities/{id}/config     core -> Layer 1/flows  RETAINED per-entity
//	                registry descriptor (empty payload clears = removed).
//	edge/entities/{id}/telemetry  Layer 1 -> core   per-entity channels.
//	edge/entities/{id}/command    core -> Layer 1   RETAINED guard-clamped
//	                command (core-owned; the edge/setpoint successor).
//	edge/entities/{id}/readback   Layer 1 -> core   v1 readback shape per
//	                entity (the core mirrors the v1 control readback onto the
//	                battery entity's topic).
//	edge/entities/{id}/desired    flow runtime -> core   NOT retained (D-7).
//	                A flow's WISH; the core arbitrates (internal/desired),
//	                clamps the winner and alone publishes .../command.
//	edge/entities/{id}/arbitration  core -> observers   NOT retained. One
//	                decision event per state change (accepted/clamped/
//	                rejected/superseded/expired/released/fallback).
//
// RESERVED local topics for compiled flow data nodes (E2 flowc; fed by the
// core with E4 - until then subscribers stay idle-safe):
//
//	edge/prices       core -> flows  RETAINED day-ahead price series.
//	edge/forecast/pv  core -> flows  RETAINED site PV forecast.
//	edge/notify       flows -> core  NOT retained; customer notification
//	                {schema_version, ts, message} (vp-notify; core-side
//	                consumption/heartbeat forwarding is later work).
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
	TopicTestReadRequest = "edge/test-read/request"
	TopicTestReadResult  = "edge/test-read/result"
	// TopicFlowNodeStatus carries the per-node live state of a deployed flow
	// (Portal v3 M5 Part C): {flow_id, node_id, state, text?, since?}, published
	// by the vp-node-status palette node that flowc wires from the compiled
	// nodes. Read-only telemetry ABOUT a flow - it never commands anything.
	TopicFlowNodeStatus = "edge/flow/node-status"
	// TopicRegistersRaw/Want are the Modbus-Datenspiegel pair (see the header):
	// the poll's raw register blocks up, the mirror's learned want set down.
	TopicRegistersRaw  = "edge/registers/raw"
	TopicRegistersWant = "edge/registers/want"
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
