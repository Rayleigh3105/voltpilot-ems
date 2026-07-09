/**
 * vp-test-result - publishes the one-shot "Verbindung testen" result to the core
 * agent on the local bus (edge/test-read/result, NOT retained). The publish-side
 * twin of vp-test-request: the flow reads the (unsaved) device once and hands the
 * classified outcome here, correlated to the request by request_id.
 *
 * Input msg.payload (the result object built by the test-read function node):
 *   { request_id, ok, error_code?, message?, reading?{pv_kw?,load_kw?,grid_kw?,
 *     soc_pct?} }
 * A payload without a request_id is dropped (it cannot be correlated).
 */
'use strict';

const TOPIC = 'edge/test-read/result';

// shape() is exported for unit tests: pass through a valid result, or null when
// it cannot be correlated (no request_id).
function shape(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.request_id !== 'string' || payload.request_id === '') return null;
  return payload;
}

module.exports = function (RED) {
  function VpTestResultNode(config) {
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
      const res = shape(msg.payload);
      if (!res) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'Ergebnis ohne request_id verworfen' });
        done();
        return;
      }
      // Non-retained: a stale test result must never linger on the bus.
      client.publish(TOPIC, JSON.stringify(res), { qos: 1, retain: false }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({
            fill: res.ok ? 'green' : 'yellow',
            shape: 'dot',
            text: res.ok ? 'Verbindung ok' : (res.error_code || 'Fehler'),
          });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-test-result', VpTestResultNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;
