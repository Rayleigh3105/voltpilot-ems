/**
 * vp-entity-read - the v2 flow runtime's data node "Entität lesen":
 * subscribes ONE entity's local telemetry (edge/entities/<entity>/telemetry,
 * contract docs/contracts/v2/edge-entity-config.md §3) and emits one channel's
 * numeric value.
 *
 * Emission model (the flowc compiler's trigger semantics):
 *   - every accepted telemetry sample whose channel value changed by more
 *     than `deadband` (0 = every sample) emits msg.payload = value;
 *   - an INPUT message (from a compiled interval/slot-boundary trigger)
 *     re-emits the LAST known value, so standing desires refresh even while
 *     the value is flat. No value yet -> nothing (never a fabricated 0).
 *
 * Read-only by construction: this node publishes nothing.
 */
'use strict';

const PREFIX = 'edge/entities/';
const SCHEMA_VERSION = '1.0';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{0,63}$/;

// parse() is exported for unit tests: extract the channel value from one
// telemetry payload, or null (identity rule: the payload must name the
// entity; a missing/non-finite channel stays absent).
function parse(entity, channel, buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object') return null;
  if (obj.schema_version !== SCHEMA_VERSION || obj.entity_id !== entity) return null;
  const channels = obj.channels;
  if (channels == null || typeof channels !== 'object') return null;
  const v = channels[channel];
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return v;
}

function telemetryTopic(entity) {
  return PREFIX + entity + '/telemetry';
}

module.exports = function (RED) {
  function VpEntityReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const entity = String(config.entity || '');
    const channel = String(config.channel || '');
    if (!ID_RE.test(entity) || !CHANNEL_RE.test(channel)) {
      node.status({ fill: 'red', shape: 'ring', text: 'Entität/Kanal ungültig' });
      return;
    }
    const deadband = Math.max(0, Number(config.deadband) || 0);
    const client = core.client;
    const topic = telemetryTopic(entity);
    let last = null; // last accepted value
    let lastEmitted = null;

    const subscribe = () => {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Daten' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);

    const emit = (v) => {
      lastEmitted = v;
      node.status({ fill: 'green', shape: 'dot', text: channel + ' ' + v });
      node.send({ payload: v, topic: entity + '/' + channel });
    };
    const onMessage = (msgTopic, buf) => {
      if (msgTopic !== topic) return;
      const v = parse(entity, channel, buf);
      if (v === null) return;
      last = v;
      if (lastEmitted === null || Math.abs(v - lastEmitted) >= deadband || deadband === 0) {
        emit(v);
      }
    };
    client.on('message', onMessage);
    node.on('close', () => client.removeListener('message', onMessage));

    // Trigger input: re-emit the last known value (interval re-evaluation).
    node.on('input', function (msg, send, done) {
      if (last !== null) emit(last);
      done();
    });
  }

  RED.nodes.registerType('vp-entity-read', VpEntityReadNode);
};

module.exports.parse = parse;
module.exports.telemetryTopic = telemetryTopic;
