/**
 * vp-quelle - publishes ONE additional source's reading on the core agent's
 * local bus, on the per-source topic edge/sources/<id>/telemetry. The core keeps
 * the latest PV per source and SUMS it into the composite site reading (it never
 * fabricates a 0 for a silent source). This is the multi-source read sibling of
 * vp-telemetrie (which publishes the one primary reading to edge/telemetry).
 *
 * Input:
 *   msg.source_id  - the source id (from edge/sources/config); REQUIRED.
 *   msg.payload    - an object with pv_power_kw (and optionally ts). Only the
 *                    canonical generation field is forwarded (a source is an
 *                    Erzeuger); the pv_kw alias is accepted.
 *
 * Read-only by construction: there is NO setpoint/control counterpart for a
 * source.
 */
'use strict';

const PREFIX = 'edge/sources/';

// topicFor builds the per-source telemetry topic, or null when the id is unsafe
// (empty or containing an MQTT level separator / wildcard).
function topicFor(id) {
  if (typeof id !== 'string') return null;
  const s = id.trim();
  if (!s || /[/#+]/.test(s)) return null;
  return PREFIX + s + '/telemetry';
}

// shape() is exported for unit tests: normalize a source reading into the
// per-source telemetry message, or null when there is no usable PV.
function shape(payload) {
  if (payload == null || typeof payload !== 'object') return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const pv = num(payload.pv_power_kw !== undefined ? payload.pv_power_kw : payload.pv_kw);
  if (pv === undefined) return null;
  const out = { pv_power_kw: pv };
  if (typeof payload.ts === 'string' && !isNaN(Date.parse(payload.ts))) out.ts = payload.ts;
  return out;
}

module.exports = function (RED) {
  function VpQuelleNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;
    client.on('connect', () => node.status({ fill: 'green', shape: 'dot', text: 'verbunden' }));
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    node.on('input', function (msg, send, done) {
      const topic = topicFor(msg.source_id);
      if (!topic) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'keine source_id' });
        done();
        return;
      }
      const shaped = shape(msg.payload);
      if (!shaped) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'keine Erzeugung im payload' });
        done();
        return;
      }
      client.publish(topic, JSON.stringify(shaped), { qos: 1 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({ fill: 'green', shape: 'dot', text: 'pv ' + shaped.pv_power_kw.toFixed(1) + ' kW' });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-quelle', VpQuelleNode);
};

module.exports.shape = shape;
module.exports.topicFor = topicFor;
module.exports.PREFIX = PREFIX;
