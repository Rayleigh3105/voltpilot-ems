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
 *
 * VALIDATION IS STRUCTURAL ONLY (real device-down 2026-07-13): this node checks
 * id / communication / family / connection.ip and NOTHING else - it deliberately
 * carries NO whitelist of communication values. An earlier build whitelisted
 * solarman_v5 + modbus_tcp here and therefore SILENTLY DROPPED the captain's
 * fronius_sunspec Erzeuger before the flow ever saw it: the store node planned
 * nothing, the read node idled with "keine Quellen", and neither data nor a
 * warn appeared anywhere. Deciding WHICH communication is readable is the
 * flow's store node's job (it logs "NICHT VERDRAHTET" for unknown ones);
 * this node must pass every structurally valid source through so that a
 * not-yet-wired transport is at least VISIBLE in the logs, never invisible.
 */
'use strict';

const TOPIC = 'edge/sources/config';
const SCHEMA_VERSION = '1.0';

// parseDetailed() - validate the retained payload STRUCTURALLY into
// { list, dropped } (dropped = human-readable reasons for skipped entries, so
// the node can name them in the log), or null when the payload as a whole is
// unusable (malformed JSON / wrong schema / no sources array) - distinguished
// from a cleared ([]) config.
function parseDetailed(buf) {
  if (!buf || buf.length === 0) return { list: [], dropped: [] };
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null; // malformed JSON: distinguish from a cleared ([]) config
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.schema_version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(obj.sources)) return null;
  const list = [];
  const dropped = [];
  obj.sources.forEach((s, i) => {
    const label =
      s != null && typeof s === 'object' && typeof s.id === 'string' && s.id.trim()
        ? s.id.trim()
        : 'Eintrag #' + (i + 1);
    if (s == null || typeof s !== 'object') {
      dropped.push(label + ': kein Objekt');
      return;
    }
    if (typeof s.id !== 'string' || s.id.trim() === '') {
      dropped.push(label + ': keine id');
      return;
    }
    if (typeof s.communication !== 'string' || s.communication.trim() === '') {
      dropped.push(label + ': keine communication');
      return;
    }
    if (typeof s.family !== 'string' || s.family.trim() === '') {
      dropped.push(label + ': keine family');
      return;
    }
    const conn = s.connection;
    if (conn == null || typeof conn !== 'object' || Array.isArray(conn)
        || typeof conn.ip !== 'string' || conn.ip.trim() === '') {
      dropped.push(label + ': keine connection.ip');
      return;
    }
    list.push(s);
  });
  return { list, dropped };
}

// parse() is exported for unit tests: the list, or null when unusable.
function parse(buf) {
  const d = parseDetailed(buf);
  return d === null ? null : d.list;
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
      const d = parseDetailed(buf);
      if (d === null) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültige Quellen verworfen' });
        node.warn('edge/sources/config: unbrauchbare Quellen-Konfiguration verworfen (JSON/Schema-Version/sources fehlt)');
        return;
      }
      const list = d.list;
      // TRACE (lands in docker compose logs nodered): what arrived and what,
      // if anything, was dropped - so a source that never reaches the flow is
      // visible in ONE device log, without the editor.
      node.log('edge/sources/config: ' + list.length + ' Quelle(n) empfangen'
        + (list.length ? ' [' + list.map((s) => s.id + ':' + s.communication).join(', ') + ']' : ''));
      d.dropped.forEach((why) => node.warn('edge/sources/config: Quelle verworfen - ' + why));
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
module.exports.parseDetailed = parseDetailed;
module.exports.TOPIC = TOPIC;
