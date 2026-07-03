'use strict';

/**
 * modbus-tcp.e2e.test.js - drives the ACTUAL "Modbus-TCP lesen" + "Modbus-
 * Register -> Messwerte" function-node bodies from flows.json against a real
 * in-process Modbus-TCP server (localhost), so the generic self-wiring read
 * path is proven end to end WITHOUT Docker or hardware. The server serves the
 * compact SunSpec-style block the edge/sim inverter exposes (FC3 0..8).
 *
 * This is the piece the pure-codec unit tests can't cover: the net socket
 * connect/segment-reassemble/read loop the flow runs at runtime.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// A minimal Modbus-TCP server answering fn-0x03 with a fixed register block.
function startModbusServer(regs) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (req) => {
        const txid = req.readUInt16BE(0);
        const addr = req.readUInt16BE(8);
        const count = req.readUInt16BE(10);
        const byteCount = count * 2;
        const resp = Buffer.alloc(9 + byteCount);
        resp.writeUInt16BE(txid, 0);
        resp.writeUInt16BE(0, 2);
        resp.writeUInt16BE(3 + byteCount, 4);
        resp[6] = req[6]; // unit
        resp[7] = 0x03;
        resp[8] = byteCount;
        for (let i = 0; i < count; i++) {
          resp.writeUInt16BE((regs[addr + i] || 0) & 0xffff, 9 + i * 2);
        }
        sock.write(resp);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Run a function-node body with a Node-RED-like context; returns its result
// (awaited if it is a Promise, as the runtime does for async function nodes).
async function runFunctionNode(func, msg) {
  const ctxStore = {};
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get() {}, set() {} },
    global: { get: (k) => (k === 'net' ? net : undefined) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

test('generic Modbus-TCP flow reads + decodes a live server end to end', async () => {
  // grid +2.50 kW, pv 12.00 kW, load 8.00 kW, batt +5.00 kW, soc 55.0 %,
  // wmax 70.00 %, grid-conn 50.00 kW.
  const regs = [250, 1200, 800, 500, 550, 7000, 5000, 0, 0];
  const { server, port } = await startModbusServer(regs);
  try {
    const msg = {
      mb: { conn: { ip: '127.0.0.1', port, unit_id: 1 }, profile: 'sunspec', read: { fc: 3, addr: 0, count: 9 } },
    };
    // 1) the reader fills msg.mb.regs from the socket
    const afterRead = await runFunctionNode(byId['auto-modbus'].func, msg);
    assert.ok(afterRead, 'reader returned a message (no socket error)');
    // spread across the vm realm boundary (Array prototypes differ) before compare
    assert.deepStrictEqual([...afterRead.mb.regs], regs);

    // 2) the decoder turns the block into the canonical telemetry reading
    const out = await runFunctionNode(byId['auto-mb-decode'].func, afterRead);
    const reading = out[0].payload;
    assert.strictEqual(reading.power_kw, 2.5);
    assert.strictEqual(reading.pv_power_kw, 12);
    assert.strictEqual(reading.load_kw, 8);
    assert.strictEqual(reading.soc_pct, 55);
    assert.strictEqual(reading.grid_limit_kw, 35);
    assert.ok(typeof reading.ts === 'string');
    assert.strictEqual(out[1].payload, true); // link lifebeat
  } finally {
    server.close();
  }
});

test('generic Modbus-TCP reader returns null on a connection error (idle-safe)', async () => {
  const msg = {
    mb: { conn: { ip: '127.0.0.1', port: 1, unit_id: 1, timeout_ms: 500 }, profile: 'sunspec', read: { fc: 3, addr: 0, count: 9 } },
  };
  const res = await runFunctionNode(byId['auto-modbus'].func, msg);
  assert.strictEqual(res, null);
});
