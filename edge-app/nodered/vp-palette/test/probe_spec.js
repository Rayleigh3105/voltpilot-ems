/**
 * vp-modbus-probe (Einheitsmodell Stufe 0b): the pure shaping/classification
 * units, the SOCKET DISCIPLINE proof (a probe shares the ONE queue with
 * vp-modbus-read - it never opens a second connection to the same target), and
 * the node end to end against an aedes local bus + an in-process Modbus server.
 */
'use strict';

const assert = require('node:assert');
const net = require('node:net');
const aedes = require('aedes');
const helper = require('node-red-node-test-helper');

const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');
const vpCore = require('../nodes/vp-core.js');
const vpModbusProbe = require('../nodes/vp-modbus-probe.js');
const vpModbusRead = require('../nodes/vp-modbus-read.js');

helper.init(require.resolve('node-red'));

/** The same in-process Modbus-TCP server shape modbus_spec.js uses. */
function startModbusServer({ regs = {}, delayMs = 0, respond = true, exception = 0 } = {}) {
  const state = { pending: 0, maxPending: 0, reads: 0 };
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.on('data', (buf) => {
      if (!respond) return;
      const txid = buf.readUInt16BE(0);
      const unit = buf[6];
      const fn = buf[7];
      const addr = buf.readUInt16BE(8);
      const count = buf.readUInt16BE(10);
      state.reads += 1;
      state.pending += 1;
      state.maxPending = Math.max(state.maxPending, state.pending);
      let res;
      if (exception) {
        res = Buffer.alloc(9);
        res.writeUInt16BE(txid, 0);
        res.writeUInt16BE(0, 2);
        res.writeUInt16BE(3, 4);
        res[6] = unit;
        res[7] = fn | 0x80;
        res[8] = exception;
        res = res.subarray(0, 9);
      } else {
        const words = [];
        for (let i = 0; i < count; i++) words.push((regs[addr + i] || 0) & 0xffff);
        res = Buffer.alloc(9 + words.length * 2);
        res.writeUInt16BE(txid, 0);
        res.writeUInt16BE(0, 2);
        res.writeUInt16BE(3 + words.length * 2, 4);
        res[6] = unit;
        res[7] = fn;
        res[8] = words.length * 2;
        words.forEach((w, i) => res.writeUInt16BE(w, 9 + i * 2));
      }
      setTimeout(() => {
        state.pending -= 1;
        if (!sock.destroyed) sock.write(res);
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe('vp-modbus-probe shaping (pure)', function () {
  it('parse accepts a bounded request and refuses everything else', function () {
    const ok = vpModbusProbe.parse(Buffer.from(JSON.stringify({
      request_id: 'abc', ops: [{ id: 'a' }],
    })));
    assert.strictEqual(ok.request_id, 'abc');

    assert.strictEqual(vpModbusProbe.parse(Buffer.from('nope')), null, 'not JSON');
    assert.strictEqual(vpModbusProbe.parse(Buffer.from('[]')), null, 'array');
    assert.strictEqual(vpModbusProbe.parse(Buffer.from('{"ops":[{}]}')), null, 'no request_id');
    assert.strictEqual(vpModbusProbe.parse(Buffer.from('{"request_id":"a","ops":[]}')), null,
      'no ops');
    const many = { request_id: 'a', ops: [] };
    for (let i = 0; i < 9; i++) many.ops.push({ id: 'o' + i });
    assert.strictEqual(vpModbusProbe.parse(Buffer.from(JSON.stringify(many))), null,
      'more ops than the contract allows');
  });

  it('readPlan derives the word COUNT from the data type and applies defaults', function () {
    const p = vpModbusProbe.readPlan({
      id: 'a', host: ' 192.168.0.9 ', address: 100, data_type: 'u32',
    });
    assert.deepStrictEqual(p, {
      host: '192.168.0.9', port: 502, unitId: 1, fc: codec.FN_READ_HOLDING,
      addr: 100, count: 2,
    });
    const inp = vpModbusProbe.readPlan({
      id: 'a', host: 'x', address: 0, data_type: 'u16', fc: codec.FN_READ_INPUT,
      port: 1502, unit_id: 71,
    });
    assert.strictEqual(inp.fc, codec.FN_READ_INPUT);
    assert.strictEqual(inp.port, 1502);
    assert.strictEqual(inp.unitId, 71);
    assert.strictEqual(inp.count, 1);

    assert.strictEqual(vpModbusProbe.readPlan({ host: '', address: 0, data_type: 'u16' }), null);
    assert.strictEqual(vpModbusProbe.readPlan({ host: 'x', data_type: 'u16' }), null, 'no address');
    assert.strictEqual(vpModbusProbe.readPlan({ host: 'x', address: 0 }), null, 'no data type');
    assert.strictEqual(vpModbusProbe.readPlan({ host: 'x', address: 0, data_type: 'u64' }), null);
  });

  it('classify covers the CLOSED failure set of the two modules we own', function () {
    // Every one of these strings is produced verbatim by lib/modbus-conn.js or
    // lib/modbus-tcp.js parseReadResponse - if one of them is reworded, this
    // test is where it shows.
    const cases = {
      'Verbindungsaufbau-Timeout (8000 ms)': 'unreachable',
      'Verbindung fehlgeschlagen: connect ECONNREFUSED 127.0.0.1:502': 'unreachable',
      'Antwort-Timeout (8000 ms)': 'no_answer',
      'Gesamt-Timeout nach 30000 ms': 'no_answer',
      'Verbindung geschlossen ohne Antwort': 'no_answer',
      'Modbus-Ausnahme 0x02': 'no_answer',
      'Warteschlange für 127.0.0.1:502 voll - älteste Anfrage verworfen': 'timeout',
      'Modbus-TCP-Antwort zu kurz': 'invalid_response',
      'Unit-ID weicht ab: 3': 'invalid_response',
      'unerwartete Modbus-Funktion 0x04': 'invalid_response',
      'Modbus-Nutzlast unvollstaendig': 'invalid_response',
    };
    Object.keys(cases).forEach(function (msg) {
      const c = vpModbusProbe.classify(msg);
      assert.strictEqual(c.code, cases[msg], msg);
      assert.ok(c.message.indexOf(msg) >= 0,
        'the original text must travel with the sentence: ' + msg);
    });
    // Anything unplaceable ends in the "we got something we do not understand"
    // bucket - never a guessed cause.
    const other = vpModbusProbe.classify('irgendetwas voellig anderes');
    assert.strictEqual(other.code, 'invalid_response');
    assert.ok(other.message.length > 0, 'a class without a sentence is a riddle');
  });

  it('runOps keeps every op honest and independent', async function () {
    const seen = [];
    const reader = (plan) => {
      seen.push(plan.addr);
      if (plan.addr === 1) {
        return Promise.reject(new Error('Verbindung fehlgeschlagen: connect ECONNREFUSED'));
      }
      if (plan.addr === 2) return Promise.resolve([0x7fc0, 0x0000]); // NaN float
      return Promise.resolve([94]);
    };
    const results = await vpModbusProbe.runOps([
      { id: 'ok', host: 'h', address: 0, data_type: 'u16' },
      { id: 'dead', host: 'h', address: 1, data_type: 'u16' },
      { id: 'undecodable', host: 'h', address: 2, data_type: 'float32' },
      { id: 'broken', host: 'h', data_type: 'u16' },
    ], reader);

    assert.deepStrictEqual(seen, [0, 1, 2], 'ops run one after another, in order');
    assert.deepStrictEqual(results[0], { id: 'ok', ok: true, raw: 94, registers: [94] });
    assert.strictEqual(results[1].ok, false);
    assert.strictEqual(results[1].error_code, 'unreachable');
    assert.strictEqual(results[2].error_code, 'invalid_response');
    assert.match(results[2].message, /Datentyp/);
    assert.strictEqual(results[3].error_code, 'invalid_request');
    // A failed line NEVER carries a value.
    results.slice(1).forEach((r) => {
      assert.strictEqual(r.raw, undefined);
      assert.ok(r.message.length > 0);
    });
  });
});

describe('vp-modbus-probe socket discipline', function () {
  it('shares the ONE per-target queue with vp-modbus-read (never a second connection)',
    async function () {
      const srv = await startModbusServer({ regs: { 0: 7, 100: 42 }, delayMs: 120 });
      try {
        // A poll-shaped read and a probe fired at the same instant at the SAME
        // device. If the probe opened its own socket, a single-session gateway
        // would displace the running poll - which is exactly why the probe runs
        // through lib/modbus-conn.
        const poll = conn.readRegisters({
          host: '127.0.0.1', port: srv.port, unitId: 1, addr: 0, count: 1 });
        const probe = vpModbusProbe.runOps([
          { id: 'a', host: '127.0.0.1', port: srv.port, address: 100, data_type: 'u16' },
          { id: 'b', host: '127.0.0.1', port: srv.port, address: 0, data_type: 'u16' },
        ], (plan) => conn.readRegisters(plan));
        const [pollRegs, probeResults] = await Promise.all([poll, probe]);
        assert.deepStrictEqual(pollRegs, [7], 'the poll still completes');
        assert.strictEqual(probeResults[0].raw, 42);
        assert.strictEqual(probeResults[1].raw, 7);
        assert.strictEqual(srv.state.maxPending, 1,
          'a probe must never race the poll for the device socket');
      } finally {
        await srv.close();
      }
    });

  it('a device that never answers ends as a named class, not a hang', async function () {
    const srv = await startModbusServer({ respond: false });
    try {
      const results = await vpModbusProbe.runOps([
        { id: 'a', host: '127.0.0.1', port: srv.port, address: 0, data_type: 'u16' },
      ], (plan) => conn.readRegisters(Object.assign({}, plan, {
        readTimeoutMs: 200, overallTimeoutMs: 400,
      })));
      assert.strictEqual(results[0].ok, false);
      assert.strictEqual(results[0].error_code, 'no_answer');
    } finally {
      await srv.close();
    }
  });
});

describe('vp-modbus-probe node', function () {
  let broker;
  let busServer;
  let busPort;

  beforeEach(function (done) {
    broker = aedes();
    busServer = net.createServer(broker.handle);
    busServer.listen(0, '127.0.0.1', function () {
      busPort = busServer.address().port;
      helper.startServer(done);
    });
  });

  afterEach(function (done) {
    helper.unload().then(function () {
      helper.stopServer(function () {
        broker.close(function () {
          busServer.close(done);
        });
      });
    });
  });

  it('answers a bus request with raw + registers per op, non-retained', function (done) {
    startModbusServer({ regs: { 100: 0x0001, 101: 0x86a0 } }).then((srv) => {
      const flow = [
        { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1', port: String(busPort) },
        { id: 'probe1', type: 'vp-modbus-probe', core: 'core1' },
      ];
      broker.subscribe('edge/probe/result', function (packet, cb) {
        cb();
        srv.close().then(() => {
          try {
            assert.strictEqual(packet.retain, false, 'a stale preview must not linger');
            const res = JSON.parse(packet.payload.toString());
            assert.strictEqual(res.request_id, 'deadbeefdeadbeef');
            assert.strictEqual(res.results.length, 2);
            assert.strictEqual(res.results[0].ok, true);
            assert.strictEqual(res.results[0].raw, 100000, 'u32 big-endian over two words');
            assert.deepStrictEqual(res.results[0].registers, [0x0001, 0x86a0],
              'the two 16-bit halves must travel so a wrong word order is visible');
            assert.strictEqual(res.results[1].ok, false);
            assert.strictEqual(res.results[1].error_code, 'unreachable');
            done();
          } catch (e) {
            done(e);
          }
        });
      }, function () {
        setTimeout(function () {
          broker.publish({
            topic: 'edge/probe/request',
            payload: Buffer.from(JSON.stringify({
              request_id: 'deadbeefdeadbeef',
              ops: [
                { id: 'zaehler', host: '127.0.0.1', port: srv.port, unit_id: 1,
                  address: 100, data_type: 'u32', word_order: 'big' },
                // Port 1 on loopback: nothing listens, so this op fails while
                // its neighbour still answers.
                { id: 'tot', host: '127.0.0.1', port: 1, address: 0, data_type: 'u16' },
              ],
            })),
            qos: 1,
          }, function () {});
        }, 400);
      });
      helper.load([vpCore, vpModbusProbe, vpModbusRead], flow, function () {});
    }).catch(done);
  });

  it('drops a malformed request without answering', function (done) {
    const flow = [
      { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1', port: String(busPort) },
      { id: 'probe1', type: 'vp-modbus-probe', core: 'core1' },
    ];
    let answered = false;
    broker.subscribe('edge/probe/result', function (packet, cb) {
      cb();
      answered = true;
    }, function () {
      setTimeout(function () {
        broker.publish({
          topic: 'edge/probe/request',
          payload: Buffer.from('{"ops":[]}'),
          qos: 1,
        }, function () {});
        setTimeout(function () {
          try {
            assert.strictEqual(answered, false,
              'an uncorrelatable request has nobody to answer');
            done();
          } catch (e) {
            done(e);
          }
        }, 500);
      }, 300);
    });
    helper.load([vpCore, vpModbusProbe], flow, function () {});
  });
});
