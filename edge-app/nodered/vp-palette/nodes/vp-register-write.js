/**
 * vp-register-write - the EXECUTOR of the plain Modbus-TCP lane of the register
 * write channel (Konzept `vp-reg-schreib-konzept-p8` §2.8 Stufe 2, contract
 * docs/contracts/mqtt-register-write.schema.json, lanes `entity` and `lan`).
 *
 * The core admits the cloud's one-shot order (identity, expiry, replay, lane,
 * PRIVATE target, rate limit - internal/registerwrite), runs POLICY
 * (internal/installerwrite.AdmitExpert) and hands the ONE already-validated
 * operation down on the local bus:
 *
 *   edge/register-write/request  { request_id, mode, kind, addr, value,
 *                                  write_fc?, expected_before?,
 *                                  host, port, unit_id }
 *   edge/register-write/result   { request_id, ok, before?, after?, wrote,
 *                                  error_code?, message? }
 *
 * The message SHAPE is byte-for-byte the one the Solarman executor answers with
 * (edge/installer-write/*), so the core has ONE result type for every lane and a
 * lane added later cannot grow a second correlation mechanism.
 *
 * WHY IT IS ITS OWN NODE, not an option on vp-modbus-switch-test: that node is
 * the guided switch TEST, whose whole point is that the core armed an auto-off
 * before it ran. Here the point is the opposite - the value STAYS. Keeping them
 * apart makes „this write does not revert" and „that write always reverts"
 * properties of the CODE rather than of a flag someone can pass wrongly.
 *
 * WHY IT LIVES IN THE PALETTE AND NOT IN THE CORE: lib/modbus-conn.js holds the
 * box's socket discipline - ONE in-flight operation per (host, port) across ALL
 * vp-modbus nodes in the runtime. Many customer devices serve exactly one TCP
 * client and displace whoever holds it, so a write from the Go core would not be
 * „one more operation", it would break the running poll of the very device the
 * customer is watching.
 *
 * IT DECIDES NO POLICY. Which register, which value, which lane, whether writing
 * is allowed at all - all settled before the message reached the bus. What it
 * DOES re-check is the shape and the PRIVATE target, because whoever opens a
 * connection checks its target themselves (the OTA-sidecar discipline).
 */
'use strict';

const rw = require('../lib/register-write.js');

const REQUEST_TOPIC = 'edge/register-write/request';
const RESULT_TOPIC = 'edge/register-write/result';

/** parse() - structure only; the core owns every policy decision. */
function parse(buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString());
  } catch (e) {
    return null;
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.request_id !== 'string' || obj.request_id === '') return null;
  return obj;
}

module.exports = function (RED) {
  function VpRegisterWriteNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const core = RED.nodes.getNode(config.core);
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'kein vp-core konfiguriert' });
      return;
    }
    const client = core.client;

    const subscribe = () => {
      client.subscribe(REQUEST_TOPIC, { qos: 1 }, (err) => {
        if (err) node.status({ fill: 'red', shape: 'ring', text: 'Abo fehlgeschlagen' });
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Registerauftrag' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== REQUEST_TOPIC) return;
      const req = parse(buf);
      if (!req) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültiger Auftrag verworfen' });
        return;
      }
      const what = (req.mode === rw.MODE_APPLY ? 'schreibe ' : 'lese ') + hex(req.addr);
      node.status({ fill: 'blue', shape: 'dot', text: what });
      rw.runOnce(req, rw.liveDeps).then((res) => {
        node.status({
          fill: res.ok ? 'green' : 'yellow',
          shape: 'dot',
          text: res.ok ? what + ' ok' : (res.error_code || 'fehlgeschlagen'),
        });
        if (!res.ok) node.warn('Registerauftrag fehlgeschlagen: ' + (res.message || res.error_code));
        // Non-retained: a write order that reappeared on the next reconnect
        // would spend another EEPROM write cycle on a customer's device.
        client.publish(RESULT_TOPIC,
          JSON.stringify(Object.assign({ request_id: req.request_id }, res)),
          { qos: 1, retain: false });
      });
    };
    client.on('message', onMessage);

    node.on('close', (done) => {
      client.removeListener('message', onMessage);
      try {
        client.unsubscribe(REQUEST_TOPIC, () => done());
      } catch (e) {
        done();
      }
    });
  }
  RED.nodes.registerType('vp-register-write', VpRegisterWriteNode);
};

function hex(addr) {
  const n = Math.floor(Number(addr));
  if (!isFinite(n) || n < 0) return 'Register';
  return '0x' + n.toString(16).padStart(4, '0');
}

module.exports.parse = parse;
module.exports.REQUEST_TOPIC = REQUEST_TOPIC;
module.exports.RESULT_TOPIC = RESULT_TOPIC;
