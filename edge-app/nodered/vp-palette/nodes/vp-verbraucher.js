/**
 * vp-verbraucher - publishes ONE consumer (Verbraucher) source's reading on the
 * core agent's local bus, on the per-source topic edge/sources/<id>/telemetry. A
 * consumer measurement point (e.g. a go-e wallbox read over its local HTTP API)
 * forwards its load_kw (>= 0). This is the consumer twin of vp-quelle (which
 * forwards an Erzeuger's pv_power_kw) and vp-netz (a Netz meter's signed
 * power_kw); all three publish on the same per-source topic and the core keeps
 * the latest reading per source, distinguishing them by the source's configured
 * role.
 *
 * Input:
 *   msg.source_id  - the source id (from edge/sources/config); REQUIRED.
 *   msg.payload    - an object with load_kw (>= 0; and optionally ts). Only the
 *                    canonical load field is forwarded; the load alias is accepted.
 *                    A real 0 (device idle / not charging) is valid and forwarded.
 *
 * Read-only by construction: there is NO setpoint/control counterpart for a
 * source.
 */
'use strict';

const PREFIX = 'edge/sources/';

// topicFor builds the per-source telemetry topic, or null when the id is unsafe
// (empty or containing an MQTT level separator / wildcard). Identical guard to
// vp-quelle / vp-netz.
function topicFor(id) {
  if (typeof id !== 'string') return null;
  const s = id.trim();
  if (!s || /[/#+]/.test(s)) return null;
  return PREFIX + s + '/telemetry';
}

// shape() is exported for unit tests: normalize a consumer reading into the
// per-source telemetry message, or null when there is no usable (finite) load
// value. load_kw is a non-negative consumption channel; a real 0 is valid.
function shape(payload) {
  if (payload == null || typeof payload !== 'object') return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const load = num(payload.load_kw !== undefined ? payload.load_kw : payload.load);
  if (load === undefined) return null;
  const out = { load_kw: load };
  if (typeof payload.ts === 'string' && !isNaN(Date.parse(payload.ts))) out.ts = payload.ts;
  return out;
}

module.exports = function (RED) {
  function VpVerbraucherNode(config) {
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
        node.status({ fill: 'yellow', shape: 'ring', text: 'kein Verbrauch im payload' });
        done();
        return;
      }
      client.publish(topic, JSON.stringify(shaped), { qos: 1 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({ fill: 'green', shape: 'dot', text: 'last ' + shaped.load_kw.toFixed(1) + ' kW' });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-verbraucher', VpVerbraucherNode);
};

module.exports.shape = shape;
module.exports.topicFor = topicFor;
module.exports.PREFIX = PREFIX;
