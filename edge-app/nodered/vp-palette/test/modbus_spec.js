/**
 * vp-modbus-read + lib/modbus-conn (MB-M1): the codec-copy drift guard, pure
 * shaping units, the per-target connection manager against an in-process
 * Modbus-TCP server (serialization, timeouts, bounded queue - the 2026-07-13
 * poll law), and the node end to end (read -> emit; entity mapping observed on
 * an aedes bus; failure = status + warn, never an emission).
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const aedes = require('aedes');
const mqtt = require('mqtt');
const helper = require('node-red-node-test-helper');

const conn = require('../lib/modbus-conn.js');
const codec = require('../lib/modbus-tcp.js');
const vpCore = require('../nodes/vp-core.js');
const vpModbusRead = require('../nodes/vp-modbus-read.js');

helper.init(require.resolve('node-red'));

const REPO_CODEC = path.join(__dirname, '..', '..', 'modbus-tcp.js');

/**
 * A minimal in-process Modbus-TCP server: serves FC3/FC4 reads from a register
 * bank, optionally delayed, and tracks concurrent connections (the
 * serialization proof needs max-concurrency, not just a happy read).
 */
function startModbusServer({ regs = [], delayMs = 0, respond = true } = {}) {
  // pending/maxPending = un-answered requests in flight - the concurrency that
  // matters (socket teardown after an answered read may overlap the next
  // connect for microseconds; a single-session gateway cares about competing
  // REQUESTS, which the manager must serialize to one).
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
      const words = [];
      for (let i = 0; i < count; i++) words.push((regs[addr + i] || 0) & 0xffff);
      const res = Buffer.alloc(9 + words.length * 2);
      res.writeUInt16BE(txid, 0);
      res.writeUInt16BE(0, 2);
      res.writeUInt16BE(3 + words.length * 2, 4);
      res[6] = unit;
      res[7] = fn;
      res[8] = words.length * 2;
      words.forEach((w, i) => res.writeUInt16BE(w, 9 + i * 2));
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

describe('lib/modbus-tcp is the byte-identical synced copy', function () {
  it('matches edge-app/nodered/modbus-tcp.js byte for byte', function () {
    if (!fs.existsSync(REPO_CODEC)) this.skip(); // palette shipped standalone
    const repo = fs.readFileSync(REPO_CODEC, 'utf8');
    const copy = fs.readFileSync(path.join(__dirname, '..', 'lib', 'modbus-tcp.js'), 'utf8');
    assert.strictEqual(copy, repo,
      'lib/modbus-tcp.js drifted from edge-app/nodered/modbus-tcp.js - re-copy the file');
  });
});

describe('vp-modbus-read shaping (pure)', function () {
  it('computeValue decodes, scales and refuses non-finite results', function () {
    const cfg = { dataType: 'float32', wordOrder: 'big', scale: 0.001, offset: 0 };
    assert.strictEqual(vpModbusRead.computeValue([0x4366, 0x4000], cfg), 0.23025);
    assert.strictEqual(vpModbusRead.computeValue([0x7fc0, 0x0000], cfg), null, 'NaN register');
    assert.strictEqual(vpModbusRead.computeValue([0x0001], cfg), null, 'short block');
    const s16cfg = { dataType: 's16', wordOrder: 'big', scale: 0.1, offset: -10 };
    assert.strictEqual(vpModbusRead.computeValue([0xffff], s16cfg), -10.1);
  });

  it('envelope emits the edge-entity §3 telemetry shape vp-entity-read consumes', function () {
    const vpEntityRead = require('../nodes/vp-entity-read.js');
    const raw = vpModbusRead.envelope('modbus-meter-1', 'wasser_temp_c', 42.7,
      '2026-07-21T10:00:00.000Z');
    const obj = JSON.parse(raw);
    assert.strictEqual(obj.schema_version, '1.0');
    assert.strictEqual(obj.entity_id, 'modbus-meter-1');
    assert.deepStrictEqual(obj.channels, { wasser_temp_c: 42.7 });
    assert.strictEqual(
      vpEntityRead.parse('modbus-meter-1', 'wasser_temp_c', Buffer.from(raw)), 42.7);
  });
});

describe('lib/modbus-conn (per-target serialization + timeouts)', function () {
  it('reads FC3 and FC4 register blocks', async function () {
    const srv = await startModbusServer({ regs: [1234, 0x4366, 0x4000] });
    try {
      const fc3 = await conn.readRegisters({
        host: '127.0.0.1', port: srv.port, unitId: 1, addr: 0, count: 1 });
      assert.deepStrictEqual(fc3, [1234]);
      const fc4 = await conn.readRegisters({
        host: '127.0.0.1', port: srv.port, unitId: 1, fc: codec.FN_READ_INPUT,
        addr: 1, count: 2 });
      assert.strictEqual(codec.decodeValue(fc4, 'float32', 'big'), 230.25);
    } finally {
      await srv.close();
    }
  });

  it('never opens two concurrent connections to one target', async function () {
    const srv = await startModbusServer({ regs: [7], delayMs: 120 });
    try {
      const reads = [];
      for (let i = 0; i < 4; i++) {
        reads.push(conn.readRegisters({
          host: '127.0.0.1', port: srv.port, unitId: 1, addr: 0, count: 1 }));
      }
      const results = await Promise.all(reads);
      assert.strictEqual(results.length, 4);
      results.forEach((r) => assert.deepStrictEqual(r, [7]));
      assert.strictEqual(srv.state.maxPending, 1,
        'the manager must serialize per (host, port) - one in-flight request');
    } finally {
      await srv.close();
    }
  });

  it('a silent device yields a read-timeout error, never a hang', async function () {
    const srv = await startModbusServer({ respond: false });
    try {
      await assert.rejects(
        conn.readRegisters({ host: '127.0.0.1', port: srv.port, unitId: 1,
          addr: 0, count: 1, readTimeoutMs: 150, overallTimeoutMs: 500 }),
        /Timeout/);
      assert.strictEqual(conn.busy('127.0.0.1', srv.port), false,
        'the busy flag must ALWAYS clear');
    } finally {
      await srv.close();
    }
  });

  it('an unreachable device rejects with a connection error', async function () {
    const srv = await startModbusServer({});
    const deadPort = srv.port;
    await srv.close();
    await assert.rejects(
      conn.readRegisters({ host: '127.0.0.1', port: deadPort, unitId: 1,
        addr: 0, count: 1 }),
      /Verbindung/);
  });

  it('a full queue drops the OLDEST request with a visible rejection', async function () {
    const srv = await startModbusServer({ regs: [9], delayMs: 100 });
    try {
      const outcomes = [];
      const reads = [];
      // maxQueue 2: while #1 is in flight, #2/#3 queue and #4 evicts #2.
      for (let i = 0; i < 4; i++) {
        reads.push(conn.readRegisters({
          host: '127.0.0.1', port: srv.port, unitId: 1, addr: 0, count: 1,
          maxQueue: 2 })
          .then(() => outcomes.push('ok'), (e) => outcomes.push(e.message)));
      }
      await Promise.all(reads);
      const dropped = outcomes.filter((o) => /Warteschlange/.test(o));
      assert.strictEqual(dropped.length, 1, 'exactly one drop-oldest rejection: ' + outcomes);
      assert.strictEqual(outcomes.filter((o) => o === 'ok').length, 3);
    } finally {
      await srv.close();
    }
  });
});

describe('vp-modbus-read node', function () {
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

  it('reads on trigger, emits the scaled value and records entity telemetry', function (done) {
    startModbusServer({ regs: { 100: 0x4366, 101: 0x4000 } }).then((srv) => {
      const flow = [
        { id: 'core1', type: 'vp-core', name: 'test-core', host: '127.0.0.1', port: String(busPort) },
        { id: 'mb1', type: 'vp-modbus-read', core: 'core1',
          host: '127.0.0.1', port: srv.port, unit_id: 1, register_kind: 'input',
          address: 100, data_type: 'float32', word_order: 'big', scale: 0.001,
          offset: 0, min_read_interval_s: 1,
          entity: 'modbus-meter-1', channel: 'leistung_kw', wires: [['h1']] },
        { id: 'h1', type: 'helper' },
      ];
      let telemetry = null;
      let emitted = null;
      const maybeDone = () => {
        if (telemetry === null || emitted === null) return;
        srv.close().then(() => {
          try {
            assert.strictEqual(emitted, 0.23025);
            assert.strictEqual(telemetry.entity_id, 'modbus-meter-1');
            assert.deepStrictEqual(telemetry.channels, { leistung_kw: 0.23025 });
            assert.strictEqual(telemetry.schema_version, '1.0');
            done();
          } catch (e) {
            done(e);
          }
        });
      };
      broker.subscribe('edge/entities/modbus-meter-1/telemetry', function (packet, cb) {
        cb();
        telemetry = JSON.parse(packet.payload.toString());
        maybeDone();
      }, function () {});
      helper.load([vpCore, vpModbusRead], flow, function () {
        const h1 = helper.getNode('h1');
        h1.on('input', function (msg) {
          emitted = msg.payload;
          maybeDone();
        });
        setTimeout(function () {
          helper.getNode('mb1').receive({});
        }, 300);
      });
    }).catch(done);
  });

  it('a failed read emits NOTHING and warns (never silent, never a value)', function (done) {
    startModbusServer({}).then(async (srv) => {
      const deadPort = srv.port;
      await srv.close();
      const flow = [
        { id: 'mb1', type: 'vp-modbus-read', core: '',
          host: '127.0.0.1', port: deadPort, address: 0, data_type: 'u16',
          min_read_interval_s: 1, wires: [['h1']] },
        { id: 'h1', type: 'helper' },
      ];
      helper.load([vpModbusRead], flow, function () {
        const mb1 = helper.getNode('mb1');
        const h1 = helper.getNode('h1');
        let sawPayload = false;
        h1.on('input', function () { sawPayload = true; });
        mb1.on('call:warn', function (call) {
          setTimeout(function () {
            try {
              assert.strictEqual(sawPayload, false, 'no emission on failure');
              assert.match(String(call.args[0]), /Modbus-Lesen 127\.0\.0\.1:/);
              done();
            } catch (e) {
              done(e);
            }
          }, 100);
        });
        mb1.receive({});
      });
    }).catch(done);
  });

  it('skips a tick inside min_read_interval_s (one read, not two)', function (done) {
    startModbusServer({ regs: [42] }).then((srv) => {
      const flow = [
        { id: 'mb1', type: 'vp-modbus-read', core: '',
          host: '127.0.0.1', port: srv.port, address: 0, data_type: 'u16',
          min_read_interval_s: 30, wires: [['h1']] },
        { id: 'h1', type: 'helper' },
      ];
      helper.load([vpModbusRead], flow, function () {
        const mb1 = helper.getNode('mb1');
        const h1 = helper.getNode('h1');
        const seen = [];
        h1.on('input', function (msg) { seen.push(msg.payload); });
        mb1.receive({});
        setTimeout(function () { mb1.receive({}); }, 250); // inside the floor
        setTimeout(function () {
          srv.close().then(() => {
            try {
              assert.deepStrictEqual(seen, [42], 'second tick skipped');
              assert.strictEqual(srv.state.reads, 1, 'exactly one wire read');
              done();
            } catch (e) {
              done(e);
            }
          });
        }, 600);
      });
    }).catch(done);
  });
});
