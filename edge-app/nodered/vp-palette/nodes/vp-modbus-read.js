/**
 * vp-modbus-read - the generic Modbus-TCP READ node of the flow runtime
 * (MB-M1, catalog type vp.modbus.read, palette 0.3.0): a trigger tick reads
 * ONE register block from a Modbus-TCP device on the LAN, decodes it
 * (u16/s16/u32/s32/float32 with word order via lib/modbus-tcp.js), applies
 * scale/offset and emits the value as msg.payload (a number). Optionally
 * mapped onto an entity measure channel ({entity, channel} config): each
 * successful read is ALSO published as edge-entity telemetry on
 * edge/entities/{entity}/telemetry (edge-entity contract §3) - from there the
 * normal v2 pipeline records it (buffered uplink -> telemetry_v2 -> rollups ->
 * history/chart), with zero new cloud plumbing.
 *
 * Discipline (the 2026-07-13 poll law, via lib/modbus-conn.js):
 *   - trigger-driven only (the compiled interval/slot-boundary inject is the
 *     poll cadence - no second cadence concept); skip-if-busy per node with a
 *     120 s stale expiry; skip-if-recent per `min_read_interval_s`;
 *   - the shared connection manager serializes per (host, port) across ALL
 *     vp-modbus nodes, fresh socket per read, 8 s/8 s/30 s caps;
 *   - never silent: every failure sets node status + a rate-limited (60 s)
 *     node.warn naming host/address/cause; NO emission on failure
 *     (absent-not-zero - downstream desires expire via their TTL);
 *   - deadband (from a value-change trigger) gates the flow EMISSION only;
 *     the entity telemetry records every successful read.
 *
 * READ-ONLY by construction: this node never writes a register.
 */
'use strict';

const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');

var privateHost = require('../lib/private-host');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const WARN_INTERVAL_MS = 60000;
const BUSY_STALE_MS = 120000;

// computeValue() is exported for unit tests: decode + scale/offset, finite or
// null (never NaN/Infinity into the flow).
function computeValue(regs, cfg) {
  const raw = codec.decodeValue(regs, cfg.dataType, cfg.wordOrder);
  if (raw === null) return null;
  const value = raw * cfg.scale + cfg.offset;
  return isFinite(value) ? value : null;
}

// envelope() is exported for unit tests: the edge-entity §3 telemetry payload
// a mapped read publishes (the exact shape vp-entity-read.parse consumes).
function envelope(entity, channel, value, tsIso) {
  const channels = {};
  channels[channel] = value;
  return JSON.stringify({
    schema_version: '1.0',
    entity_id: entity,
    ts: tsIso,
    channels: channels,
  });
}

module.exports = function (RED) {
  function VpModbusReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    const host = String(config.host || '');
    const port = boundedInt(config.port, 1, 65535, 502);
    const unitId = boundedInt(config.unit_id, 0, 255, 1);
    const fc = config.register_kind === 'input' ? codec.FN_READ_INPUT : codec.FN_READ_HOLDING;
    const address = boundedInt(config.address, 0, 65535, null);
    const dataType = codec.registerCount(String(config.data_type || '')) !== null
      ? String(config.data_type) : 'u16';
    const readCfg = {
      dataType: dataType,
      wordOrder: config.word_order === 'little' ? 'little' : 'big',
      scale: finiteOr(config.scale, 1),
      offset: finiteOr(config.offset, 0),
    };
    const minReadMs = boundedInt(config.min_read_interval_s, 1, 3600, 5) * 1000;
    const entity = String(config.entity || '');
    const channel = String(config.channel || '');
    const mapped = ID_RE.test(entity) && CHANNEL_RE.test(channel);
    const deadband = Math.max(0, Number(config.deadband) || 0);

    if (!host || address === null) {
      node.status({ fill: 'red', shape: 'ring', text: 'Konfiguration ungültig' });
      return;
    }
    // ⚠ LAN-only, auf der BOX geprüft. Portal und api prüfen dieselbe Regel,
    // bevor ein Gerät gespeichert wird - aber ein ausgerollter Flow ist eine
    // Anweisung von aussen, und wer eine Verbindung öffnet, prüft ihr Ziel
    // selbst (die OTA-Sidecar-Disziplin). Der Knoten LIEST dann gar nichts,
    // statt zu klopfen, und sagt laut warum.
    if (!privateHost.isPrivateHost(host)) {
      node.status({ fill: 'red', shape: 'ring', text: privateHost.REFUSAL });
      node.warn('vp-modbus-read: ' + host + ' liegt nicht nachweisbar im Heimnetz - '
        + 'es wird nichts gelesen.');
      return;
    }
    if (mapped && !core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }

    let busySince = 0; // 0 = idle
    let lastDone = 0;
    let lastEmitted = null;
    let lastWarn = 0;
    let hadError = false;
    const label = host + ':' + port + ' Reg ' + address;

    const warnLimited = (text) => {
      const now = Date.now();
      if (now - lastWarn >= WARN_INTERVAL_MS) {
        lastWarn = now;
        node.warn('Modbus-Lesen ' + label + ': ' + text);
      }
    };

    node.on('input', function (msg, send, done) {
      const now = Date.now();
      if (busySince && now - busySince < BUSY_STALE_MS) {
        node.status({ fill: 'grey', shape: 'ring', text: 'übersprungen (Lesung läuft)' });
        done();
        return;
      }
      if (lastDone && now - lastDone < minReadMs) {
        node.status({ fill: 'grey', shape: 'ring', text: 'übersprungen (Mindestabstand)' });
        done();
        return;
      }
      busySince = now;
      conn.readRegisters({
        host: host,
        port: port,
        unitId: unitId,
        fc: fc,
        addr: address,
        count: codec.registerCount(readCfg.dataType),
      })
        .then((regs) => {
          const value = computeValue(regs, readCfg);
          if (value === null) {
            throw new Error('Antwort nicht dekodierbar (' + readCfg.dataType + ')');
          }
          if (hadError) {
            hadError = false;
            node.log('Modbus-Lesen ' + label + ': wieder erreichbar');
          }
          node.status({ fill: 'green', shape: 'dot',
            text: (mapped ? channel + ' ' : '') + value });
          if (mapped && core.client) {
            core.client.publish('edge/entities/' + entity + '/telemetry',
              envelope(entity, channel, value, new Date().toISOString()), { qos: 1 });
          }
          if (lastEmitted === null || deadband === 0
              || Math.abs(value - lastEmitted) >= deadband) {
            lastEmitted = value;
            send({ payload: value, topic: label });
          }
        })
        .catch((err) => {
          // Never silent, never a fabricated value: status + rate-limited
          // warn; downstream simply receives nothing (TTL degradation).
          hadError = true;
          node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 64) });
          warnLimited(String(err.message));
        })
        .then(() => {
          busySince = 0;
          lastDone = Date.now();
          done();
        });
    });
  }

  RED.nodes.registerType('vp-modbus-read', VpModbusReadNode);
};

function boundedInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function finiteOr(v, fallback) {
  // An absent/empty config field falls back; an explicit 0 is kept.
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

module.exports.computeValue = computeValue;
module.exports.envelope = envelope;
