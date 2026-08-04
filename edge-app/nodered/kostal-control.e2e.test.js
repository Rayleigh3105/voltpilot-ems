'use strict';

/**
 * kostal-control.e2e.test.js - drives the ACTUAL "KOSTAL schreiben +
 * zuruecklesen" (auto-control-exec-kostal) function-node body from flows.json,
 * fed by the ACTUAL plan node, against a real in-process Modbus-TCP server
 * emulating the PLENTICORE's external battery management. This is the piece the
 * pure plan tests cannot cover: the FC16 float32 frame on the wire, the
 * activation gate, and the readback verdicts as Node-RED runs them. No Docker,
 * no hardware, no allowlist mutation.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

const REG_SETPOINT = 1034;
const REG_MGMT_MODE = 1080;
const REG_BYTE_ORDER = 5;

// A PLENTICORE-shaped Modbus-TCP server: FC3 reads from the register image,
// FC16 writes into it (2 registers). `mgmtMode` is register 1080 (2 = external
// battery management via MODBUS = the activation gate open).
function startPlenticore(opts) {
  opts = opts || {};
  const regs = new Map();
  regs.set(REG_BYTE_ORDER, opts.byteOrder === 'big' ? 1 : 0);
  regs.set(REG_MGMT_MODE, opts.mgmtMode === undefined ? 2 : opts.mgmtMode);
  // setpoint starts at 0 W (little/CDAB words of +0.0)
  regs.set(REG_SETPOINT, 0);
  regs.set(REG_SETPOINT + 1, 0);
  const writes = [];
  const server = net.createServer((sock) => {
    let acc = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 12) {
        const need = 6 + acc.readUInt16BE(4);
        if (acc.length < need) return;
        const req = acc.slice(0, need); acc = acc.slice(need);
        const txid = req.readUInt16BE(0);
        const unit = req[6];
        const fn = req[7];
        const addr = req.readUInt16BE(8);
        if (fn === 0x03) {
          const count = req.readUInt16BE(10);
          const bc = count * 2;
          const resp = Buffer.alloc(9 + bc);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4);
          resp[6] = unit; resp[7] = 0x03; resp[8] = bc;
          for (let i = 0; i < count; i++) resp.writeUInt16BE((regs.get(addr + i) || 0) & 0xffff, 9 + i * 2);
          sock.write(resp);
        } else if (fn === 0x10) {
          const count = req.readUInt16BE(10);
          for (let i = 0; i < count; i++) regs.set(addr + i, req.readUInt16BE(13 + i * 2));
          writes.push({ addr, count, words: [regs.get(addr), regs.get(addr + 1)] });
          const resp = Buffer.alloc(12);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(6, 4);
          resp[6] = unit; resp[7] = 0x10;
          resp.writeUInt16BE(addr, 8); resp.writeUInt16BE(count, 10);
          sock.write(resp);
        } else {
          const ex = Buffer.alloc(9);
          ex.writeUInt16BE(txid, 0); ex.writeUInt16BE(3, 4); ex[6] = unit; ex[7] = fn | 0x80; ex[8] = 0x01;
          sock.write(ex);
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: server.address().port, regs, writes,
      setpointWatts(order) {
        const w0 = regs.get(REG_SETPOINT) & 0xffff;
        const w1 = regs.get(REG_SETPOINT + 1) & 0xffff;
        const hi = order === 'big' ? w0 : w1;
        const lo = order === 'big' ? w1 : w0;
        const b = Buffer.alloc(4);
        b.writeUInt16BE(hi, 0); b.writeUInt16BE(lo, 2);
        return b.readFloatBE(0);
      },
    }));
  });
}

async function runNode(func, msg, extra) {
  extra = extra || {};
  const ctxStore = extra.context || {};
  const flowStore = extra.flow || {};
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: {
      get: (k, store) => (store === 'file' ? (extra.fileStore || {})[k] : flowStore[k]),
      set: (k, v, store) => { if (store === 'file') { (extra.fileStore = extra.fileStore || {})[k] = v; } else { flowStore[k] = v; } },
    },
    global: { get: (k) => (k === 'net' ? net : undefined) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, Set, setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  const ret = vm.runInContext('(function () {\n' + func + '\n})()', sandbox);
  return await ret;
}

const SEL = {
  schema_version: '1.0', brand: 'kostal', family: 'kostal_plenticore',
  communication: 'kostal_modbus', control_tier: 2, rated_kw: 10,
  connection: { ip: '127.0.0.1', unit_id: 71, byte_order: 'auto' },
};

// Plan via the REAL plan node, then execute via the REAL executor node.
async function planAndExec(port, setpoint, opts) {
  opts = opts || {};
  const sel = JSON.parse(JSON.stringify(SEL));
  sel.connection.port = port;
  if (opts.byteOrder) sel.connection.byte_order = opts.byteOrder;
  const ctx = opts.context || {};
  const { msg } = (() => {
    const store = {};
    const flowStore = { inverter_config: sel };
    const sandbox = {
      msg: { setpoint },
      node: { status() {}, error() {}, warn() {}, send() {} },
      context: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
      flow: {
        get: (k, s) => (s === 'file' ? undefined : flowStore[k]),
        set: (k, v, s) => { if (s !== 'file') flowStore[k] = v; },
      },
      global: { get: () => undefined },
      Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, Set, setTimeout, clearTimeout,
    };
    Object.assign(store, ctx);
    vm.createContext(sandbox);
    vm.runInContext('(function () {\n' + byId['auto-control-plan'].func + '\n})()', sandbox);
    Object.assign(ctx, store);
    return { msg: sandbox.msg };
  })();
  const out = await runNode(byId['auto-control-exec-kostal'].func, msg);
  return { plan: msg.control, out };
}

test('a granted KOSTAL setpoint lands as FC16 float32 watts and reads back held', async () => {
  const dev = await startPlenticore({ mgmtMode: 2 });
  try {
    const { plan, out } = await planAndExec(dev.port, {
      battery_setpoint_kw: -3, source: 'schedule', ts: new Date().toISOString(),
      control_enabled: true, device_certified: true,
    });
    assert.strictEqual(plan.adapter, 'kostal_modbus');
    assert.strictEqual(plan.writes.length, 1);
    assert.ok(out, 'the executor must publish a readback');
    // On the wire: exactly ONE write, to 1034, two registers, +3000 W
    // (VoltPilot -3 kW discharge -> Kostal positive = discharge).
    assert.strictEqual(dev.writes.length, 1);
    assert.strictEqual(dev.writes[0].addr, REG_SETPOINT);
    assert.strictEqual(dev.writes[0].count, 2);
    assert.strictEqual(Math.round(dev.setpointWatts('little')), 3000);
    // Readback verdicts: setpoint held, management mode held.
    const p = out.payload;
    assert.strictEqual(p.family, 'kostal_plenticore');
    const setpointRb = p.registers.find((r) => r.role === 'battery_setpoint');
    assert.strictEqual(setpointRb.actual_raw, 3000);
    assert.strictEqual(setpointRb.actual_kw, 3);
    assert.strictEqual(setpointRb.verdict, 'held');
    assert.strictEqual(p.registers.find((r) => r.role === 'mgmt_mode').verdict, 'held');
    assert.ok(!p.blocked);
  } finally {
    dev.server.close();
  }
});

test('a CHARGE setpoint writes a NEGATIVE watt value (the Kostal sign convention)', async () => {
  const dev = await startPlenticore({ mgmtMode: 2 });
  try {
    await planAndExec(dev.port, {
      battery_setpoint_kw: 2.5, source: 'schedule', ts: new Date().toISOString(),
      control_enabled: true, device_certified: true,
    });
    assert.strictEqual(Math.round(dev.setpointWatts('little')), -2500);
  } finally {
    dev.server.close();
  }
});

test('without external battery management NOTHING is written and the lever is named', async () => {
  // Register 1080 = 0: the installer has not enabled "Extern über Modbus (TCP)".
  const dev = await startPlenticore({ mgmtMode: 0 });
  try {
    const { out } = await planAndExec(dev.port, {
      battery_setpoint_kw: -3, source: 'schedule', ts: new Date().toISOString(),
      control_enabled: true, device_certified: true,
    });
    assert.strictEqual(dev.writes.length, 0, 'the gate must stop the write');
    const p = out.payload;
    assert.strictEqual(p.blocked, true);
    assert.match(p.reason, /Servicemenü/);
    assert.strictEqual(p.registers[0].role, 'mgmt_mode');
    assert.strictEqual(p.registers[0].actual_raw, 0);
  } finally {
    dev.server.close();
  }
});

test('an UNCERTIFIED device never writes, even with the kill-switch on', async () => {
  const dev = await startPlenticore({ mgmtMode: 2 });
  try {
    const { plan, out } = await planAndExec(dev.port, {
      battery_setpoint_kw: -3, source: 'schedule', ts: new Date().toISOString(),
      control_enabled: true, // no device_certified grant, family not fleet-certified
    });
    // NOTE the vm-realm rule (AGENTS.md): objects the node body builds carry the
    // vm context's own prototypes, so deepStrictEqual against an outer-realm []
    // fails - compare the length instead.
    assert.strictEqual(plan.writes.length, 0);
    assert.strictEqual(dev.writes.length, 0, 'no bench pass -> not a single frame on the wire');
    // Readbacks still run so the UI shows the inverter's ACTUAL state.
    assert.ok(out.payload.registers.length >= 1);
    assert.strictEqual(out.payload.certified, false);
  } finally {
    dev.server.close();
  }
});

test('the release hands control back with setpoint 0 (the watchdog does the rest)', async () => {
  const dev = await startPlenticore({ mgmtMode: 2 });
  try {
    const ctx = {};
    const fresh = new Date().toISOString();
    await planAndExec(dev.port, {
      battery_setpoint_kw: -3, source: 'schedule', ts: fresh, control_enabled: true, device_certified: true,
    }, { context: ctx });
    assert.strictEqual(Math.round(dev.setpointWatts('little')), 3000);
    // Kill-switch off after controlling -> release plan -> setpoint 0 on the wire.
    const { plan, out } = await planAndExec(dev.port, {
      battery_setpoint_kw: -3, source: 'schedule', ts: fresh, control_enabled: false, device_certified: true,
    }, { context: ctx });
    assert.strictEqual(plan.mode, 'release');
    assert.strictEqual(Math.round(dev.setpointWatts('little')), 0);
    assert.strictEqual(out.payload.mode, 'release');
    assert.strictEqual(out.payload.registers.find((r) => r.role === 'battery_setpoint').verdict, 'held');
  } finally {
    dev.server.close();
  }
});

test('a big-endian device (register 5 = 1) is auto-detected and still lands correctly', async () => {
  const dev = await startPlenticore({ mgmtMode: 2, byteOrder: 'big' });
  try {
    await planAndExec(dev.port, {
      battery_setpoint_kw: -1, source: 'schedule', ts: new Date().toISOString(),
      control_enabled: true, device_certified: true,
    });
    assert.strictEqual(Math.round(dev.setpointWatts('big')), 1000);
  } finally {
    dev.server.close();
  }
});
