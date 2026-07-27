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
// into a selection, or null when it is not a usable inverter config.
//
// VALIDATION IS STRUCTURAL ONLY (same class of bug as vp-sources-config, found
// 2026-07-13): an earlier build whitelisted solarman_v5 + modbus_tcp here and
// therefore silently dropped a fronius_solar_api / fronius_sunspec PRIMARY
// selection before the flow ever saw it - the auto tab's router has live
// branches for both, but they were unreachable behind this node. Deciding
// which communication is readable is the router's job (it goes idle with a
// named status for unknown ones); this node passes every structurally valid
// selection through.
function parse(buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schema_version !== SCHEMA_VERSION) return null;
  if (typeof obj.communication !== 'string' || obj.communication.trim() === '') return null;
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
    // control_tier is the battery-control primitive the WRITE-side controlRoute
    // dispatches on. Passed through structurally (validation stays STRUCTURAL, per
    // the 2026-07-13 stale-whitelist lesson); an absent/invalid value lets
    // controlRoute fall back to communication-inference. Only 0..3 are meaningful.
    control_tier: (typeof obj.control_tier === 'number' && obj.control_tier >= 0 && obj.control_tier <= 3)
      ? Math.floor(obj.control_tier) : undefined,
    // rated_kw is the model's CATALOG nameplate (kW), passed through structurally
    // like control_tier. The WRITE side needs it (the Deye remote-mode setpoint is
    // 0.1 % of RATED power); absent -> the control adapter refuses rather than
    // guessing a rating.
    rated_kw: (typeof obj.rated_kw === 'number' && isFinite(obj.rated_kw) && obj.rated_kw > 0)
      ? obj.rated_kw : undefined,
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
        node.warn('edge/inverter/config: unbrauchbare Auswahl verworfen (JSON/Schema-Version/communication/family/connection.ip)');
        return;
      }
      // TRACE (lands in docker compose logs nodered): the selection that
      // reached the flow - so a selection that never wires the router is
      // visible in ONE device log, without the editor.
      node.log('edge/inverter/config: Auswahl ' + (sel.label || sel.brand || sel.family) + ' (' + sel.communication + ', ' + sel.connection.ip + ')');
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
