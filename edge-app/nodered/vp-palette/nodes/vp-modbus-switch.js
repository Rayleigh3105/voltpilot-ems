/**
 * vp-modbus-switch - the GENERATED switch executor of a self-built Modbus
 * device (Einheitsmodell Stufe 4, catalog type `vp.modbus.switch`).
 *
 * There is deliberately NO free "Modbus write" building block. This node is
 * generated-only and origin-stamped (the D-19 pattern of vp.consumer.reactive):
 * the palette never offers it, flowc refuses it in a document without the
 * server-stamped modbus-device origin, and the api only compiles it into the
 * device's flow AFTER the per-device release. What it may write is fixed at
 * compile time - one register, and either the two on/off constants or a value
 * inside the released min/max clamp. There is no runtime address and no runtime
 * value outside that.
 *
 * IT SITS IN THE SAME GENERATED FLOW AS THE READ NODES and uses the same
 * per-target connection manager (lib/modbus-conn.js): one socket law for
 * reading and switching, never a second TCP path to the same device (the Deye
 * read-vs-write collision lesson).
 *
 * THREE LEVELS OF DEAD MAN, and the third is honestly missing:
 *   (a) wishes expire by TTL and the arbiter withdraws the command - that
 *       happens upstream and reaches us as a retained CLEAR;
 *   (b) this node re-asserts continuously and, on withdrawal or staleness,
 *       ACTIVELY writes the off/safe value (the Shelly staleness rule - a relay
 *       has no logic of its own to release into);
 *   (c) a generic Modbus device has NO standardised on-device revert timer. If
 *       the box dies, the device stays as it is. The release dialog says so
 *       word for word, and the optional watchdog register (`watchdog_address`)
 *       is the only way to get (c) - written every tick when the device offers
 *       one, absent by default and never invented.
 *
 * THE PLANT-WIDE GATE reaches us as the retained edge/control/gate, because a
 * Node-RED node cannot read the box's env and the entity command's own
 * `control_enabled` carries the INVERTER certification. Fail-closed: no gate
 * message, no write.
 */
'use strict';

const sw = require('../lib/switch-write.js');
const privateHost = require('../lib/private-host.js');

const GATE_TOPIC = 'edge/control/gate';

/** How often an unchanged command is re-written (and the watchdog re-armed). */
const REASSERT_MS = 60000;
/** A command older than this counts as stale - the failsafe writes the safe value. */
const STALE_MS = 180000;
/** The tick that drives re-assert, staleness and the optional watchdog. */
const TICK_MS = 15000;

/**
 * plan() derives the RAW value to write from the arbiter's granted command and
 * the compiled config, or null when nothing may be written. It is exported for
 * unit tests and is the ONE place the two switch kinds differ.
 *
 * `on_off`  - only the two released constants exist. There is no third value.
 * `setpoint`- the wish is clamped to the released [min,max] IN ENGINEERING
 *             UNITS, converted with the released scale/offset, and then clamped
 *             AGAIN on the raw side. Two clamps because a negative scale flips
 *             the order of the raw bounds, and the raw clamp is the one that
 *             makes "kein Wert ausserhalb des Freigegebenen" true whatever the
 *             conversion does.
 */
function plan(cfg, cmd) {
  if (!cfg) return null;
  if (cfg.kind === 'on_off') {
    let on = null;
    if (typeof cmd.on_off === 'boolean') on = cmd.on_off;
    else if (typeof cmd.setpoint_kw === 'number') on = cmd.setpoint_kw > 0.005;
    if (on === null) return null;
    return on ? num(cfg.on_value) : num(cfg.off_value);
  }
  if (cfg.kind === 'setpoint') {
    if (typeof cmd.on_off === 'boolean' && cmd.on_off === false) return safeValue(cfg);
    if (typeof cmd.setpoint_kw !== 'number' || !isFinite(cmd.setpoint_kw)) return null;
    const lo = num(cfg.min_value);
    const hi = num(cfg.max_value);
    const clamped = Math.min(Math.max(cmd.setpoint_kw, lo), hi);
    return toRaw(cfg, clamped);
  }
  return null;
}

