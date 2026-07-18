/**
 * vp-notify - the v2 flow runtime's "Benachrichtigung" action: publishes a
 * customer notification on the RESERVED local topic edge/notify (not
 * retained). The core is the intended consumer (fold into the status
 * heartbeat / portal surface - later work); until then notifications are
 * visible on the bus for the rig and diagnostics.
 *
 * The message text comes from the node CONFIG (compiler-stamped, validated) -
 * msg.payload only triggers; a truthy boolean/any message fires once per
 * rising input (no rate limiting here; flows re-emit on triggers, so the
 * dedup keyed on the last sent state keeps this calm).
 */
'use strict';

const TOPIC = 'edge/notify';

// shape() is exported for unit tests.
function shape(message, nowIso) {
  if (typeof message !== 'string' || message.length < 1 || message.length > 200) return null;
  return { schema_version: '1.0', ts: nowIso || new Date().toISOString(), message };
}

module.exports = function (RED) {
  function VpNotifyNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;
    let lastFired = null;

    node.on('input', function (msg, send, done) {
      const active = !!msg.payload;
      if (active === lastFired) {
        done();
        return; // only edges fire - a standing true never floods
      }
      lastFired = active;
      if (!active) {
        node.status({ fill: 'grey', shape: 'ring', text: 'inaktiv' });
        done();
        return;
      }
      const payload = shape(config.message);
      if (!payload) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'kein Nachrichtentext' });
        done();
        return;
      }
      client.publish(TOPIC, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({ fill: 'green', shape: 'dot', text: 'gesendet' });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-notify', VpNotifyNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;
