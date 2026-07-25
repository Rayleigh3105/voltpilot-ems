'use strict';

/**
 * deye-control.e2e.test.js - drives the ACTUAL Deye Solarman-V5 control executor
 * ("Deye Solarman-V5 schreiben + zuruecklesen", auto-control-exec-deye) from
 * flows.json against a real in-process SOLARMAN-V5 server, so the Tier-3 Deye
 * write->readback->match loop is proven end to end WITHOUT hardware (report
 * §4.4b/§5/§10 - the buildable-offline slice). It mirrors modbus-tcp.e2e.test.js
 * but wraps every Modbus frame in the Solarman-V5 logger protocol (TCP 8899).
 *
 * SAFETY: Deye is NOT in CERTIFIED_CONTROL_FAMILIES, so controlRoute never emits
 * executable Deye writes in production. To exercise the executor we TEMPORARILY
 * certify 'hybrid_3p' inside a test (restored in finally) - this ALSO proves the
 * un-gating: certifying the family is the ONLY thing that turns writes on, with no
 * code change. The production default stays proven read-only by
 * inverter-control-routing.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const controlRouting = require('./inverter-control-routing');
const SV5 = require('./deye/solarman-v5');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));
const DEYE_EXEC = byId['auto-control-exec-deye'].func;
// The Deye READ POLL body (auto-solarman) - driven concurrently with the write
// executor below to prove the bidirectional one-socket coordination (report §5.6).
const READ_POLL = byId['auto-solarman'].func;

const DEYE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', control_tier: 3,
  communication: 'solarman_v5', connection: { ip: '127.0.0.1', serial: '2985159064', mb_slave_id: 1 },
};

// --- a real in-process Solarman-V5 logger that honours FC6 writes + FC3 reads ---
// It parses the V5 request wrapper, applies the embedded Modbus-RTU frame to a
// register store, and answers with a V5-wrapped Modbus response - exactly what a
// real LSW3 stick does, so the executor's whole wire path (framing, checksum, CRC,
// sequence) is exercised.
const V5_RESP_PREAMBLE = 14; // frametype(1)+status(1)+3x u32 -> modbus at offset 25

function buildV5Response(serial, sequence, modbusFrame) {
  const length = V5_RESP_PREAMBLE + modbusFrame.length;
  const header = Buffer.alloc(11);
  header[0] = 0xa5;
  header.writeUInt16LE(length, 1);
  header.writeUInt16LE(0x1510, 3); // V5 response control code
  header.writeUInt16LE(sequence & 0xffff, 5);
  header.writeUInt32LE(SV5.normLoggerSerial(serial), 7);
  const preamble = Buffer.alloc(V5_RESP_PREAMBLE);
  preamble[0] = 0x02; // frametype
  preamble[1] = 0x01; // status ok
  const frame = Buffer.concat([header, preamble, modbusFrame, Buffer.from([0x00, 0x15])]);
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum = (sum + frame[i]) & 0xff;
  frame[frame.length - 2] = sum & 0xff;
  return frame;
}

// The embedded Modbus frame in a V5 REQUEST starts after the 11-byte header + the
// 15-byte request preamble.
const V5_REQ_MODBUS_OFFSET = 26;

function startSolarmanServer(initial, opts = {}) {
  const store = Object.assign({}, initial);
  const writes = []; // audit: every register the logger accepted
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        let need;
        try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        while (need !== null && acc.length >= need) {
          const frame = acc.slice(0, need);
          acc = acc.slice(need);
          const seq = frame.readUInt16LE(5);
          const serial = frame.readUInt32LE(7);
          const mb = frame.slice(V5_REQ_MODBUS_OFFSET, frame.length - 2);
          const slave = mb[0];
          const fn = mb[1];
          let respMb;
          if (fn === 0x06) {
            const reg = mb.readUInt16BE(2);
            const value = mb.readUInt16BE(4) & 0xffff;
            if (!opts.dropWrites) { store[reg] = value; writes.push({ reg, value }); }
            // writeReply models a logger that ACCEPTS the write frame (it arrives)
            // but returns a V5 response whose Modbus payload is too short to be a
            // valid RTU reply - the live-Pilsting shape: 'empty' = no Modbus bytes
            // (the inverter did not answer), 'stub' = a 1-byte fragment.
            if (opts.writeReply === 'empty') respMb = Buffer.alloc(0);
            else if (opts.writeReply === 'stub') respMb = Buffer.from([0x0b]);
            else respMb = SV5.writeSingleRegisterRequest(slave, reg, opts.dropWrites ? (store[reg] || 0) : value); // FC6 echo
          } else if (fn === 0x03) {
            const addr = mb.readUInt16BE(2);
            const count = mb.readUInt16BE(4);
            const body = Buffer.alloc(3 + count * 2);
            body[0] = slave; body[1] = 0x03; body[2] = count * 2;
            for (let i = 0; i < count; i++) body.writeUInt16BE((store[addr + i] || 0) & 0xffff, 3 + i * 2);
            const crc = SV5.modbusCrc16(body);
            respMb = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
          } else { sock.destroy(); return; }
          sock.write(buildV5Response(serial, seq, respMb));
          try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, store, writes }));
  });
}

async function runExec(func, msg, ctxStore = {}, flowStore = {}, warns = null) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn(l) { if (warns) warns.push(String(l)); }, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : undefined) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

// runExecWarns - runExec but returns { out, warns } so a test can assert what the
// node.warn'ed (the raw-frame diagnostic + the "Logger belegt" defer are audible).
async function runExecWarns(func, msg, ctxStore = {}, flowStore = {}) {
  const warns = [];
  const out = await runExec(func, msg, ctxStore, flowStore, warns);
  return { out, warns };
}

// waitFor - await a predicate (bounded). Used between coordination ticks so the
// single-client server has RELEASED the previous connection (state.live -> 0)
// before the next tick connects. In production the read poll (5 s) and the write
// republish (10 s) are seconds apart, so the logger socket is long closed; two
// back-to-back microtask ticks in a test are not, and the server's async 'close'
// (which decrements state.live) would otherwise race the next connect and be
// wrongly flagged concurrent. This removes that HARNESS race, not any product
// behaviour (the sv5_busy/sv5_write_want lock is unchanged).
async function waitFor(pred, timeoutMs = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Build the executable Deye control plan the way controlRoute WOULD once the family
// is bench-certified (the un-gate). Restores the allowlist in the finally.
function certifiedDeyePlan(setpoint, fn) {
  controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
  try {
    const plan = controlRouting.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1' } }, setpoint, { ratedKw: 30 });
    return fn(plan);
  } finally {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
  }
}

test('Deye Solarman-V5 executor writes the ToU plan then reads every register back and confirms a match', async () => {
  const { server, port, store, writes } = await startSolarmanServer({});
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', slot_start: '2026-07-08T12:00:00Z', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        assert.strictEqual(plan.adapter, 'solarman_v5');
        assert.strictEqual(plan.certified, true, 'temporarily certified -> executable');
        assert.ok(plan.writes.length >= 5, 'work_mode/tou/power/soc/charge write ops present');
        plan.connection.port = port;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } });
        assert.ok(out, 'the Deye executor published a readback (no socket error)');
        // the logger accepted the ToU writes over the Solarman-V5 wire
        const byReg = Object.fromEntries(writes.map((w) => [w.reg, w.value]));
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        assert.strictEqual(byReg[reg.workMode], controlRouting.DEYE_WORK_MODE.EXPORT_FIRST, 'work mode written');
        assert.strictEqual(byReg[reg.touEnable], controlRouting.DEYE_TOU_ENABLED_ALL_WEEK, 'ToU enabled written');
        assert.strictEqual(byReg[reg.progPowerBase], 20000, 'discharge 20 kW -> 20000 W (power_scale 1) written');
        assert.strictEqual(byReg[reg.progSocBase], 10, 'discharge -> target SoC = floor');
        // every register reads back its commanded value -> all match
        const rb = out.payload;
        assert.strictEqual(rb.family, 'hybrid_3p');
        assert.strictEqual(rb.wrote, true);
        assert.ok(rb.registers.every((r) => r.match), 'all registers confirmed by FC3 readback');
        assert.strictEqual(store[reg.progPowerBase], 20000);
      },
    );
  } finally {
    server.close();
  }
});

test('Deye executor flags a mismatch when the logger ignores the write (silent no-op caught)', async () => {
  // A logger that acks the write but does NOT store it: the readback then differs
  // from the command (the "der Wechselrichter hat den Sollwert nicht uebernommen"
  // case). readbacks always run, so this is surfaced, never silently believed.
  const { server, port } = await startSolarmanServer({}, { dropWrites: true });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} });
        const power = out.payload.registers.find((r) => r.role === 'battery_power');
        assert.strictEqual(power.match, false, 'power register not adopted -> mismatch');
        assert.strictEqual(power.actual_raw, 0);
      },
    );
  } finally {
    server.close();
  }
});

test('EEPROM write-on-change: the ~10s republish drives READBACK ONLY, never a rewrite', async () => {
  // dwell_s >= 900 on every Deye WriteOp: a second identical tick within the dwell
  // window writes NOTHING (readback still runs) - the flash-endurance discipline
  // (report §5.3). Shared node context carries the last-written state across ticks.
  const { server, port, writes } = await startSolarmanServer({});
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        const ctx = {}; const flow = {};
        // tick 1: writes the full plan
        const out1 = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flow);
        assert.strictEqual(out1.payload.wrote, true);
        const afterFirst = writes.length;
        assert.ok(afterFirst >= 5, 'first tick wrote the plan');
        // tick 2: SAME plan within dwell -> no new writes, but a full readback
        const out2 = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flow);
        assert.strictEqual(out2.payload.wrote, false, 'no rewrite within the dwell window');
        assert.strictEqual(out2.payload.skipped_dwell, plan.writes.length, 'every write skipped by dwell');
        assert.strictEqual(writes.length, afterFirst, 'EEPROM untouched on the readback-only tick');
        assert.ok(out2.payload.registers.every((r) => r.match), 'readback still confirms the state');
      },
    );
  } finally {
    server.close();
  }
});

test('Deye executor executes the controller-owned RELEASE (disable ToU) once certified', async () => {
  // The Tier-3 failsafe: controlRelease disables the Time-of-Use scheduler so the
  // inverter reverts to self-consumption. Temporarily certified so the release is
  // executable; the logger reads back ToU disabled.
  const { server, port, store, writes } = await startSolarmanServer({ [controlRouting.DEYE_CONTROL_REG.hybrid_3p.touEnable]: 0x00ff });
  try {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
    try {
      const rel = controlRouting.controlRelease({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1' } }, {});
      assert.strictEqual(rel.mode, 'release');
      assert.ok(rel.writes.length >= 1, 'certified -> executable release');
      rel.connection.port = port;
      const out = await runExec(DEYE_EXEC, { control: rel, setpoint: {} });
      assert.ok(out, 'release readback published');
      assert.strictEqual(out.payload.mode, 'release');
      const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
      assert.strictEqual(store[reg.touEnable], 0, 'Time-of-Use DISABLED -> handed back to self-consumption');
      assert.ok(writes.some((w) => w.reg === reg.touEnable && w.value === 0));
      assert.ok(out.payload.registers.every((r) => r.match));
    } finally {
      controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
    }
  } finally {
    server.close();
  }
});

test('Deye executor no-ops for an UNCERTIFIED (production-default) Deye plan - never a live write', async () => {
  // The safety spine: with the default allowlist, controlRoute emits writes:[] /
  // readbacks:[] for Deye, so the executor writes NOTHING and publishes nothing.
  const { server, port, writes } = await startSolarmanServer({});
  try {
    const plan = controlRouting.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1', port } },
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true }, { ratedKw: 30 });
    assert.strictEqual(plan.certified, false, 'Deye stays uncertified by default');
    assert.strictEqual(plan.readbacks.length, 0);
    const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} });
    assert.strictEqual(out, null, 'no readback published for a read-only Deye plan');
    assert.strictEqual(writes.length, 0, 'NOTHING written to the logger');
  } finally {
    server.close();
  }
});

test('First-Light calibration writes a SMALL bounded value to the real logger WITHOUT certifying', async () => {
  // The very first real write to a live Deye battery: setpoint.calibration=true
  // un-gates the executor for the UNCERTIFIED family (no CERTIFIED_CONTROL_FAMILIES
  // change), the executor writes the small ToU plan over the Solarman-V5 wire and
  // reads every register back. This is the offline proof of the calibration path.
  const { server, port, store, writes } = await startSolarmanServer({});
  try {
    // A small -0.3 kW discharge test, calibration flag ON, family STILL uncertified.
    const plan = controlRouting.controlRoute(
      { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1' } },
      { battery_setpoint_kw: -0.3, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      { ratedKw: 30 },
    );
    assert.strictEqual(plan.certified, false, 'family is NOT certified - calibration is the bypass');
    assert.strictEqual(plan.calibration, true);
    assert.ok(plan.writes.length >= 5, 'the bounded ToU plan is executable during calibration');
    assert.ok(plan.writes.every((w) => w.dwell_s === 0), 'calibration writes carry dwell_s=0');
    plan.connection.port = port;
    const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } });
    assert.ok(out, 'the calibration write produced a readback');
    const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
    // -0.3 kW discharge at power_scale 1 -> 300 W in the Program-Power register.
    assert.strictEqual(store[reg.progPowerBase], 300, 'the small calibration setpoint was written');
    assert.strictEqual(store[reg.progSocBase], 10, 'discharge -> target SoC floor');
    assert.ok(out.payload.registers.every((r) => r.match), 'readback confirms the calibration write');
    assert.ok(writes.length >= 5);
  } finally {
    server.close();
  }
});

test('First-Light calibration auto-revert disables ToU on the real logger (never latches)', async () => {
  // The controller-owned auto-revert: controlRelease with the calibration flag
  // hands the uncertified Deye back (ToU disabled), proven end to end on the wire.
  const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
  const { server, port, store, writes } = await startSolarmanServer({ [reg.touEnable]: 0x00ff });
  try {
    const rel = controlRouting.controlRelease(
      { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1' } },
      { calibration: true },
    );
    assert.strictEqual(rel.mode, 'release');
    assert.strictEqual(rel.calibration, true);
    assert.ok(rel.writes.length >= 1, 'calibration release is executable for the uncertified family');
    rel.connection.port = port;
    const out = await runExec(DEYE_EXEC, { control: rel, setpoint: {} });
    assert.ok(out, 'release readback published');
    assert.strictEqual(store[reg.touEnable], 0, 'Time-of-Use DISABLED -> battery handed back to self-consumption');
    assert.ok(writes.some((w) => w.reg === reg.touEnable && w.value === 0));
  } finally {
    server.close();
  }
});

test('Deye executor ignores a non-Deye plan (the modbus executor owns that path)', async () => {
  const sunspec = controlRouting.controlRoute(
    { schema_version: '1.0', brand: 'generic_modbus', family: 'sunspec', communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port: 502, unit_id: 1 } },
    { battery_setpoint_kw: -5, source: 'schedule', control_enabled: true }, {});
  const out = await runExec(DEYE_EXEC, { control: sunspec, setpoint: {} });
  assert.strictEqual(out, null, 'adapter modbus_tcp -> the Solarman-V5 executor no-ops');
});

// --- one-socket coordination regression (report §5.6, the PRIMARY fix) ---------
//
// The real Solarman/LSW3 logger accepts only ONE TCP client. The old stub used a
// plain net.createServer (unlimited connections) and drove ONLY the write executor,
// so it could never reproduce the read-poll-vs-write contention that displaced the
// write on hardware. This SINGLE-CLIENT server RSTs a second concurrent connection
// (like the real stick) and is driven by the read poll AND the write executor on a
// SHARED flow context, so the bidirectional sv5_busy / sv5_write_want lock is proven.

// startSingleClientSolarmanServer accepts exactly ONE client at a time; a second
// concurrent connect is destroyed and flagged (state.sawConcurrent). Optional
// latencyMs delays every response so an in-flight read genuinely overlaps a write.
function startSingleClientSolarmanServer(initial = {}, opts = {}) {
  const store = Object.assign({}, initial);
  const writes = [];
  const state = { live: 0, totalConns: 0, sawConcurrent: false };
  const latencyMs = opts.latencyMs || 0;
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      state.totalConns += 1;
      if (state.live > 0) { state.sawConcurrent = true; sock.destroy(); return; } // single client
      state.live += 1;
      let acc = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('close', () => { state.live -= 1; });
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        let need;
        try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        while (need !== null && acc.length >= need) {
          const frame = acc.slice(0, need);
          acc = acc.slice(need);
          const seq = frame.readUInt16LE(5);
          const serial = frame.readUInt32LE(7);
          const mb = frame.slice(V5_REQ_MODBUS_OFFSET, frame.length - 2);
          const slave = mb[0];
          const fn = mb[1];
          let respMb;
          if (fn === 0x06) {
            const reg = mb.readUInt16BE(2);
            const value = mb.readUInt16BE(4) & 0xffff;
            store[reg] = value; writes.push({ reg, value });
            respMb = SV5.writeSingleRegisterRequest(slave, reg, value);
          } else if (fn === 0x03) {
            const addr = mb.readUInt16BE(2);
            const count = mb.readUInt16BE(4);
            const body = Buffer.alloc(3 + count * 2);
            body[0] = slave; body[1] = 0x03; body[2] = count * 2;
            for (let i = 0; i < count; i++) body.writeUInt16BE((store[addr + i] || 0) & 0xffff, 3 + i * 2);
            const crc = SV5.modbusCrc16(body);
            respMb = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
          } else { sock.destroy(); return; }
          const resp = buildV5Response(serial, seq, respMb);
          if (latencyMs > 0) setTimeout(() => { try { sock.write(resp); } catch (e) { /* closed */ } }, latencyMs);
          else sock.write(resp);
          try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, store, writes, state }));
  });
}

