/**
 * vp-inverter-config - subscribes the retained inverter selection the core
 * agent publishes on the local bus (edge/inverter/config) and emits it, so a
 * Node-RED flow can SELF-WIRE the correct read adapter from the customer's
 * choice - no Admin API, no per-customer flow edit.
 *
 * This is the Layer-1 consumer of the edge/inverter/config contract
 * (edge-app/INVERTER-CONFIG.md): the customer picks brand -> family/type ->
 * connection once in the Edge-App web UI, the core (Layer 2) persists it and
 * publishes it RETAINED, and this node hands the current selection to the flow
 * the moment it (re)connects (retain makes that immediate).
 *
 * Output msg:
 *   msg.payload   = the parsed selection { schema_version, brand, label,
 *                   family, communication, connection, updated_at }
 *   msg.inverter  = the same object (stable alias for router function nodes)
 *
 * A malformed / wrong-version payload is dropped (logged as a node status),
 * never emitted - the flow stays idle-safe. Read/monitoring selection only:
 * nothing here controls the inverter.
 */
'use strict';

const TOPIC = 'edge/inverter/config';
const SCHEMA_VERSION = '1.0';

// parse() is exported for unit tests: validate + normalize the retained payload
// into a selection, or null when it is not a usable inverter config. Mirrors
// parseConfig() in ../../inverter-routing.js (the source of truth for routing);
// kept minimal here so the palette package stays self-contained.
function parse(buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schema_version !== SCHEMA_VERSION) return null;
  if (obj.communication !== 'solarman_v5' && obj.communication !== 'modbus_tcp') return null;
  if (typeof obj.family !== 'string' || obj.family.trim() === '') return null;
  const conn = obj.connection;
  if (conn == null || typeof conn !== 'object' || Array.isArray(conn)) return null;
  if (typeof conn.ip !== 'string' || conn.ip.trim() === '') return null;
  return {
    schema_version: obj.schema_version,
    brand: typeof obj.brand === 'string' ? obj.brand : '',
    label: typeof obj.label === 'string' ? obj.label : '',
    family: obj.family.trim(),
    communication: obj.communication,
    connection: conn,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : '',
  };
}

module.exports = function (RED) {
  function VpInverterConfigNode(config) {
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
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Auswahl' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== TOPIC) return;
      // A cleared retained config (empty payload) resets to "no selection".
      if (!buf || buf.length === 0) {
        node.status({ fill: 'grey', shape: 'ring', text: 'keine Auswahl' });
        node.send({ payload: null, inverter: null });
        return;
      }
      const sel = parse(buf);
      if (!sel) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültige Auswahl verworfen' });
        return;
      }
      node.status({
        fill: 'green',
        shape: 'dot',
        text: (sel.label || sel.brand || sel.family) + ' (' + sel.communication + ')',
      });
      node.send({ payload: sel, inverter: sel, topic: topic });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-inverter-config', VpInverterConfigNode);
};

module.exports.parse = parse;
module.exports.TOPIC = TOPIC;
