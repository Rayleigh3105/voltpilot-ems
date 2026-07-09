/**
 * vp-netz - publishes ONE grid-meter (Netz) reading on the core agent's local
 * bus, on the per-source topic edge/sources/<id>/telemetry. A dedicated meter at
 * the point of common coupling measures the site's grid power directly; the core
 * keeps the latest reading per source and, for a Netz source, lets its signed
 * power OVERRIDE the primary hybrid inverter's CT (it never fabricates a value
 * for a silent meter). This is the grid twin of vp-quelle (which forwards an
 * Erzeuger's pv_power_kw); both publish on the same per-source topic and the
 * core distinguishes them by the source's configured role.
 *
 * Input:
 *   msg.source_id  - the source id (from edge/sources/config); REQUIRED.
 *   msg.payload    - an object with power_kw (signed, +import/-export; and
 *                    optionally ts). Only the canonical grid field is forwarded;
 *                    the grid_kw alias is accepted.
 *
 * Read-only by construction: there is NO setpoint/control counterpart for a
 * source.
 */
'use strict';

const PREFIX = 'edge/sources/';

// topicFor builds the per-source telemetry topic, or null when the id is unsafe
// (empty or containing an MQTT level separator / wildcard). Identical guard to
// vp-quelle.
function topicFor(id) {
  if (typeof id !== 'string') return null;
  const s = id.trim();
  if (!s || /[/#+]/.test(s)) return null;
  return PREFIX + s + '/telemetry';
}

// shape() is exported for unit tests: normalize a meter reading into the
// per-source telemetry message, or null when there is no usable (finite) grid
// value. The value is signed (+import / -export), so 0 and negatives are valid.
function shape(payload) {
  if (payload == null || typeof payload !== 'object') return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const grid = num(payload.power_kw !== undefined ? payload.power_kw : payload.grid_kw);
  if (grid === undefined) return null;
  const out = { power_kw: grid };
  if (typeof payload.ts === 'string' && !isNaN(Date.parse(payload.ts))) out.ts = payload.ts;
  return out;
}

module.exports = function (RED) {
  function VpNetzNode(config) {
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
        node.status({ fill: 'yellow', shape: 'ring', text: 'kein Netzwert im payload' });
        done();
        return;
      }
      client.publish(topic, JSON.stringify(shaped), { qos: 1 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({ fill: 'green', shape: 'dot', text: 'netz ' + shaped.power_kw.toFixed(1) + ' kW' });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-netz', VpNetzNode);
};

module.exports.shape = shape;
module.exports.topicFor = topicFor;
module.exports.PREFIX = PREFIX;
