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
const sharedBus = require('./measurements/shared-bus-arbiter');
const fs = require('node:fs');
const path = require('node:path');

const controlRouting = require('./inverter-control-routing');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// A Modbus-TCP server that also honours fn-0x06 writes into a register store,
// so a written register reads back exactly (the readback loop's proof target -
// mirrors edge/sim, which stores reg 40/41/42 and serves them via FC3).
function startReadWriteServer(initial) {
  const store = Object.assign({}, initial);
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (req) => {
        const txid = req.readUInt16BE(0);
        const fn = req[7];
        if (fn === 0x06) {
          const addr = req.readUInt16BE(8);
          const value = req.readUInt16BE(10);
          store[addr] = value & 0xffff;
          sock.write(req); // echo
          return;
        }
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
        for (let i = 0; i < count; i++) resp.writeUInt16BE((store[addr + i] || 0) & 0xffff, 9 + i * 2);
        sock.write(resp);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, store }));
  });
}

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
// Pass a shared `ctxStore` + `flowStore` to persist node/flow context across ticks
// (the plan node's was_controlling failsafe state lives in node context).
async function runFunctionNode(func, msg, ctxStore = {}, flowStore = {}) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
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

test('control exec writes reg 40/41/42 then reads them back and confirms a match', async () => {
  const { server, port, store } = await startReadWriteServer({ 40: 0, 41: 0, 42: 0xffff });
  try {
    const sel = {
      schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
      communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port, unit_id: 1 },
    };
    const setpoint = { battery_setpoint_kw: -25, pv_limit_kw: 3, source: 'schedule', slot_start: '2026-07-08T12:00:00Z', control_enabled: true };
    const msg = { control: controlRouting.controlRoute(sel, setpoint, {}), setpoint };
    const out = await runFunctionNode(byId['auto-control-exec'].func, msg);
    assert.ok(out, 'exec published a readback (no socket error)');
    const rb = out.payload;
    assert.strictEqual(rb.family, 'sunspec');
    assert.strictEqual(rb.source, 'schedule');
    assert.strictEqual(rb.control_enabled, true);
    assert.strictEqual(rb.certified, true);
    // the store now holds the written values (write actually happened)
    assert.strictEqual(store[40], (-2500) & 0xffff, 'battery setpoint written to reg 40');
    assert.strictEqual(store[41], 1, 'control-enable written to reg 41');
    assert.strictEqual(store[42], 300, 'pv-limit written to reg 42');
    // every register reads back its commanded value -> all match
    const byRole = Object.fromEntries(rb.registers.map((r) => [r.role, r]));
    assert.strictEqual(byRole.battery_power.actual_raw, (-2500) & 0xffff);
    assert.strictEqual(byRole.battery_power.actual_kw, -25);
    assert.strictEqual(byRole.battery_power.match, true);
    assert.strictEqual(byRole.pv_limit.actual_kw, 3);
    assert.ok(rb.registers.every((r) => r.match), 'all registers confirmed');
  } finally {
    server.close();
  }
});