/**
 * The safe value a failsafe writes: the off constant, or the released safe
 * value converted WITHOUT the operating clamp. That exception is deliberate -
 * the safe value is its own released constant and is normally BELOW the
 * operating minimum (a device whose band starts at 2 kW is switched off at 0),
 * so clamping it into the band would turn "off" into "keep running slowly".
 */
function safeValue(cfg) {
  if (!cfg) return null;
  return cfg.kind === 'on_off' ? clampRaw(num(cfg.off_value)) : rawOf(cfg, num(cfg.safe_value));
}

function toRaw(cfg, value) {
  const raw = rawOf(cfg, value);
  // The raw bounds of the released clamp, in whatever order the scale puts
  // them - a negative scale flips it, and the RAW clamp is the one that makes
  // "no value outside the release" true whatever the conversion does.
  const a = rawOf(cfg, num(cfg.min_value));
  const b = rawOf(cfg, num(cfg.max_value));
  return clampRaw(Math.min(Math.max(raw, Math.min(a, b)), Math.max(a, b)));
}

function rawOf(cfg, value) {
  const scale = Number(cfg.scale);
  const offset = Number(cfg.offset) || 0;
  const s = isFinite(scale) && scale !== 0 ? scale : 1;
  return clampRaw(Math.round((value - offset) / s));
}

