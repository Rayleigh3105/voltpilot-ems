/**
 * vp-modbus-switch-test - the EXECUTOR of the guided switch test
 * (Einheitsmodell Stufe 4, contract docs/contracts/mqtt-probe.schema.json ops
 * `switch_test` / `switch_cancel`).
 *
 * The core admits the cloud's one-shot request (identity, expiry, PRIVATE
 * target, rate limit - internal/probe), ARMS the auto-off watchdog and only
 * then hands the single already-validated write down on the local bus:
 *
 *   edge/switch/request  { request_id, ops:[{id, host, port, unit_id, fc,
 *                                            address, value, readback_address?}] }
 *   edge/switch/result   { request_id, results:[{id, ok, readback?,
 *                                                error_code?, message?}] }
 *
 * WHY IT IS A SEPARATE NODE FROM vp-modbus-probe: that node's read-only
 * property is worth keeping as a property of the CODE, not of a convention. All
 * writing lives here and in vp-modbus-switch, both through the SAME per-target
 * connection manager (lib/modbus-conn.js) - one socket law for reading and
 * switching, so a test never displaces the running poll of the very device the
 * customer is watching.
 *
 * IT DECIDES NOTHING. Which register, which two values, whether a write is
 * allowed at all - all of that was settled before the message reached the bus.
 * This node performs exactly what it is handed and names every failure.
 */
'use strict';

const sw = require('../lib/switch-write.js');

const REQUEST_TOPIC = 'edge/switch/request';
const RESULT_TOPIC = 'edge/switch/result';

const MAX_OPS = 8;

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
  if (!Array.isArray(obj.ops) || obj.ops.length === 0 || obj.ops.length > MAX_OPS) return null;
  return obj;
}

/**
 * runOps() - SEQUENTIALLY, never concurrently. Two writes to one device racing
 * each other is the one thing a switch executor must not do, and several ops of
 * one request usually aim at the same device anyway.
 */
function runOps(ops, deps) {
  const results = [];
  const step = (i) => {
    if (i >= ops.length) return Promise.resolve(results);
    return sw.runWrite(ops[i], deps).then((r) => {
      results.push(r);
      return step(i + 1);
    });
  };
  return step(0);
}

module.exports = function (RED) {
  function VpModbusSwitchTestNode(config) {
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
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Schalt-Test' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== REQUEST_TOPIC) return;
      const req = parse(buf);
      if (!req) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültiger Schaltbefehl verworfen' });
        return;
      }
      node.status({ fill: 'blue', shape: 'dot', text: 'schalte ' + req.ops.length });
      runOps(req.ops, sw.liveDeps).then((results) => {
        const ok = results.filter((r) => r.ok).length;
        node.status({
          fill: ok === results.length ? 'green' : 'yellow',
          shape: 'dot',
          text: ok + '/' + results.length + ' geschaltet',
        });
        results.forEach((r) => {
          if (!r.ok) node.warn('Schaltbefehl fehlgeschlagen: ' + (r.message || r.error_code));
        });
        // Non-retained: a switch order that reappears on the next reconnect
        // would be the opposite of a one-shot test.
        client.publish(RESULT_TOPIC,
          JSON.stringify({ request_id: req.request_id, results: results }),
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
  RED.nodes.registerType('vp-modbus-switch-test', VpModbusSwitchTestNode);
};

module.exports.parse = parse;
module.exports.runOps = runOps;
module.exports.REQUEST_TOPIC = REQUEST_TOPIC;
module.exports.RESULT_TOPIC = RESULT_TOPIC;
