/**
 * vp-installer-write-result - publishes the ONE-SHOT installer write result to
 * the core (edge/installer-write/result, NOT retained). The publish-side twin of
 * vp-installer-write-request, correlated by request_id.
 *
 * Input msg.payload:
 *   { request_id, ok, before?, after?, wrote, error_code?, message? }
 * `before`/`after` are the raw register words read around the write and are
 * OMITTED when the register could not be read - „not read" and „read as 0" are
 * different facts, and 0 is a legitimate value of 0x00E7 („may not feed in at
 * all"). A payload without a request_id is dropped (it cannot be correlated).
 */
'use strict';

const TOPIC = 'edge/installer-write/result';

// shape() is exported for unit tests: pass through a correlatable result, or
// null. It NORMALISES the two readings to null-or-integer so a downstream
// consumer never has to tell `undefined` from „the device answered 0".
function shape(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (typeof payload.request_id !== 'string' || payload.request_id === '') return null;
  const reg = (v) => (Number.isInteger(v) ? v : null);
  return {
    request_id: payload.request_id,
    ok: payload.ok === true,
    before: reg(payload.before),
    after: reg(payload.after),
    wrote: payload.wrote === true,
    error_code: typeof payload.error_code === 'string' ? payload.error_code : undefined,
    message: typeof payload.message === 'string' ? payload.message : undefined,
  };
}

module.exports = function (RED) {
  function VpInstallerWriteResultNode(config) {
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
      // Non-retained: a stale write result must never linger on the bus.
      client.publish(TOPIC, JSON.stringify(res), { qos: 1, retain: false }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({
            fill: res.ok ? 'green' : 'yellow',
            shape: 'dot',
            text: res.ok ? (res.wrote ? 'geschrieben' : 'gelesen') : (res.error_code || 'Fehler'),
          });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-installer-write-result', VpInstallerWriteResultNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;
