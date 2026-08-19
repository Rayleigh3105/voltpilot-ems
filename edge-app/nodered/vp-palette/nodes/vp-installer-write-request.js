/**
 * vp-installer-write-request - subscribes the core's ONE-SHOT installer write
 * on the local bus (edge/installer-write/request, NOT retained) and emits it, so
 * the Deye tab can perform it on the SAME socket the poll and the control
 * executor already share.
 *
 * The one register this path exists for is 0x00E7 „Grid Max Export power" - the
 * inverter's own feed-in cap, otherwise reachable only through the installer
 * menu on site. The core has already checked the feature flag, the family
 * allowlist, the value ceiling and the operator's confirm token; this node
 * re-checks address + bound anyway, so „no generic register write exists here"
 * stays a property of the code rather than of the caller.
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

// The ONE allowlisted register + the value ceiling, duplicated here on purpose:
// this node must be able to refuse on its own, without trusting its caller.
// Keep in lockstep with inverter-control-routing.js INSTALLER_WRITE_ADDR/
// INSTALLER_WRITE_MAX_RAW and Go internal/installerwrite.
const ALLOWED_ADDR = 0x00e7;
const MAX_VALUE = 7000;

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
  if (obj.addr !== ALLOWED_ADDR) return null;
  if (!Number.isInteger(obj.value) || obj.value <= 0 || obj.value > MAX_VALUE) return null;
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
module.exports.ALLOWED_ADDR = ALLOWED_ADDR;
module.exports.MAX_VALUE = MAX_VALUE;
