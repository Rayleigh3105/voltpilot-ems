/**
 * vp-sources-config - subscribes the retained ADDITIONAL-source array the core
 * agent publishes on the local bus (edge/sources/config) and emits it, so a
 * Node-RED flow can SELF-WIRE a read of each additional Erzeuger (PV) source -
 * no per-customer flow edit. It is the multi-source sibling of
 * vp-inverter-config (which carries the ONE battery-hybrid / control source).
 *
 * The customer adds a source once in the Edge-App web UI (:8484), the core
 * (Layer 2) persists it and publishes the whole list RETAINED, and this node
 * hands the current list to the flow the moment it (re)connects.
 *
 * Output msg:
 *   msg.payload  = the parsed source list (array of
 *                  { id, role, brand, model, family, communication, connection,
 *                    interval_s, capacity_kwp }) - [] when the config is cleared.
 *   msg.sources  = the same array (stable alias for the flow's store node).
 *
 * A malformed / wrong-version payload yields [] (never emitted as garbage) -
 * the flow stays idle-safe. Read/monitoring only: a source never gets a control
 * path.
 */
'use strict';

const TOPIC = 'edge/sources/config';
const SCHEMA_VERSION = '1.0';

// parse() is exported for unit tests: validate the retained payload into an
// array of source entries, or [] when it is not usable. Mirrors
// parseSourcesConfig() in ../../sources-routing.js (the routing source of
// truth); kept minimal here so the palette package stays self-contained.
function parse(buf) {
  if (!buf || buf.length === 0) return [];
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null; // malformed JSON: distinguish from a cleared ([]) config
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schema_version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(obj.sources)) return null;
  const out = [];
  obj.sources.forEach((s) => {
    if (s == null || typeof s !== 'object') return;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) return;
    if (s.communication !== 'solarman_v5' && s.communication !== 'modbus_tcp') return;
    if (typeof s.family !== 'string' || s.family.trim() === '') return;
    const conn = s.connection;
    if (conn == null || typeof conn !== 'object' || Array.isArray(conn)) return;
    if (typeof conn.ip !== 'string' || conn.ip.trim() === '') return;
    out.push(s);
  });
  return out;
}

module.exports = function (RED) {
  function VpSourcesConfigNode(config) {
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
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Quellen' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== TOPIC) return;
      const list = parse(buf);
      if (list === null) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültige Quellen verworfen' });
        return;
      }
      node.status({
        fill: list.length ? 'green' : 'grey',
        shape: list.length ? 'dot' : 'ring',
        text: list.length ? list.length + ' Quelle(n)' : 'keine Quellen',
      });
      node.send({ payload: list, sources: list, topic: topic });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-sources-config', VpSourcesConfigNode);
};

module.exports.parse = parse;
module.exports.TOPIC = TOPIC;