// The read poll's msg.deye context (what the router emits): identity + one read block.
function deyeReadMsg(port) {
  return {
    deye: {
      cfg: { ip: '127.0.0.1', port, serial: '2985159064', mb_slave_id: 1 },
      target: '127.0.0.1:' + port,
      reads: [{ start: 0x024c, count: 4 }],
      i: 0, blocks: [],
    },
  };
}

test('single-client Solarman server RSTs a second concurrent connection (models the real LSW3 stick)', async () => {
  // Sanity: the server models the real constraint the old stub lacked - only one
  // TCP client at a time. This is what makes the coordination proof below meaningful.
  const { server, port, state } = await startSingleClientSolarmanServer({}, { latencyMs: 50 });
  try {
    const s1 = net.connect(port, '127.0.0.1');
    await new Promise((res, rej) => { s1.once('connect', res); s1.once('error', rej); });
    const s2 = net.connect(port, '127.0.0.1');
    // the second concurrent connect is refused/closed by the single-client server
    await new Promise((res) => { s2.once('close', res); s2.once('error', () => {}); });
    assert.strictEqual(state.sawConcurrent, true, 'the server flagged the concurrent connection');
    s1.destroy();
  } finally {
    server.close();
  }
});

test('a pending write makes the read poll YIELD the single-client logger (write priority)', async () => {
  const { server, port, state } = await startSingleClientSolarmanServer({});
  try {
    const sharedFlow = {};
    sharedFlow['sv5_write_want:127.0.0.1:' + port] = Date.now(); // a write announced intent
    const out = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
    assert.strictEqual(out, null, 'the read yields this tick to the pending write');
    assert.strictEqual(state.totalConns, 0, 'the read did not open a socket while a write is pending');
  } finally {
    server.close();
  }
});

