/**
 * vp-modbus-probe - the EXECUTOR of the Probe-Kanal (Einheitsmodell Stufe 0b,
 * contract docs/contracts/mqtt-probe.schema.json).
 *
 * The core receives the cloud's one-shot probe, decides whether it may run at
 * all (identity, expiry, private target, rate limit - internal/probe) and hands
 * the ALREADY-VALIDATED read steps here on the local bus:
 *
 *   edge/probe/request  { request_id, ops:[{id, host, port, unit_id, fc,
 *                                           address, data_type, word_order}] }
 *   edge/probe/result   { request_id, results:[{id, ok, raw?, registers?,
 *                                               error_code?, message?}] }
 *
 * WHY THIS LIVES IN THE PALETTE AND NOT IN THE CORE, and it is the whole reason
 * the node exists: the box's Modbus socket discipline lives in
 * lib/modbus-conn.js - ONE in-flight operation per (host, port) across ALL
 * vp-modbus nodes in the runtime, a fresh socket per operation, fixed caps, a
 * bounded queue. Many customer devices (Solarman loggers, cheap gateways) serve
 * exactly one TCP client and displace whoever holds it. A preview that opened
 * its own socket from the Go core would therefore not be "one more read" - it
 * would silently break the running poll of the very device the customer is
 * looking at. Running the probe through the same queue means a preview WAITS
 * for the poll and vice versa, which is exactly the intended behaviour.
 *
 * READ-ONLY by construction: this node has no write path. The contract's
 * reserved `switch_test` op is refused by the CORE (`not_supported`) and never
 * reaches the bus, so there is nothing here that could ever write a register.
 *
 * The ops are executed ONE AFTER ANOTHER, not concurrently: several ops of one
 * request usually target the SAME device, and firing them in parallel would
 * only fill the shared queue with work that must serialize anyway - while
 * making the failure of one op look like the failure of its neighbours.
 */
'use strict';

const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');

const REQUEST_TOPIC = 'edge/probe/request';
const RESULT_TOPIC = 'edge/probe/result';

const ERR_INVALID_REQUEST = 'invalid_request';
const ERR_UNREACHABLE = 'unreachable';
const ERR_NO_ANSWER = 'no_answer';
const ERR_INVALID_RESPONSE = 'invalid_response';
const ERR_TIMEOUT = 'timeout';

const MAX_OPS = 8;

/**
 * parse() is exported for unit tests: turn the local-bus JSON into the request,
 * or null when it is not a usable probe request. Structure only - the core owns
 * every policy decision (it is the box's gate); a second, drifting copy of the
 * private-target rule here would be a second truth, not a second lock.
 */
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
 * The failure surface of a read is a CLOSED set from two modules we own -
 * lib/modbus-conn.js (connect/read/overall caps, socket errors, a full queue)
 * and lib/modbus-tcp.js `parseReadResponse` (frame-level refusals). classify()
 * maps that set onto the honest German classes of the testconn vocabulary, by
 * the message PREFIX each of them starts with.
 *
 * The distinction the customer actually acts on:
 *   unreachable      - nobody is at that address (wrong IP / device off / firewall)
 *   no_answer        - somebody is there but does not answer THIS question
 *                      (wrong unit id, wrong register)
 *   invalid_response - a frame came back that is not what we asked for
 *   timeout          - WE never got round to asking (our own queue was full)
 *
 * Anything unplaceable ends in invalid_response - the "we got something we do
 * not understand" bucket. A class is NEVER invented, and the original text
 * always travels with the sentence so nothing is lost on the way up.
 */
const CLASSES = [
  ['Verbindungsaufbau-Timeout',
    ERR_UNREACHABLE, 'Das Gerät ist unter dieser Adresse nicht erreichbar.'],
  ['Verbindung fehlgeschlagen',
    ERR_UNREACHABLE, 'Das Gerät ist unter dieser Adresse nicht erreichbar.'],
  ['Antwort-Timeout',
    ERR_NO_ANSWER, 'Das Gerät antwortet nicht auf diese Anfrage (Unit-ID und Register prüfen).'],
  ['Gesamt-Timeout',
    ERR_NO_ANSWER, 'Das Gerät antwortet nicht auf diese Anfrage (Unit-ID und Register prüfen).'],
  ['Verbindung geschlossen ohne Antwort',
    ERR_NO_ANSWER, 'Das Gerät hat die Verbindung ohne Antwort beendet.'],
  ['Modbus-Ausnahme',
    ERR_NO_ANSWER, 'Das Gerät weist die Anfrage ab - dieses Register gibt es dort vermutlich nicht.'],
  ['Warteschlange',
    ERR_TIMEOUT, 'Das Gerät wird gerade von einer anderen Abfrage belegt. Bitte erneut versuchen.'],
];