function clampRaw(v) {
  if (!isFinite(v)) return 0;
  return Math.min(Math.max(Math.round(v), 0), 65535);
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/** The v1 all_match readback shape the arbitration layer already folds in. */
function readbackPayload(entityId, ts, written, readback, err) {
  const out = {
    schema_version: '1.0',
    entity_id: entityId,
    ts: ts,
    adapter: 'vp-modbus-switch',
    registers: [{ role: 'schalter', commanded: written, actual: readback === undefined ? null : readback, match: readback === undefined ? null : readback === written }],
  };
  if (err) {
    // A FAILED write carries its class and NO all_match: the heartbeat's
    // tri-state `confirmed` must keep meaning "no evidence".
    out.error_code = err.error_code;
    out.message = err.message;
    return out;
  }
  if (readback !== undefined) out.all_match = readback === written;
  return out;
}

module.exports = function (RED) {
  function VpModbusSwitchNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;
    const cfg = {
      kind: config.kind === 'setpoint' ? 'setpoint' : 'on_off',
      host: String(config.host || '').trim(),
      port: Number(config.port) || 502,
      unit_id: config.unit_id === undefined ? 1 : Number(config.unit_id),
      fc: Number(config.fc) || 16,
      address: Number(config.address),
      on_value: config.on_value,
      off_value: config.off_value,
      min_value: config.min_value,
      max_value: config.max_value,
      safe_value: config.safe_value,
      scale: config.scale,
      offset: config.offset,
      readback_address: config.readback_address,
      watchdog_address: config.watchdog_address,
      watchdog_value: config.watchdog_value,
    };
    const entityId = String(config.entity_id || '').trim();
    const cmdTopic = 'edge/entities/' + entityId + '/command';
    const readbackTopic = 'edge/entities/' + entityId + '/readback';

    // A deployed flow is an instruction from OUTSIDE; whoever opens the
    // connection verifies its target itself (the OTA-sidecar discipline).
    if (!privateHost.isPrivateHost(cfg.host)) {
      node.status({ fill: 'red', shape: 'ring', text: privateHost.REFUSAL });
      node.error(privateHost.REFUSAL + ': ' + cfg.host);
      return;
    }

    let gate = null; // fail-closed until the core says otherwise
    let lastCmd = null;
    let lastCmdAt = 0;
    let lastWritten = null;
    let lastAssert = 0;
    let closed = false;

    const write = (value, reason) => {
      const op = {
        id: 'schalter', host: cfg.host, port: cfg.port, unit_id: cfg.unit_id,
        fc: cfg.fc, address: cfg.address, value: value,
        readback_address: cfg.readback_address,
      };
      return sw.runWrite(op, sw.liveDeps).then((r) => {
        const ts = new Date().toISOString();
        if (!r.ok) {
          node.status({ fill: 'red', shape: 'dot', text: r.error_code });
          node.warn('Schaltbefehl fehlgeschlagen: ' + (r.message || r.error_code));
          client.publish(readbackTopic,
            JSON.stringify(readbackPayload(entityId, ts, value, undefined, r)),
            { qos: 1, retain: false });
          return;
        }
        lastWritten = value;
        lastAssert = Date.now();
        node.status({ fill: 'green', shape: 'dot', text: reason + ' ' + value });
        client.publish(readbackTopic,
          JSON.stringify(readbackPayload(entityId, ts, value, r.readback)),
          { qos: 1, retain: false });
      });
    };

    const tick = () => {
      if (closed) return;
      // (c) the optional device watchdog - written every tick when the device
      // offers one. Absent by default; never invented.
      if (cfg.watchdog_address !== undefined && cfg.watchdog_address !== null && gate
        && gate.control_enabled && gate.consumer_control_enabled) {
        sw.runWrite({
          id: 'watchdog', host: cfg.host, port: cfg.port, unit_id: cfg.unit_id,
          fc: cfg.fc, address: Number(cfg.watchdog_address),
          value: Number(cfg.watchdog_value) || 0,
        }, sw.liveDeps).catch(() => {});
      }
      if (!gate || !gate.control_enabled || !gate.consumer_control_enabled) {
        node.status({ fill: 'grey', shape: 'ring', text: 'Steuerung aus' });
        return;
      }
      const safe = safeValue(cfg);
      // (b) withdrawal or staleness -> ACTIVELY write the safe value.
      if (lastCmd === null || Date.now() - lastCmdAt > STALE_MS) {
        if (lastWritten !== safe) void write(safe, 'Failsafe');
        return;
      }
      const want = plan(cfg, lastCmd);
      if (want === null) {
        if (lastWritten !== safe) void write(safe, 'Failsafe');
        return;
      }
      if (want !== lastWritten || Date.now() - lastAssert >= REASSERT_MS) {
        void write(want, 'geschaltet');
      }
    };

    const subscribe = () => {
      client.subscribe(cmdTopic, { qos: 1 }, () => {});
      client.subscribe(GATE_TOPIC, { qos: 1 }, () => {});
      node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Befehl' });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);

    const onMessage = (topic, buf) => {
      if (topic === GATE_TOPIC) {
        try {
          gate = JSON.parse(buf.toString());
        } catch (e) {
          gate = null;
        }
        return;
      }
      if (topic !== cmdTopic) return;
      if (!buf || buf.length === 0) {
        // Retained clear = released. The failsafe on the next tick writes the
        // safe value; the absence of a command IS the withdrawal.
        lastCmd = null;
        return;
      }
      try {
        const msg = JSON.parse(buf.toString());
        if (msg && msg.entity_id === entityId && msg.commands) {
          lastCmd = msg.commands;
          lastCmdAt = Date.now();
        }
      } catch (e) {
        node.warn('Befehl unlesbar');
      }
      tick();
    };
    client.on('message', onMessage);

    const timer = setInterval(tick, TICK_MS);

    node.on('close', (done) => {
      closed = true;
      clearInterval(timer);
      client.removeListener('message', onMessage);
      done();
    });
  }
  RED.nodes.registerType('vp-modbus-switch', VpModbusSwitchNode);
};

module.exports.plan = plan;
module.exports.safeValue = safeValue;
module.exports.readbackPayload = readbackPayload;
module.exports.REASSERT_MS = REASSERT_MS;
module.exports.STALE_MS = STALE_MS;