test('read poll + Deye write executor never collide on the single-client logger, and the write lands', async () => {
  // THE missing coverage: drive the read poll AND the write executor concurrently
  // against a single-client logger on a SHARED flow context. tick 1: the read holds
  // the socket, the write DEFERS (no colliding second connection). tick 2: the read
  // YIELDS to the pending write, which gets a clean window and lands its ToU registers.
  const { server, port, store, state } = await startSingleClientSolarmanServer({}, { latencyMs: 40 });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      async (plan) => {
        plan.connection.port = port;
        const sharedFlow = {};
        const readCtx = {};
        const writeCtx = {};

        // tick 1: read claims the socket first; the write must defer, not collide.
        const [ro1, wo1] = await Promise.all([
          runExec(READ_POLL, deyeReadMsg(port), readCtx, sharedFlow),
          runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow),
        ]);
        assert.ok(ro1, 'tick1: the read completed');
        assert.strictEqual(wo1, null, 'tick1: the write deferred to the in-flight read (no second socket)');
        assert.strictEqual(state.sawConcurrent, false, 'no concurrent connection to the single-client logger');
        await waitFor(() => state.live === 0); // logger released the read socket (seconds apart in prod)

        // tick 2: the read now yields to the pending write; the write gets a clean
        // window and completes its write -> readback -> match.
        const [ro2, wo2] = await Promise.all([
          runExec(READ_POLL, deyeReadMsg(port), readCtx, sharedFlow),
          runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow),
        ]);
        assert.strictEqual(ro2, null, 'tick2: the read yielded to the pending write (write priority)');
        assert.ok(wo2, 'tick2: the write got a clean socket and completed');
        assert.ok(wo2.payload.registers.every((r) => r.match), 'tick2: write -> readback matched on the single-client logger');
        assert.strictEqual(state.sawConcurrent, false, 'still no concurrent connection across both ticks');

        // and the ToU discharge power actually reached the logger.
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        assert.strictEqual(store[reg.progPowerBase], 20000, 'the discharge power (20 kW -> 20000 W) reached the logger');
      },
    );
  } finally {
    server.close();
  }
});

