'use strict';

/**
 * test-read.flow.test.js - drives the ACTUAL "Verbindung testen (einmal lesen)"
 * function-node body from flows.json against a real in-process Modbus-TCP server
 * (localhost), so the one-shot test-read path is proven end to end WITHOUT
 * Docker or hardware - mirroring modbus-tcp.e2e.test.js and the control-readback
 * e2e. This is the piece the pure-module unit test can't cover: that the flow
 * node's EMBEDDED copy of test-read.js + the decode modules actually runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

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
        resp[6] = req[6];
        resp[7] = 0x03;
        resp[8] = byteCount;
        for (let i = 0; i < count; i++) resp.writeUInt16BE((regs[addr + i] || 0) & 0xffff, 9 + i * 2);
        sock.write(resp);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Run the flow function-node body the way Node-RED runs an async function node.
async function runFlowFunction(func, msg) {
  let sent = null;
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send(m) { sent = m; } },
    context: { get() {}, set() {} },
    flow: { get() {}, set() {} },
    global: { get: (k) => ({ net, http, https }[k]) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  const out = ret && typeof ret.then === 'function' ? await ret : ret;
  return out || sent;
}

test('flow test-read reads a live Modbus server and answers ok with a reading', async () => {
  const regs = [250, 1200, 800, 500, 550, 7000, 5000, 0, 0]; // grid 2.5, pv 12, load 8, soc 55
  const { server, port } = await startModbusServer(regs);
  try {
    const msg = {
      payload: {
        request_id: 'tr-abc',
        role: 'pv-generation',
        brand: 'generic_modbus',
        model: 'sunspec',
        family: 'sunspec',
        communication: 'modbus_tcp',
        connection: { ip: '127.0.0.1', port, unit_id: 1 },
      },
    };
    const out = await runFlowFunction(byId['test-read'].func, msg);
    assert.ok(out && out.payload, 'flow returned a result message');
    assert.strictEqual(out.payload.request_id, 'tr-abc');
    assert.strictEqual(out.payload.ok, true, JSON.stringify(out.payload));
    assert.strictEqual(out.payload.reading.pv_kw, 12);
    assert.strictEqual(out.payload.reading.grid_kw, 2.5);
    assert.strictEqual(out.payload.reading.soc_pct, 55);
  } finally {
    server.close();
  }
});

test('flow test-read classifies a refused connect as unreachable', async () => {
  const msg = {
    payload: {
      request_id: 'tr-x', brand: 'generic_modbus', model: 'sunspec', family: 'sunspec',
      communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port: 1 },
    },
  };
  const out = await runFlowFunction(byId['test-read'].func, msg);
  assert.strictEqual(out.payload.request_id, 'tr-x');
  assert.strictEqual(out.payload.ok, false);
  assert.strictEqual(out.payload.error_code, 'unreachable');
});
