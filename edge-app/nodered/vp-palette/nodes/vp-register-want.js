/**
 * vp-register-want - subscribes the RETAINED auto-learn want set the core's
 * Modbus-Datenspiegel publishes on edge/registers/want and emits it, so the
 * inverter poll can extend itself by AT MOST ONE learned block per cycle
 * (round-robin, after the primary blocks, inside the same sv5 socket-lock
 * discipline in which control writes always win).
 *
 * Output msg:
 *   msg.payload = { blocks: [{ start, count }] }   (sanitized)
 *
 * Validation is STRUCTURAL ONLY (the stale-whitelist lesson, 2026-07-13);
 * bounding what actually gets polled - one block per cycle, size/count caps,
 * never the control window 1100-1121 - is the router's job and is enforced
 * there again (defense in depth). An empty/cleared retained payload emits
 * { blocks: [] } so a disabled mirror drops every learned block promptly.
 */
'use strict';

const TOPIC = 'edge/registers/want';

// parse() is exported for unit tests: normalize the retained payload into a
// sanitized want list ({blocks:[]} for empty/cleared), or null for garbage.
function parse(buf) {
  if (!buf || buf.length === 0) return { blocks: [] };
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!Array.isArray(obj.blocks)) return null;
  const blocks = [];
  for (const b of obj.blocks) {
    if (b == null || typeof b !== 'object') continue;
    const start = Number(b.start);
    const count = Number(b.count);
    if (!Number.isInteger(start) || start < 0 || start > 0xffff) continue;
    if (!Number.isInteger(count) || count < 1 || start + count > 0x10000) continue;
    blocks.push({ start, count });
  }
  return { blocks };
}

module.exports = function (RED) {
  function VpRegisterWantNode(config) {
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
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Wunschliste' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== TOPIC) return;
      const want = parse(buf);
      if (!want) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'unbrauchbare Wunschliste verworfen' });
        node.warn('edge/registers/want: unbrauchbare Wunschliste verworfen (JSON/blocks)');
        return;
      }
      node.status({
        fill: want.blocks.length ? 'green' : 'grey',
        shape: 'dot',
        text: want.blocks.length + ' gelernte Bloecke',
      });
      node.send({ payload: want, topic: topic });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-register-want', VpRegisterWantNode);
};

module.exports.parse = parse;
module.exports.TOPIC = TOPIC;
