/**
 * vp-status - reports the inverter link state (up/down) from the customer's
 * I/O flow to the core agent (edge/status, retained), so the local web app
 * can show "Wechselrichter: verbunden/getrennt".
 *
 * Input msg.payload:
 *   boolean            true = up, false = down
 *   "up" | "down"      the state directly
 *   { inverter_link: "up"|"down" }  the full shape
 */
'use strict';

const TOPIC = 'edge/status';
const sourceStatus = require('../../measurements/data-source-status');

// shape() is exported for unit tests: normalizes the input into the
// local-bus status message, or null when it is not a valid link state.
function shape(payload) {
  let link;
  if (typeof payload === 'boolean') link = payload ? 'up' : 'down';
  else if (payload === 'up' || payload === 'down') link = payload;
  else if (payload && typeof payload === 'object' && (payload.inverter_link === 'up' || payload.inverter_link === 'down')) {
    link = payload.inverter_link;
  } else {
    return null;
  }
  return { inverter_link: link, ts: new Date().toISOString() };
}

module.exports = function (RED) {
  function VpStatusNode(config) {
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
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültiger Status verworfen' });
        done();
        return;
      }
      if (shaped.inverter_link === 'down') {
        const evidence = sourceStatus.event({ source_id:'inverter', failed:true, error_class:sourceStatus.errorClass(msg.payload) });
        client.publish(sourceStatus.TOPIC, JSON.stringify(evidence), { qos:1, retain:false });
      }
      // Retained: the core sees the last known link state even after a restart.
      client.publish(TOPIC, JSON.stringify(shaped), { qos: 1, retain: true }, (err) => {
        if (err) {
          node.status({ fill: 'red', shape: 'ring', text: 'Sendefehler' });
          done(err);
        } else {
          node.status({
            fill: shaped.inverter_link === 'up' ? 'green' : 'red',
            shape: 'dot',
            text: 'Wechselrichter ' + (shaped.inverter_link === 'up' ? 'verbunden' : 'getrennt'),
          });
          done();
        }
      });
    });
  }

  RED.nodes.registerType('vp-status', VpStatusNode);
};

module.exports.shape = shape;
module.exports.TOPIC = TOPIC;
