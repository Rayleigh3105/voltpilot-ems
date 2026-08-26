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
//	edge/installer-write/request  core -> Layer 1   NOT retained. ONE already
//	                admitted write of the ONE allowlisted Deye installer
//	                register 0x00E7 („Grid Max Export power"):
//	                {request_id, mode:"dry_run"|"apply", register:"0x00e7",
//	                 addr, value}. The core has already checked the feature
//	                flag, the family allowlist, the value ceiling and the
//	                operator's confirm token - the node re-checks address and
//	                bound and has nothing else to decide.
//	edge/installer-write/result   Layer 1 -> core   NOT retained. The answer:
//	                {request_id, ok, before?, after?, wrote, error_code?,
//	                 message?}. NON-RETAINED IN BOTH DIRECTIONS is load-bearing:
//	                a write order that reappeared on the next reconnect would be
//	                the exact opposite of a one-shot installer write, and this
//	                register lives in EEPROM.
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
	// TopicProbeRequest/Result are the Probe-Kanal pair (Einheitsmodell Stufe
	// 0b, contract docs/contracts/mqtt-probe.schema.json): the core hands the
	// ALREADY-VALIDATED read steps of a cloud probe down, vp-modbus-probe reads
	// them through the SHARED per-target connection manager (the one queue that
	// also serializes vp-modbus-read - a preview must never take the running
	// poll's socket) and answers here. Non-retained in both directions: a stale
	// preview must not linger on the bus. Read-only - there is no write op on
	// this pair; the WRITING switch ops travel on their own pair below, so
	// vp-modbus-probe stays read-only BY CONSTRUCTION and not by convention.
	TopicProbeRequest = "edge/probe/request"
	TopicProbeResult  = "edge/probe/result"
	// TopicSwitchRequest/Result are the guided SWITCH TEST pair (Einheitsmodell
	// Stufe 4): the core hands ONE already-admitted write down (register,
	// function code and the single value it may write), vp-modbus-switch-test
	// performs it through the SAME shared per-target connection manager as every
	// read - one socket law for reading and switching - and answers here.
	//
	// A SEPARATE pair on purpose: it keeps every write in exactly one node, so
	// the read node's "no write path exists here" stays a property of the code.
	// Non-retained in both directions - a switch order that reappears on the
	// next reconnect would be the opposite of a one-shot test.
	TopicSwitchRequest = "edge/switch/request"
	TopicSwitchResult  = "edge/switch/result"
	// TopicInstallerWriteRequest/Result are the ONE-SHOT INSTALLER WRITE pair
	// (the 0x00E7 „Grid Max Export power" remote lever, internal/installerwrite).
	//
	// A SEPARATE pair on purpose, exactly like the switch-test pair above: it
	// keeps this write in one node, so „the read poll has no write path" stays a
	// property of the code. It rides the SAME per-(host,port) flow-context lock
	// as the Deye poll and the control executor (same tab -> shared flow ctx),
	// so the one-socket law holds without a second connection to the logger.
	TopicInstallerWriteRequest = "edge/installer-write/request"
	TopicInstallerWriteResult  = "edge/installer-write/result"
	// TopicRegisterWriteRequest/Result are the ONE-SHOT write pair of the PLAIN
	// MODBUS-TCP lane (Einheitsmodell Stufe 4's write mechanics WITHOUT the
	// auto-off, driven by the portal's register channel - Konzept
	// vp-reg-schreib-konzept-p8 §2.8 Stufe 2). It is a SEPARATE pair from
	// edge/installer-write/* on purpose: that one addresses the primary inverter
	// over the Solarman logger and resolves its endpoint from the inverter
	// configuration, this one carries an explicit host/port/unit. Same message
	// SHAPE, so the core has one result type for every lane; different executor,
	// because the socket disciplines differ (flow-context lock vs. the palette's
	// per-target connection manager).
	TopicRegisterWriteRequest = "edge/register-write/request"
	TopicRegisterWriteResult  = "edge/register-write/result"
	// TopicControlGate is the RETAINED plant-wide control gate the core owns:
	// {control_enabled, consumer_control_enabled}. A Node-RED executor cannot
	// read the box's env, and the per-entity command's `control_enabled` field
	// carries the INVERTER certification - a plant with no certified inverter
	// would wrongly block a released switch. Fail-closed: no message, no write.
	TopicControlGate = "edge/control/gate"
)

// Bus wraps the embedded broker.
type Bus struct {
	server *mqtt.Server
}

// listenerID names the single TCP listener the bus runs on. Close() needs it
// by name to shut the listener down BEFORE the library walks the client map -
// see the comment there.
const listenerID = "local-bus"

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
	tcp := listeners.NewTCP(listeners.Config{ID: listenerID, Address: addr})
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
//
// ⚠ mochi-mqtt (v2.7.9, and every released version before it) DEADLOCKS its
// own shutdown whenever a client drops while Close() runs. `Clients.
// GetByListener` takes the client-map read lock and then calls `Clients.Len()`,
// which takes the SAME read lock again - and Go's RWMutex documents that a
// recursive RLock blocks as soon as a writer has queued, so that it cannot be
// starved. The writer is the perfectly ordinary post-disconnect
// `Clients.Delete` of any client that happens to drop in that window, so a
// busy bus wedges Close() FOREVER. Reproduced under `-race`; the same two
// stacks (GetByListener/Len blocked on RLock, attachClient/Delete blocked on
// Lock) killed the CI edge release gate on the 600 s go-test timeout.
//
// We cannot reach into the library, so we take the deadlocking call site out
// of the picture instead of trying to dodge its race: shut the listener down
// OURSELVES first, disconnecting its clients through a walk that never locks
// recursively (`Clients.GetAll` copies under one RLock). `TCP.Close` guards
// its client walk with `CompareAndSwapUint32(&l.end, 0, 1)`, so the library's
// own Close() - which runs right after - finds the listener already ended and
// SKIPS `GetByListener` entirely. It still waits for the client goroutines
// (`Listeners.CloseAll` ends in `ClientsWg.Wait()`), so nothing leaks.
//
// Behaviour is unchanged for every client: it still receives the same
// server-shutting-down DISCONNECT it always did, just from us.
func (b *Bus) Close() error {
	b.server.Listeners.Close(listenerID, b.disconnectListenerClients)
	return b.server.Close()
}

// disconnectListenerClients is our own, non-recursive twin of mochi's
// Server.closeListenerClients.
func (b *Bus) disconnectListenerClients(listener string) {
	for _, cl := range b.server.Clients.GetAll() {
		if cl.Net.Listener != listener || cl.Closed() {
			continue
		}
		_ = b.server.DisconnectClient(cl, packets.ErrServerShuttingDown)
	}
}