// --- the write-response blocker made visible (report §7.2, the PR z4 fix) -------
//
// The live Pilsting logger ACCEPTS the write frame but its V5 response carries a
// Modbus payload shorter than a valid RTU reply (the inverter did not properly
// answer). The executor must (1) fail with a NAMED reason - never a bare "zu kurz"
// - and (2) log the RAW request+response bytes + the parsed V5 header, so ONE more
// field test settles exactly what the logger returns.

test('Deye executor: a short/empty write reply is NAMED and its raw frames are logged (never bare "zu kurz")', async () => {
  const { server, port, writes } = await startSolarmanServer({}, { writeReply: 'empty' });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -0.3, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      async (plan) => {
        plan.connection.port = port;
        const { out, warns } = await runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } });
        assert.strictEqual(out, null, 'a short write reply cannot be confirmed -> no readback published');
        assert.ok(writes.length >= 1, 'the write frame DID reach the logger (it just could not be read back)');
        // (1) named reason, no bare "zu kurz"
        assert.ok(!warns.some((w) => /zu kurz/.test(w)), 'no bare "zu kurz" surfaced: ' + JSON.stringify(warns));
        assert.ok(
          warns.some((w) => /keine Modbus-Nutzlast|nicht geantwortet/.test(w)),
          'the failure names the reason: ' + JSON.stringify(warns),
        );
        // (2) raw request + response frames + the parsed V5 header are logged
        const raw = warns.find((w) => /Rohframe/.test(w));
        assert.ok(raw, 'a raw-frame diagnostic was logged: ' + JSON.stringify(warns));
        assert.match(raw, /Anfrage=\[A5 [0-9A-F ]+\]/, 'the raw REQUEST frame hex is present');
        assert.match(raw, /Antwort=\[A5 [0-9A-F ]+\]/, 'the raw RESPONSE frame hex is present');
        assert.match(raw, /Controlcode=0x1510/, 'the parsed V5 control code is present');
        assert.match(raw, /Seq=\d+/, 'the parsed V5 sequence is present');
        assert.match(raw, /Logger=2985159064/, 'the parsed logger serial is present');
        assert.match(raw, /Frametyp=0x2/, 'the parsed V5 frame-type is present');
        assert.match(raw, /Status=0x1/, 'the parsed V5 status byte is present');
      },
    );
  } finally {
    server.close();
  }
});