test('control exec flags a mismatch when the inverter ignores the write', async () => {
  // A server that echoes the write ack but does NOT store it (reg 40 stays 0) -
  // the readback then differs from the command: the exact case the captain wants
  // to catch ("der Wechselrichter hat den Sollwert nicht uebernommen").
  const server = net.createServer((sock) => {
    sock.on('data', (req) => {
      const txid = req.readUInt16BE(0);
      const fn = req[7];
      if (fn === 0x06) { sock.write(req); return; } // ack but drop the value
      const count = req.readUInt16BE(10);
      const resp = Buffer.alloc(9 + count * 2);
      resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + count * 2, 4); resp[6] = req[6]; resp[7] = 0x03; resp[8] = count * 2;
      sock.write(resp); // all registers read back 0
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const sel = { schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec', communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port, unit_id: 1 } };
    const setpoint = { battery_setpoint_kw: -25, source: 'schedule', control_enabled: true };
    const msg = { control: controlRouting.controlRoute(sel, setpoint, {}), setpoint };
    const out = await runFunctionNode(byId['auto-control-exec'].func, msg);
    const byRole = Object.fromEntries(out.payload.registers.map((r) => [r.role, r]));
    assert.strictEqual(byRole.battery_power.match, false, 'reg 40 not adopted -> mismatch');
    assert.strictEqual(byRole.battery_power.actual_raw, 0);
  } finally {
    server.close();
  }
});

test('CONTROLLER-OWNED FAILSAFE: after a control write, a kill-off writes the release (hand back) end to end', async () => {
  // Prove the whole §7.5 chain against the real read/write server: a normal setpoint
  // WRITES control (reg 41=1), then a kill-off (control_enabled=false) makes the plan
  // node emit the RELEASE plan (was_controlling primed), and the executor writes it -
  // control_enable back to 0, setpoint 0, cap cleared - and confirms the readback.
  const { server, port, store } = await startReadWriteServer({ 40: 0, 41: 0, 42: 0xffff });
  try {
    const sel = { schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
      communication: 'modbus_tcp', control_tier: 1, connection: { ip: '127.0.0.1', port, unit_id: 1 } };
    const ctx = {}; const flow = { inverter_config: sel };
    const plan = byId['auto-control-plan'].func;
    const exec = byId['auto-control-exec'].func;

    // 1) normal control tick: control_enabled=true -> writes 40/41/42, primes was_controlling.
    const fresh = new Date().toISOString();
    const m1 = await runFunctionNode(plan, { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: fresh, control_enabled: true } }, ctx, flow);
    assert.strictEqual(m1.control.mode, undefined, 'normal plan, not a release');
    await runFunctionNode(exec, m1, {}, flow);
    assert.strictEqual(store[41], 1, 'control enabled (reg 41=1) after the normal write');
    assert.strictEqual(store[40], (-1000) & 0xffff, 'setpoint written');
    assert.strictEqual(ctx.was_controlling, true, 'plan node remembers it held control');

    // 2) kill-off: control_enabled=false -> the plan node emits the RELEASE plan.
    const m2 = await runFunctionNode(plan, { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: new Date().toISOString(), control_enabled: false } }, ctx, flow);
    assert.strictEqual(m2.control.mode, 'release', 'kill-off after controlling -> release plan');
    assert.strictEqual(m2.control.writes.length, 3, 'release writes control_enable/setpoint/cap');
    assert.strictEqual(ctx.was_controlling, false, 'control handed back');

    // 3) the executor writes the release; the inverter reads back as self-consuming.
    const out = await runFunctionNode(exec, m2, {}, flow);
    assert.ok(out, 'release readback published');
    assert.strictEqual(store[41], 0, 'control DISABLED (reg 41=0) - handed back to self-consumption');
    assert.strictEqual(store[40], 0, 'setpoint cleared');
    assert.strictEqual(store[42], 0xffff, 'feed-in cap cleared');
    assert.ok(out.payload.registers.every((r) => r.match), 'release confirmed by readback');
  } finally {
    server.close();
  }
});

test('FAILSAFE stays dormant when control was never on (control-off-from-boot writes NOTHING)', async () => {
  // The discipline "control off -> write NOTHING (readback only)": with was_controlling
  // never primed, a control_enabled=false tick must NOT write a release - the plan node
  // yields the normal (empty-writes) plan, and the executor only reads back.
  const { server, port, store } = await startReadWriteServer({ 40: 7, 41: 1, 42: 0xffff });
  try {
    const sel = { schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec',
      communication: 'modbus_tcp', control_tier: 1, connection: { ip: '127.0.0.1', port, unit_id: 1 } };
    const ctx = {}; const flow = { inverter_config: sel };
    const m = await runFunctionNode(byId['auto-control-plan'].func,
      { setpoint: { battery_setpoint_kw: -10, source: 'schedule', ts: new Date().toISOString(), control_enabled: false } }, ctx, flow);
    assert.notStrictEqual(m.control.mode, 'release', 'no release without having held control');
    assert.strictEqual(m.control.writes.length, 0, 'kill-switch off + never controlled -> no writes');
    await runFunctionNode(byId['auto-control-exec'].func, m, {}, flow);
    assert.strictEqual(store[41], 1, 'reg 41 UNTOUCHED - nothing was written');
    assert.strictEqual(store[40], 7, 'reg 40 UNTOUCHED');
  } finally {
    server.close();
  }
});

test('control exec no-ops for an uncertified Deye plan (read-only, no publish)', async () => {
  const sel = { schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', communication: 'solarman_v5', connection: { ip: '127.0.0.1', port: 8899, serial: '1', mb_slave_id: 1 } };
  const setpoint = { battery_setpoint_kw: -5, source: 'schedule', control_enabled: true };
  const msg = { control: controlRouting.controlRoute(sel, setpoint, {}), setpoint };
  const out = await runFunctionNode(byId['auto-control-exec'].func, msg);
  assert.strictEqual(out, null, 'no readback published for a read-only adapter');
});

test('generic Modbus-TCP reader returns null on a connection error (idle-safe)', async () => {
  const msg = {
    mb: { conn: { ip: '127.0.0.1', port: 1, unit_id: 1, timeout_ms: 500 }, profile: 'sunspec', read: { fc: 3, addr: 0, count: 9 } },
  };
  const res = await runFunctionNode(byId['auto-modbus'].func, msg);
  assert.strictEqual(res, null);
});