function classify(message) {
  const m = String(message || '');
  for (let i = 0; i < CLASSES.length; i++) {
    if (m.indexOf(CLASSES[i][0]) === 0) {
      return { code: CLASSES[i][1], message: CLASSES[i][2] + ' (' + m + ')' };
    }
  }
  return { code: ERR_INVALID_RESPONSE, message: 'Die Antwort des Geräts war nicht lesbar (' + m + ').' };
}

/**
 * readPlan() is exported for unit tests: turn one op into the arguments the
 * shared connection manager takes, or null when the op is unusable. `count` is
 * DERIVED from the data type - a generic read has deliberately no free quantity
 * field, because a wrong word count returns half a number that looks plausible.
 */
function readPlan(op) {
  if (op == null || typeof op !== 'object') return null;
  const host = typeof op.host === 'string' ? op.host.trim() : '';
  if (!host) return null;
  const count = codec.registerCount(String(op.data_type || ''));
  if (count === null) return null;
  const addr = Math.floor(Number(op.address));
  if (!isFinite(addr) || addr < 0 || addr > 65535) return null;
  const port = boundedInt(op.port, 1, 65535, 502);
  const unitId = boundedInt(op.unit_id, 0, 255, 1);
  const fc = op.fc === codec.FN_READ_INPUT ? codec.FN_READ_INPUT : codec.FN_READ_HOLDING;
  return { host: host, port: port, unitId: unitId, fc: fc, addr: addr, count: count };
}

function boundedInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

// runOps() is exported for unit tests with the reader injected, so the whole
// sequencing + classification is provable without a socket.
function runOps(ops, readRegisters) {
  const results = [];
  const step = (i) => {
    if (i >= ops.length) return Promise.resolve(results);
    const op = ops[i];
    const id = typeof op.id === 'string' ? op.id : String(i);
    const plan = readPlan(op);
    if (!plan) {
      results.push({
        id: id, ok: false, error_code: ERR_INVALID_REQUEST,
        message: 'Der Prüfschritt ist unvollständig.',
      });
      return step(i + 1);
    }
    return readRegisters(plan)
      .then((regs) => {
        const raw = codec.decodeValue(regs, String(op.data_type), op.word_order);
        if (raw === null) {
          // A frame came back but does not decode as the requested type - the
          // "Antwort nicht dekodierbar (Datentyp?)" class the wizard shows.
          results.push({
            id: id, ok: false, error_code: ERR_INVALID_RESPONSE,
            message: 'Die Antwort passt nicht zum gewählten Datentyp (' + op.data_type + ').',
          });
          return;
        }
        // raw AND the register words: a wrong word order is only visible when
        // the customer can see the two 16-bit halves.
        results.push({ id: id, ok: true, raw: raw, registers: regs.slice(0, 2) });
      })
      .catch((err) => {
        const c = classify(err && err.message);
        results.push({ id: id, ok: false, error_code: c.code, message: c.message });
      })
      .then(() => step(i + 1));
  };
  return step(0);
}

module.exports = function (RED) {
  function VpModbusProbeNode(config) {
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
        else node.status({ fill: 'grey', shape: 'ring', text: 'wartet auf Prüfanfrage' });
      });
    };
    if (client.connected) subscribe();
    client.on('connect', subscribe);
    client.on('close', () => node.status({ fill: 'red', shape: 'ring', text: 'getrennt' }));

    const onMessage = (topic, buf) => {
      if (topic !== REQUEST_TOPIC) return;
      const req = parse(buf);
      if (!req) {
        node.status({ fill: 'yellow', shape: 'ring', text: 'ungültige Prüfanfrage verworfen' });
        return;
      }
      node.status({ fill: 'blue', shape: 'dot', text: 'prüfe ' + req.ops.length + ' Register' });
      runOps(req.ops, (plan) => conn.readRegisters(plan)).then((results) => {
        const ok = results.filter((r) => r.ok).length;
        node.status({
          fill: ok === results.length ? 'green' : 'yellow',
          shape: 'dot',
          text: ok + '/' + results.length + ' gelesen',
        });
        // Non-retained: a stale preview must never linger on the bus.
        client.publish(RESULT_TOPIC,
          JSON.stringify({ request_id: req.request_id, results: results }),
          { qos: 1, retain: false });
      });
    };
    client.on('message', onMessage);
    node.on('close', function (done) {
      client.removeListener('message', onMessage);
      done();
    });
  }

  RED.nodes.registerType('vp-modbus-probe', VpModbusProbeNode);
};

module.exports.parse = parse;
module.exports.classify = classify;
module.exports.readPlan = readPlan;
module.exports.runOps = runOps;
module.exports.REQUEST_TOPIC = REQUEST_TOPIC;
module.exports.RESULT_TOPIC = RESULT_TOPIC;
