'use strict';

/**
 * native-selfregulation.e2e.test.js - drives the ACTUAL "Steuerung / Schreibplan"
 * and "Steuerung schreiben + zuruecklesen" function-node bodies FROM flows.json
 * against a real in-process Modbus-TCP server that carries the SIMULATOR'S
 * self-consumption model (edge/sim/sunspec-sim.js): with the EMS-control flag
 * cleared it follows the house itself, with the flag set it obeys the commanded
 * setpoint.
 *
 * This is the end-to-end proof the pure tests cannot give, and it is the one
 * question the whole feature stands or falls on:
 *
 *   "Decken-Slot -> nativ -> keine Sollwert-Writes -> Ruecknahme"
 *
 * No Docker, no hardware, no allowlist mutation. The only certificate involved
 * is the SIMULATOR-ONLY entry in unplanned-load-native.js, whose (brand, model,
 * firmware) triple can by construction match nothing but this stand-in.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const sharedBus = require('./measurements/shared-bus-arbiter');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

const R = { GRID: 0, PV: 1, LOAD: 2, BATT: 3, SOC: 4, SETPOINT: 40, ENABLE: 41, PVLIMIT: 42,
  CH_LIMIT: 43, DIS_LIMIT: 44 };
const PV_KW = 0.03;
const LOAD_KW = 7.117; // the Pilsting night reading the whole feature was built for
const MAX_KW = 30;
const NO_LIMIT = 0xffff;

// A SunSpec-sim-shaped Modbus-TCP server that carries the sim's own battery
// model: `enabled` (register 41) decides WHO regulates. It records every write
// so the test can assert the cadence, which is the point of the mode.
function startSelfConsumingInverter() {
  const regs = new Map();
  const writes = [];
  let commandedKw = 0;
  let enabled = 1; // the plant arrives under EMS control, like a running site
  let pvKw = PV_KW;
  let loadKw = LOAD_KW;
  const s16 = (v) => (v > 32767 ? v - 65536 : v);
  const u16 = (v) => v & 0xffff;
  regs.set(R.CH_LIMIT, NO_LIMIT);
  regs.set(R.DIS_LIMIT, NO_LIMIT);
  const limitKw = (addr) => (regs.get(addr) === NO_LIMIT ? MAX_KW : regs.get(addr) / 100);

  const recompute = () => {
    // The sim's model (edge/sim/sim-model.js), without its dead times: the EMS
    // while it asserts control, the inverter itself otherwise - and in its own
    // mode inside the K4b window (registers 43/44).
    const wanted = enabled ? commandedKw : pvKw - loadKw;
    const hi = enabled ? MAX_KW : Math.min(MAX_KW, limitKw(R.CH_LIMIT));
    const lo = enabled ? MAX_KW : Math.min(MAX_KW, limitKw(R.DIS_LIMIT));
    const batt = Math.max(-lo, Math.min(hi, wanted));
    regs.set(R.PV, u16(Math.round(pvKw * 100)));
    regs.set(R.LOAD, u16(Math.round(loadKw * 100)));
    regs.set(R.BATT, u16(Math.round(batt * 100)));
    regs.set(R.GRID, u16(Math.round((loadKw + batt - pvKw) * 100)));
    regs.set(R.SOC, u16(770));
    regs.set(R.ENABLE, enabled);
    regs.set(R.SETPOINT, u16(Math.round(commandedKw * 100)));
  };
  recompute();

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
        } else if (fn === 0x06) {
          const value = req.readUInt16BE(10);
          writes.push({ addr, value });
          if (addr === R.ENABLE) enabled = value;
          else if (addr === R.SETPOINT) commandedKw = s16(value) / 100;
          regs.set(addr, value);
          recompute();
          const resp = Buffer.alloc(12);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(6, 4);
          resp[6] = unit; resp[7] = 0x06;
          resp.writeUInt16BE(addr, 8); resp.writeUInt16BE(value, 10);
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
      server, port: server.address().port, writes,
      battKw: () => s16(regs.get(R.BATT)) / 100,
      gridKw: () => s16(regs.get(R.GRID)) / 100,
      isEnabled: () => enabled === 1,
      setpointWrites: () => writes.filter((w) => w.addr === R.SETPOINT),
      reg: (addr) => regs.get(addr),
      setHouse: (pv, load) => { pvKw = pv; loadKw = load; recompute(); },
    }));
  });
}

// ⚠ The SIMULATOR tab's selection is a FIXED LITERAL inside the node body (that
// is the point of that tab - it can never be a customer device), so the rig has
// to redirect its endpoint. It rewrites ONLY the two connection literals and
// ASSERTS that the substitution really happened: if the literal ever changes,
// this test fails loudly instead of silently exercising nothing. Everything the
// test is about - the native branch, the certificate gate, the write-once
// memory, the executor - is verbatim from flows.json.
function bodyPointedAt(id, port) {
  const src = byId[id].func;
  const out = src.replace("ip: 'edge-sim', port: 502", `ip: '127.0.0.1', port: ${port}`);
  assert.notStrictEqual(out, src,
    `the simulator selection literal changed - update this rig (node ${id})`);
  return out;
}

// One shared node context per rig: the plan node's write-once memory and the
// executor's transaction id live there, exactly as in Node-RED.
function makeRig(port) {
  const planCtx = {};
  const execCtx = {};
  const flowStore = {};
  const planBody = bodyPointedAt('sim-control-plan', port);
  const execBody = byId['sim-control-exec'].func;
  const sandboxFor = (msg, ctxStore) => ({
    msg,
    node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: {
      get: (k, store) => (store === 'file' ? undefined : flowStore[k]),
      set: (k, v, store) => { if (store !== 'file') flowStore[k] = v; },
    },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, Set,
    setTimeout, clearTimeout, String, Error,
  });
  return async function tick(setpoint) {
    const planMsg = { setpoint };
    const planBox = sandboxFor(planMsg, planCtx);
    vm.createContext(planBox);
    const planned = vm.runInContext('(function () {\n' + planBody + '\n})()', planBox);
    if (!planned) return { plan: null, out: null };
    const execBox = sandboxFor(planMsg, execCtx);
    vm.createContext(execBox);
    const out = await vm.runInContext('(function () {\n' + execBody + '\n})()', execBox);
    return { plan: planMsg.control, out };
  };
}

// The AUTO tab reads its selection from flow context, so that test supplies one -
// identical in every respect to the simulator's, which is exactly what makes the
// contrast meaningful: the ONLY difference is which catalog the tab passes.
function simSelection(port) {
  return {
    schema_version: '1.0', brand: 'generic_modbus', model: 'sunspec-sim', family: 'sunspec',
    communication: 'modbus_tcp', control_tier: 1,
    connection: { ip: '127.0.0.1', port, unit_id: 1, firmware: 'sim' },
  };
}

// The core's published command. `mode` is the additive battery_mode field.
function setpoint(mode, kw, extra = {}) {
  return {
    battery_setpoint_kw: kw, source: 'schedule', ts: new Date().toISOString(),
    control_enabled: true, device_certified: true,
    grid_charge_allowed: true, // merchant posture; the EEG case is its own test
    battery_mode: mode,
    battery_native_duty: mode === 'native' ? 'cover_load' : undefined,
    ...extra,
  };
}

// K4b: a charge-side intent with its guard-clipped window.
function windowSetpoint(intent, min, max, kw = 0, extra = {}) {
  return setpoint('native_window', kw, {
    battery_native_intent: intent, battery_window_min_kw: min, battery_window_max_kw: max, ...extra,
  });
}

test('a covering slot goes native: ONE write, then only reads, and the inverter covers the house itself', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);

    // 1. The plant arrives on the ordinary setpoint path.
    const first = await tick(setpoint('setpoint', -4.3));
    assert.strictEqual(first.plan.mode, undefined, 'an ordinary tick carries no mode');
    assert.ok(dev.setpointWrites().length >= 1, 'the setpoint path writes the setpoint');
    assert.ok(dev.isEnabled(), 'EMS control is asserted on the setpoint path');

    // 2. The core hands over. The primitive is written exactly ONCE.
    const before = dev.writes.length;
    const nat = await tick(setpoint('native', -7.087));
    assert.strictEqual(nat.plan.mode, 'native');
    // ⚠ vm-realm gotcha (edge-app/AGENTS.md): objects a function-node body builds
    // carry the vm context's own prototypes, so deepStrictEqual against outer-realm
    // values fails on identical-looking data - normalize via a JSON round trip.
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(nat.plan.writes.map((w) => ({ addr: w.addr, value: w.value })))),
      // The documented sequence: clear the control flag, zero the setpoint - plus
      // the slot's PV cap, which is NOT part of the hand-over (the mode concerns
      // the battery; freezing curtailment would let it outlive its slot).
      [{ addr: R.CH_LIMIT, value: NO_LIMIT }, { addr: R.DIS_LIMIT, value: NO_LIMIT },
        { addr: R.ENABLE, value: 0 }, { addr: R.SETPOINT, value: 0 }, { addr: R.PVLIMIT, value: 0xffff }],
      'K4b: both window limits CLEARED first (an earlier charge-side slot may have left one), '
      + 'then the documented native sequence + the untouched curtailment command');
    assert.strictEqual(nat.out.payload.mode, 'native', 'the readback is the EVIDENCE');
    assert.strictEqual(nat.out.payload.native.intent, 'cover_load', 'and it names the intent it realises');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nat.out.payload.native_capabilities)),
      { intents: ['cover_load', 'surplus_charge', 'self_consumption'], window: true, persistent: false },
      'the lever report rides on every generic cycle');
    assert.ok(nat.out.payload.registers.every((r) => r.match), 'the device confirms its own state');
    assert.strictEqual(dev.writes.length - before, 5, 'exactly the two limits, the native pair and the PV cap');
    assert.ok(!dev.isEnabled(), 'the inverter now regulates itself');

    // The device really covers the house on its own - grid ~ 0 with NO setpoint
    // from us. That is the whole claim of the mode.
    assert.ok(Math.abs(dev.gridKw()) < 0.05, 'grid is ~0: the house is covered from the battery');
    assert.ok(Math.abs(dev.battKw() - (PV_KW - LOAD_KW)) < 0.05, 'the battery follows the house');

    // 3. Further native ticks write NOTHING - they only read the state back.
    const after = dev.writes.length;
    const sp2 = dev.setpointWrites().length;
    for (let i = 0; i < 3; i++) {
      const t = await tick(setpoint('native', -7.05));
      assert.strictEqual(t.plan.writes.length, 0, 'write once, then only read');
      assert.strictEqual(t.out.payload.mode, 'native');
    }
    assert.strictEqual(dev.writes.length, after, 'not one further register write');
    assert.strictEqual(dev.setpointWrites().length, sp2, 'and above all: NO setpoint writes');
  } finally {
    dev.server.close();
  }
});

test('the take-back resumes the setpoint path on the very next tick', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);
    await tick(setpoint('native', -7.087));
    assert.ok(!dev.isEnabled(), 'setup: handed over');

    // The core's supervision withdrew (SoC floor, threatened peak, lost
    // measurement, ...) - it simply stops asking for the native mode.
    const back = await tick(setpoint('setpoint', -7.087));
    assert.notStrictEqual(back.plan.mode, 'native');
    assert.ok(dev.isEnabled(), 'EMS control is asserted again');
    assert.ok(Math.abs(dev.battKw() - -7.087) < 0.02, 'the commanded value is executed again');
    assert.strictEqual(back.out.payload.mode, 'normal', 'and the readback says so');

    // And handing over AGAIN writes the sequence again (the write-once memory is
    // per native episode, not per process).
    const before = dev.writes.length;
    await tick(setpoint('native', -7.087));
    assert.strictEqual(dev.writes.length - before, 5, 'the two cleared limits, the native pair and the PV cap');
    assert.ok(!dev.isEnabled());
  } finally {
    dev.server.close();
  }
});

test('without a certificate the slot stays on the follower and the executor keeps writing the setpoint', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    // The AUTO tab carries the PRODUCTION catalog, which is empty - this is
    // every plant shipped today.
    const planCtx = {};
    const execCtx = {};
    const warns = [];
    const sel = simSelection(dev.port);
    const flowStore = { inverter_config: sel };
    const box = (msg, store) => ({
      msg,
      node: { status() {}, error() {}, warn(m) { warns.push(String(m)); }, log() {}, send() {} },
      context: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
      flow: {
        get: (k, s) => (s === 'file' ? undefined : flowStore[k]),
        set: (k, v, s) => { if (s !== 'file') flowStore[k] = v; },
      },
      global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
      Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, Set,
      setTimeout, clearTimeout, String, Error,
    });
    const msg = { setpoint: setpoint('native', -7.087) };
    const pb = box(msg, planCtx);
    vm.createContext(pb);
    vm.runInContext('(function () {\n' + byId['auto-control-plan'].func + '\n})()', pb);

    assert.notStrictEqual(msg.control.mode, 'native',
      'an uncertified model must fall back to the proven follower');
    assert.ok(msg.control.writes.some((w) => w.addr === R.SETPOINT),
      'the follower keeps writing the setpoint');
    // A refusal nobody names reads as a defect - the node SAYS why it did not
    // hand over, and that it is staying on the follower.
    assert.ok(warns.some((w) => /Wechselrichter-Automatik nicht moeglich/.test(w) &&
      /Pruefstand/.test(w) && /10-Sekunden-Nachf/.test(w)),
      `the refusal must name its cause and the path it stays on: ${JSON.stringify(warns)}`);

    const eb = box(msg, execCtx);
    vm.createContext(eb);
    const out = await vm.runInContext('(function () {\n' + byId['auto-control-exec'].func + '\n})()', eb);
    assert.strictEqual(out.payload.mode, 'normal',
      'and the readback NEVER claims a mode the device is not in');
    assert.ok(dev.isEnabled(), 'the inverter stays under EMS control');
  } finally {
    dev.server.close();
  }
});

test('an EEG plant is refused: this profile cannot prove it will not grid-charge', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);
    const sp = setpoint('native', -7.087);
    sp.grid_charge_allowed = false; // the EEG posture the plan carries
    const t = await tick(sp);
    assert.notStrictEqual(t.plan.mode, 'native');
    assert.ok(dev.isEnabled(), 'nothing was handed over');
    assert.ok(dev.setpointWrites().length >= 1, 'the follower carries the slot');
  } finally {
    dev.server.close();
  }
});

test('a SILENT core runs the ONE controller-owned hand-back, not a second way of letting go', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);
    await tick(setpoint('native', -7.087));
    assert.ok(!dev.isEnabled(), 'setup: handed over');

    // The retained setpoint still SAYS native - but its timestamp is 25 min old,
    // i.e. the core went silent. Without the ordering rule the native branch
    // would keep this alive forever and the release would never fire.
    const stale = setpoint('native', -7.087);
    stale.ts = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const out = await tick(stale);
    assert.notStrictEqual(out.plan && out.plan.mode, 'native',
      'a silent core must not keep the native branch alive');

    // A kill-off is the same rule.
    const off = setpoint('native', -7.087);
    off.control_enabled = false;
    const out2 = await tick(off);
    assert.notStrictEqual(out2.plan && out2.plan.mode, 'native');
  } finally {
    dev.server.close();
  }
});

// --- K4b: Absicht + Fenster, the charge-side intents on the simulator ------------
//
// "native_window" carries surplus_charge (E-up) or self_consumption (E / E~) plus
// the guard-clipped window. The same write-once discipline: ENTRY writes the window
// FIRST and then hands over; a CHANGED window re-writes; the same window in the next
// quarter hour costs nothing; EXIT is the ordinary setpoint plan.

test('K4b E-up: entry writes the window first, the device charges ONLY the surplus and never discharges', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);
    dev.setHouse(12, 5); // 7 kW surplus
    await tick(setpoint('setpoint', 3));
    const before = dev.writes.length;
    const up = await tick(windowSetpoint('surplus_charge', 0, 30, 3));
    assert.strictEqual(up.plan.mode, 'native');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(up.plan.writes.map((w) => [w.addr, w.value]))),
      [[R.CH_LIMIT, 3000], [R.DIS_LIMIT, 0], [R.ENABLE, 0], [R.SETPOINT, 0], [R.PVLIMIT, 0xffff]]);
    assert.strictEqual(dev.writes.length - before, 5);
    assert.strictEqual(up.out.payload.mode, 'native');
    assert.strictEqual(up.out.payload.native.intent, 'surplus_charge', 'the readback names the intent');
    assert.ok(up.out.payload.registers.every((r) => r.match), 'window + hand-over read back');
    assert.ok(Math.abs(dev.battKw() - 7) < 0.02, 'charges exactly the surplus');
    assert.ok(Math.abs(dev.gridKw()) < 0.02, 'grid ~ 0');

    // Wolkenkante: the house now has a DEFICIT. E-up must not discharge.
    dev.setHouse(1, 5);
    assert.ok(Math.abs(dev.battKw()) < 0.02, 'no discharge in E-up (discharge limit 0)');
    assert.ok(Math.abs(dev.gridKw() - 4) < 0.02, 'the deficit is imported, not taken from the battery');
  } finally {
    dev.server.close();
  }
});

test('K4b window change re-writes, the same window in the next slot costs nothing, exit is the setpoint plan', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);
    dev.setHouse(20, 5); // 15 kW surplus
    await tick(windowSetpoint('self_consumption', -30, 30, 0, { slot_start: '2026-09-24T12:00:00Z' }));
    assert.ok(Math.abs(dev.battKw() - 15) < 0.02, 'E: the whole surplus is stored');

    // Next quarter hour, SAME intent and window: not one register write.
    const w1 = dev.writes.length;
    const same = await tick(windowSetpoint('self_consumption', -30, 30, 0, { slot_start: '2026-09-24T12:15:00Z' }));
    assert.strictEqual(same.plan.writes.length, 0, 'slot_start is not part of the write-once signature');
    assert.strictEqual(dev.writes.length, w1);
    assert.strictEqual(same.out.payload.native.intent, 'self_consumption', 'still proven by the readback');

    // E~: the cloud throttles the charge to 4.2 kW -> ONE re-write, the rest is exported.
    const thr = await tick(windowSetpoint('self_consumption', -30, 4.2, 0));
    assert.ok(thr.plan.writes.length > 0, 'a changed window is re-written');
    assert.strictEqual(dev.reg(R.CH_LIMIT), 420);
    assert.ok(Math.abs(dev.battKw() - 4.2) < 0.02, 'E~ holds its charge cap');
    assert.ok(Math.abs(dev.gridKw() + 10.8) < 0.02, 'the rest is exported');

    // Deficit in E~: the discharge side is open.
    dev.setHouse(0, 6);
    assert.ok(Math.abs(dev.battKw() + 6) < 0.02, 'E~ still covers the house');

    // Exit: the core withdraws -> the ordinary setpoint plan asserts EMS control.
    const back = await tick(setpoint('setpoint', -2));
    assert.notStrictEqual(back.plan.mode, 'native');
    assert.ok(dev.isEnabled(), 'EMS control again');
    assert.ok(Math.abs(dev.battKw() + 2) < 0.02, 'the window registers do not bind a commanded value');
    assert.strictEqual(back.out.payload.native, undefined, 'no intent is claimed on a setpoint cycle');
  } finally {
    dev.server.close();
  }
});

test('K4b E-up -> E-down: the covering slot CLEARS the charge-side window', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    const tick = makeRig(dev.port);
    await tick(windowSetpoint('surplus_charge', 0, 30));
    assert.strictEqual(dev.reg(R.DIS_LIMIT), 0, 'setup: E-up blocks discharge');
    dev.setHouse(0, 7);
    const down = await tick(setpoint('native', -7));
    assert.strictEqual(down.out.payload.native.intent, 'cover_load');
    assert.strictEqual(dev.reg(R.DIS_LIMIT), NO_LIMIT, 'the E-up limit does not survive into E-down');
    assert.ok(Math.abs(dev.battKw() + 7) < 0.02, 'the house is covered');
  } finally {
    dev.server.close();
  }
});

test('K4b without a charge-side certificate: the follower keeps writing and nothing is confirmed', async () => {
  const dev = await startSelfConsumingInverter();
  try {
    // The AUTO tab carries the PRODUCTION catalog: no charge-side lever anywhere.
    const src = byId['auto-control-plan'].func;
    const planCtx = {};
    const execCtx = {};
    const run = async (sp) => {
      const msg = { setpoint: sp };
      const sandbox = (store) => ({
        msg, node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
        context: { get: (k) => store[k], set: (k, v) => { store[k] = v; } },
        flow: { get: (k, st) => (st === 'file' ? undefined : (k === 'inverter_config' ? simSelection(dev.port) : undefined)), set() {} },
        global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
        Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, Set,
        setTimeout, clearTimeout, String, Error,
      });
      const pb = sandbox(planCtx); vm.createContext(pb);
      const planned = vm.runInContext('(function () {\n' + src + '\n})()', pb);
      if (!planned) return { plan: null, out: null };
      const eb = sandbox(execCtx); vm.createContext(eb);
      const out = await vm.runInContext('(function () {\n' + byId['auto-control-exec'].func + '\n})()', eb);
      return { plan: msg.control, out, msg };
    };
    dev.setHouse(12, 5);
    const r = await run(windowSetpoint('surplus_charge', 0, 30, 6.5));
    assert.notStrictEqual(r.plan.mode, 'native', 'no certificate -> no hand-over');
    assert.ok(dev.isEnabled(), 'EMS control stays asserted');
    assert.ok(Math.abs(dev.battKw() - 6.5) < 0.02, 'the (damped) reference setpoint is executed');
    assert.strictEqual(r.out.payload.mode, 'normal');
    assert.strictEqual(r.out.payload.native, undefined, 'nothing to confirm');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.out.payload.native_capabilities)),
      { intents: [], window: false, persistent: false }, 'and the report SAYS there is no lever');
  } finally {
    dev.server.close();
  }
});

test('K4b a Layer 1 that predates native_window runs the ordinary plan (never confirms)', async () => {
  // The pre-K4b plan node compared battery_mode against 'native' ONLY. Simulate it
  // by feeding the new word to a body where that comparison is the old one.
  const dev = await startSelfConsumingInverter();
  try {
    const old = bodyPointedAt('sim-control-plan', dev.port)
      .replace("var nativeWanted = sp.battery_mode === 'native' || sp.battery_mode === 'native_window';",
        "var nativeWanted = sp.battery_mode === 'native';");
    assert.ok(old.includes("var nativeWanted = sp.battery_mode === 'native';"), 'rig: the dispatch line changed');
    const msg = { setpoint: windowSetpoint('surplus_charge', 0, 30, 2.5) };
    const box = {
      msg, node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
      context: { get: () => undefined, set() {} },
      flow: { get: () => undefined, set() {} },
      global: { get: () => undefined },
      Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, Set, String, Error,
    };
    vm.createContext(box);
    vm.runInContext('(function () {\n' + old + '\n})()', box);
    assert.notStrictEqual(msg.control.mode, 'native', 'the unknown word falls through to the setpoint plan');
    assert.ok(msg.control.writes.some((w) => w.addr === R.SETPOINT && w.value === 250), 'writes the reference 2.5 kW');
  } finally {
    dev.server.close();
  }
});
