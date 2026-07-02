/**
 * vp-telemetrie - takes a measurement reading from the customer's I/O flow
 * and publishes it on the core agent's local bus (edge/telemetry). The core
 * stamps identity + sequence, buffers it (store-and-forward) and publishes
 * the binding cloud contract - the flow never sees any of that.
 *
 * Input msg.payload: an object with any of
 *   power_kw, soc_pct, pv_power_kw, load_kw, grid_limit_kw  (numbers)
 *   ts (RFC 3339 string, optional - defaults to "now" in the core)
 * Aliases from the classic acquisition decode are accepted:
 *   grid_kw -> power_kw, pv_kw -> pv_power_kw, batt via power balance is NOT
 *   derived here - the cloud does that.
 */
'use strict';

const TOPIC = 'edge/telemetry';

// shape() is exported for unit tests: normalizes a raw reading into the
// local-bus telemetry message, or returns null when nothing usable is there.
function shape(payload) {
  if (payload == null || typeof payload !== 'object') return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const out = {};
  const set = (k, v) => {
    if (v !== undefined) out[k] = v;
  };
  set('power_kw', num(payload.power_kw !== undefined ? payload.power_kw : payload.grid_kw));
  set('soc_pct', num(payload.soc_pct));
  set('pv_power_kw', num(payload.pv_power_kw !== undefined ? payload.pv_power_kw : payload.pv_kw));
  set('load_kw', num(payload.load_kw));
  set('grid_limit_kw', num(payload.grid_limit_kw));
  if (Object.keys(out).length === 0) return null;
  if (typeof payload.ts === 'string' && !isNaN(Date.parse(payload.ts))) {
    out.ts = payload.ts;
  }
  return out;
}

module.exports = function (RED) {
  function VpTelemetrieNode(config) {
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
      const shaped = shape(msg.payload);
      if (!shaped) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'keine Messwerte im payload' });
        done();
        return;
      }
      client.publish(TOPIC, JSON.stringify(shaped), { qos: 1 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          const p = shaped.pv_power_kw !== undefined ? shaped.pv_power_kw.toFixed(1) : '?';
          node.status({ fill: 'green', shape: 'dot', text: 'pv ' + p + ' kW' });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-telemetrie', VpTelemetrieNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;