test('a deferred Deye write is LOUD (Logger belegt) and still lands once it gets the socket - never silently starved', async () => {
  // Item 5: the recurring "Logger belegt" must never mean a real write silently never
  // runs. tick 1: the read holds the single-client socket, the write DEFERS and WARNS
  // (audible, not just node status). tick 2: the read yields to the announced write,
  // which gets a clean, bounded window and lands its ToU registers.
  const { server, port, store, state } = await startSingleClientSolarmanServer({}, { latencyMs: 60 });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -0.3, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      async (plan) => {
        plan.connection.port = port;
        const sharedFlow = {}; const readCtx = {}; const writeCtx = {};

        // tick 1: the read claims the socket first; the write defers AND warns.
        const [ro1, w1] = await Promise.all([
          runExec(READ_POLL, deyeReadMsg(port), readCtx, sharedFlow),
          runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow),
        ]);
        assert.ok(ro1, 'tick1: the read completed');
        assert.strictEqual(w1.out, null, 'tick1: the write deferred to the in-flight read');
        assert.ok(
          w1.warns.some((l) => /Logger belegt/.test(l)),
          'tick1: the deferred write is LOUD (warned), never silent: ' + JSON.stringify(w1.warns),
        );
        await waitFor(() => state.live === 0); // logger released the read socket (seconds apart in prod)

        // tick 2: the read yields to the pending write, which lands.
        const [ro2, w2] = await Promise.all([
          runExec(READ_POLL, deyeReadMsg(port), readCtx, sharedFlow),
          runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow),
        ]);
        assert.strictEqual(ro2, null, 'tick2: the read yielded to the pending write');
        assert.ok(w2.out, 'tick2: the deferred write got its window and completed');
        assert.ok(w2.out.payload.registers.every((r) => r.match), 'tick2: write -> readback matched');
        assert.strictEqual(state.sawConcurrent, false, 'no concurrent connection to the single-client logger');
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        assert.strictEqual(store[reg.progPowerBase], 300, 'the -0.3 kW setpoint (300 W) reached the logger after the deferral');
      },
    );
  } finally {
    server.close();
  }
});
