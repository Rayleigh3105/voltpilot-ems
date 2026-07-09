/**
 * vp-test-request - subscribes the core agent's one-shot "Verbindung testen"
 * request on the local bus (edge/test-read/request, NOT retained) and emits it,
 * so a flow can read the (unsaved) selection ONCE and answer via vp-test-result.
 *
 * The customer clicks "Verbindung testen" in the Edge-App web app (:8484); the
 * core publishes the unsaved connection form here, Node-RED runs the same
 * route()+decode the self-wiring poll uses, and answers on edge/test-read/result
 * with the decoded values or a classified error. Read-only, non-retained: it is
 * a confidence check, never a save gate.
 *
 * Output msg:
 *   msg.payload    = the parsed request { request_id, role?, brand, model,
 *                    family, communication, connection } (the selection route()
 *                    consumes, plus the correlation id).
 *   msg.request_id = the correlation id (stable alias).
 */
'use strict';

const TOPIC = 'edge/test-read/request';

// parse() is exported for unit tests: turn the local-bus JSON into the output
// message, or null when it is not a usable test-read request (needs a
// request_id and a connection with an ip).
function parse(buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.request_id !== 'string' || obj.request_id === '') return null;
  const conn = obj.connection;
  if (conn == null || typeof conn !== 'object' || Array.isArray(conn)) return null;
  if (typeof conn.ip !== 'string' || conn.ip.trim() === '') return null;
  return obj;
}

module.exports = function (RED) {
  function VpTestRequestNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;

    const subscribe = () => {
      client.subscribe(TOPIC, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Testanfrage' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== TOPIC) return;
      const req = parse(buf);
      if (!req) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültige Testanfrage verworfen' });
        return;
      }
      node.status({ fill: 'blue', shape: 'dot', text: 'prüfe ' + (req.brand || req.communication || '?') });
      node.send({ payload: req, request_id: req.request_id, topic: topic });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-test-request', VpTestRequestNode);
};

module.exports.parse = parse;
module.exports.TOPIC = TOPIC;
