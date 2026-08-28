/**
 * vp-installer-write-request - subscribes the core's ONE-SHOT installer write
 * on the local bus (edge/installer-write/request, NOT retained) and emits it, so
 * the Deye tab can perform it on the SAME socket the poll and the control
 * executor already share.
 *
 * The core has already admitted the request through one of two policy scopes:
 * the narrow local :8484 action (0x00E7, 1..7000) or the portal's expert scope
 * (one free holding register, 0..65535). This transport node therefore checks
 * the shared STRUCTURE, not the obsolete narrow allowlist a second time. In
 * particular a dry run carries no write value in the cloud contract; the core
 * serialises that harmless absence as value=0 on the local bus.
 *
 * ⚠ NON-RETAINED is load-bearing: a write order that reappeared on the next
 * reconnect would be the opposite of a one-shot installer write, and 0x00E7
 * lives in EEPROM.
 *
 * Output msg:
 *   msg.payload    = { request_id, mode, register, addr, value }
 *   msg.request_id = the correlation id (stable alias)
 */
'use strict';

const TOPIC = 'edge/installer-write/request';

// The common expert transport carries one 16-bit holding-register word. The
// narrower :8484 bounds are policy and have already run before this bus hop.
const MAX_REGISTER_WORD = 0xffff;

// parse() is exported for unit tests: turn the local-bus JSON into the output
// message, or null when it is not an admissible installer write.
function parse(buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.request_id !== 'string' || obj.request_id === '') return null;
  if (obj.mode !== 'dry_run' && obj.mode !== 'apply') return null;
  if (!Number.isInteger(obj.addr) || obj.addr < 0 || obj.addr > MAX_REGISTER_WORD) return null;
  if (obj.kind !== undefined && obj.kind !== '' && obj.kind !== 'holding') return null;
  // A preview writes nothing, so its value is absent by contract (and 0 on the
  // current Core -> local-bus adapter). Only APPLY requires a register word.
  if (obj.mode === 'apply' &&
      (!Number.isInteger(obj.value) || obj.value < 0 || obj.value > MAX_REGISTER_WORD)) return null;
  if (obj.mode === 'dry_run' && obj.value !== undefined &&
      (!Number.isInteger(obj.value) || obj.value < 0 || obj.value > MAX_REGISTER_WORD)) return null;
  // The OPTIONAL precondition ("write only while the register still reads X").
  // Absent/null = no expectation; anything that is not a register word is not a
  // precondition and the order is dropped rather than written unguarded.
  if (obj.expected_before !== undefined && obj.expected_before !== null &&
      (!Number.isInteger(obj.expected_before) || obj.expected_before < 0 || obj.expected_before > 0xffff)) {
    return null;
  }
  return obj;
}

module.exports = function (RED) {
  function VpInstallerWriteRequestNode(config) {
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
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== TOPIC) return;
      const req = parse(buf);
      if (!req) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'unzulässige Anfrage verworfen' });
        return;
      }
      node.status({ fill: 'blue', shape: 'dot', text: req.mode === 'apply' ? 'schreibt 0x00e7' : 'liest 0x00e7' });
      node.send({ payload: req, request_id: req.request_id, topic: topic });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-installer-write-request', VpInstallerWriteRequestNode);
};

module.exports.parse = parse;
module.exports.TOPIC = TOPIC;
module.exports.MAX_REGISTER_WORD = MAX_REGISTER_WORD;
