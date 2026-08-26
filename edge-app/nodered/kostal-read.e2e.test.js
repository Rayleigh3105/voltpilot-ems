'use strict';

/**
 * kostal-read.e2e.test.js - drives the ACTUAL "KOSTAL PLENTICORE lesen"
 * (auto-kostal) function-node body from flows.json against a real in-process
 * Modbus-TCP server serving the official PLENTICORE register image. This is the
 * piece the pure decode/reader unit tests can't cover: the flow node's embedded
 * module + the net socket reads running exactly as Node-RED runs them at
 * runtime (the sunspec-live.e2e.test.js pattern). No Docker, no hardware.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const sharedBus = require('./measurements/shared-bus-arbiter');
const fs = require('node:fs');
const path = require('node:path');

const kostal = require('./kostal/kostal-decode');
const routing = require('./inverter-routing');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// Absolute register image of a healthy PLENTICORE BI 10/26 (byte order little =
// factory default; -2000 W = CHARGING 2 kW per the official sign convention).
function kostalImage() {
  const regs = {};
  const putF32 = (addr, value) => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    regs[addr] = buf.readUInt16BE(2); // little/CDAB: LOW word first
    regs[addr + 1] = buf.readUInt16BE(0);
  };
  regs[kostal.REG.BYTE_ORDER] = 0;
  regs[kostal.REG.INVERTER_STATE] = 6;
  regs[kostal.REG.INVERTER_STATE + 1] = 0;
  regs[kostal.REG.BATTERY_SOC_PCT] = 87;
  regs[kostal.REG.INVERTER_MAX_POWER_W] = 10000;
  regs[kostal.REG.BATTERY_POWER_W] = -2000 & 0xffff;
  regs[kostal.REG.BATTERY_TYPE] = 0x0004; // BYD
  regs[kostal.REG.BATTERY_MGMT_MODE] = kostal.MGMT_MODE_EXTERNAL_MODBUS;
  regs[kostal.REG.SENSOR_TYPE] = 0x03; // KSEM
  putF32(kostal.REG.POWERMETER_TOTAL_W, 1500);
  putF32(kostal.REG.BMS_MAX_CHARGE_W, 9000);
  putF32(kostal.REG.BMS_MAX_DISCHARGE_W, 10000);
  putF32(kostal.REG.BATTERY_WORK_CAPACITY_WH, 10240);
  return regs;
}

// A minimal Modbus-TCP server answering fn-0x03 from the absolute image.
function startModbusServer(regs) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 12) {
          const req = acc.slice(0, 12); acc = acc.slice(12);
          const txid = req.readUInt16BE(0);
          const addr = req.readUInt16BE(8);
          const count = req.readUInt16BE(10);
          const bc = count * 2;
          const resp = Buffer.alloc(9 + bc);
          resp.writeUInt16BE(txid, 0);
          resp.writeUInt16BE(3 + bc, 4);
          resp[6] = req[6];
          resp[7] = 0x03;
          resp[8] = bc;
          for (let i = 0; i < count; i++) resp.writeUInt16BE((regs[addr + i] || 0) & 0xffff, 9 + i * 2);
          sock.write(resp);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Run a function-node body with a Node-RED-like context (awaits a Promise result).
async function runFunctionNode(func, msg, flowStore) {
  const ctxStore = {};
  const flowCtx = flowStore || {};
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowCtx[k], set: (k, v) => { flowCtx[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + func + '\n})()', sandbox);
  return await ret;
}

test('the auto-kostal flow node reads a live PLENTICORE image end to end', async () => {
  const { server, port } = await startModbusServer(kostalImage());
  try {
    // Route through the REAL router body first, from the retained selection
    // shape the core publishes - so the whole self-wiring chain is exercised.
    const sel = {
      schema_version: '1.0', brand: 'kostal', label: 'KOSTAL · PLENTICORE BI 10/26',
      family: 'kostal_plenticore', communication: 'kostal_modbus',
      connection: { ip: '127.0.0.1', port, unit_id: 71, byte_order: 'auto' },
    };
    assert.ok(routing.parseConfig(sel), 'the selection must parse');
    const routed = await runFunctionNode(byId['auto-router'].func, {}, { inverter_config: sel });
    const kmsg = routed[4]; // output 5 carries msg.kostal
    assert.ok(kmsg && kmsg.kostal, 'router must emit the kostal plan on output 5');

    const out = await runFunctionNode(byId['auto-kostal'].func, kmsg);
    assert.ok(Array.isArray(out), 'the reader must emit [telemetry, liveness]');
    const reading = out[0].payload;
    // VoltPilot convention: register -2000 (charge) -> battery_power_kw +2.
    assert.strictEqual(reading.battery_power_kw, 2);
    assert.strictEqual(reading.soc_pct, 87);
    assert.strictEqual(reading.power_kw, 1.5);
    assert.strictEqual(reading.pv_power_kw, undefined);
    assert.strictEqual(reading.load_kw, undefined);
    assert.ok(typeof reading.ts === 'string' && reading.ts.length > 0);
    assert.strictEqual(out[1].payload, true); // link liveness
  } finally {
    server.close();
  }
});

test('the auto-kostal flow node stays idle-safe against a dead target', async () => {
  const out = await runFunctionNode(byId['auto-kostal'].func, {
    kostal: { conn: { ip: '127.0.0.1', port: 1, unit_id: 71, byte_order: 'auto' }, reads: [] },
  });
  assert.strictEqual(out, null, 'unreachable must yield null, never a fabricated reading');
});
