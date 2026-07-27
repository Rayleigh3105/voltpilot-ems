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
  // power_scale is EXPLICIT (LV = 1): since the N1 fix a Deye whose HV/LV scale is
  // unknown gets NO ToU write plan at all (see the N1 test below).
  communication: 'solarman_v5', connection: { ip: '127.0.0.1', serial: '2985159064', mb_slave_id: 1, power_scale: 1 },
};

// --- a real in-process Solarman-V5 logger that honours FC6 + FC16 writes + FC3 reads ---
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
            if (!opts.dropWrites) { store[reg] = value; writes.push({ reg, value, fc: 0x06 }); }
            // writeReply models a logger that ACCEPTS the write frame (it arrives)
            // but returns a V5 response whose Modbus payload is too short to be a
            // valid RTU reply - the live-Pilsting shape: 'empty' = no Modbus bytes
            // (the inverter did not answer), 'stub' = a 1-byte fragment.
            if (opts.writeReply === 'empty') respMb = Buffer.alloc(0);
            else if (opts.writeReply === 'stub') respMb = Buffer.from([0x0b]);
            else respMb = SV5.writeSingleRegisterRequest(slave, reg, opts.dropWrites ? (store[reg] || 0) : value); // FC6 echo
          } else if (fn === 0x10) {
            // FC16 (write-multiple) - the DEFAULT Deye write path. The executor emits
            // 1-register FC16 writes; a real logger stores them and answers with the
            // ack echo [slave, 0x10, addrHi, addrLo, qtyHi, qtyLo, crc]. writeReply
            // still models the short-reply blocker on this path.
            const reg = mb.readUInt16BE(2);
            const qty = mb.readUInt16BE(4);
            for (let i = 0; i < qty; i++) {
              const v = mb.readUInt16BE(7 + i * 2) & 0xffff;
              if (!opts.dropWrites) { store[reg + i] = v; writes.push({ reg: reg + i, value: v, fc: 0x10 }); }
            }
            if (opts.writeReply === 'empty') respMb = Buffer.alloc(0);
            else if (opts.writeReply === 'stub') respMb = Buffer.from([0x0b]);
            else {
              const body = Buffer.alloc(6);
              body[0] = slave; body[1] = 0x10; body.writeUInt16BE(reg, 2); body.writeUInt16BE(qty, 4);
              const crc = SV5.modbusCrc16(body);
              respMb = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]); // FC16 ack
            }
          } else if (fn === 0x03) {
            const addr = mb.readUInt16BE(2);
            const count = mb.readUInt16BE(4);
            // A firmware WITHOUT the remote block answers a read of it with Modbus
            // exception 0x02 (illegal data address) - the definitive 'absent' verdict.
            if (Array.isArray(opts.exceptionFrom) && opts.exceptionFrom.indexOf(addr) !== -1) {
              const eb = Buffer.from([slave, 0x83, 0x02]);
              const ecrc = SV5.modbusCrc16(eb);
              sock.write(buildV5Response(serial, seq, Buffer.concat([eb, Buffer.from([ecrc & 0xff, (ecrc >> 8) & 0xff])])));
              try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
              continue;
            }
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

// --- FC16 by default, FC6 as the flip-back (the PR y7 fix) --------------------
//
// The live Pilsting blocker: the Deye ACCEPTS an FC6 write frame but never answers
// it and does not change the register (a 2-byte stub where the FC6 echo belongs).
// The demonstrably-working Deye integrations (deye-controller, ha-solarman via
// pysolarmanv5) write every register - even one - via FC16, so FC16 is now the
// default. control_write_fc:6 flips back for a firmware that only answers FC6.
// These assert the actual WIRE function code the logger saw (writes[].fc), not just
// that the write "succeeded".

test('Deye executor writes via FC16 (0x10) by default - the fix for firmwares that ignore FC6', async () => {
  const { server, port, writes } = await startSolarmanServer({});
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        assert.ok(plan.writes.every((w) => w.fc === 16), 'the planner stamps FC16 on every Deye WriteOp by default');
        plan.connection.port = port;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} });
        assert.ok(out, 'the FC16 write produced a readback');
        assert.ok(writes.length >= 5, 'the ToU plan reached the logger');
        // the decisive assertion: every write frame on the wire was FC16 (0x10)
        assert.ok(
          writes.every((w) => w.fc === 0x10),
          'every write frame on the wire was FC16 (0x10): ' + JSON.stringify(writes.map((w) => w.fc)),
        );
        assert.ok(out.payload.registers.every((r) => r.match), 'write -> FC3 readback matched over FC16');
        // and the ToU registers actually changed (FC16 is stored, not silently ignored)
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        assert.strictEqual(out.payload.registers.find((r) => r.role === 'battery_power').actual_raw, 20000);
      },
    );
  } finally {
    server.close();
  }
});

test('control_write_fc:6 flips the Deye write back to FC6 (0x06) - the escape hatch, still lands', async () => {
  const { server, port, writes } = await startSolarmanServer({});
  try {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
    try {
      const plan = controlRouting.controlRoute(
        { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1', control_write_fc: 6 } },
        { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
        { ratedKw: 30 },
      );
      assert.ok(plan.writes.every((w) => w.fc === 6), 'control_write_fc:6 stamps FC6 on every WriteOp');
      plan.connection.port = port;
      const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} });
      assert.ok(out, 'the FC6 write produced a readback');
      assert.ok(writes.length >= 5, 'the ToU plan reached the logger');
      assert.ok(
        writes.every((w) => w.fc === 0x06),
        'every write frame on the wire was FC6 (0x06): ' + JSON.stringify(writes.map((w) => w.fc)),
      );
      assert.ok(out.payload.registers.every((r) => r.match), 'write -> FC3 readback matched over FC6');
    } finally {
      controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
    }
  } finally {
    server.close();
  }
});

test('the executor logs ONE known-good FC3 readback frame (comparison baseline vs a bad write reply)', async () => {
  // Item 5: keep a good FC3 response one log line away, so a future field test can
  // compare a GOOD read frame against a BAD write reply without guesswork. It is
  // logged from the write executor (NOT the hot read poll) and once per process.
  const { server, port } = await startSolarmanServer({});
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -0.3, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      async (plan) => {
        plan.connection.port = port;
        const { out, warns } = await runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } });
        assert.ok(out, 'the write + readback completed');
        const ok = warns.find((w) => /Rueckleseframe OK/.test(w));
        assert.ok(ok, 'a known-good FC3 readback frame was logged: ' + JSON.stringify(warns));
        assert.match(ok, /Anfrage=\[A5 [0-9A-F ]+\]/, 'the raw FC3 REQUEST frame hex is present');
        assert.match(ok, /Antwort=\[A5 [0-9A-F ]+\]/, 'the raw FC3 RESPONSE frame hex is present');
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
            store[reg] = value; writes.push({ reg, value, fc: 0x06 });
            respMb = SV5.writeSingleRegisterRequest(slave, reg, value);
          } else if (fn === 0x10) {
            // FC16 (write-multiple) - the DEFAULT Deye write path. Stores the words and
            // answers the ack echo [slave, 0x10, addrHi, addrLo, qtyHi, qtyLo, crc].
            const reg = mb.readUInt16BE(2);
            const qty = mb.readUInt16BE(4);
            for (let i = 0; i < qty; i++) {
              const v = mb.readUInt16BE(7 + i * 2) & 0xffff;
              store[reg + i] = v; writes.push({ reg: reg + i, value: v, fc: 0x10 });
            }
            const body = Buffer.alloc(6);
            body[0] = slave; body[1] = 0x10; body.writeUInt16BE(reg, 2); body.writeUInt16BE(qty, 4);
            const crc = SV5.modbusCrc16(body);
            respMb = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
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

// --- snapshot capture + restore + crash recovery (report §8) ----------------------
//
// Deye has NO revert timer, so anything we change persists in EEPROM until we change
// it back. The executor captures the installer's pre-control register values BEFORE
// its first write (FC3), persists them DURABLY, and controlRelease writes them back on
// EVERY hand-back path (TTL / abort / disarm / control-off / connection loss all funnel
// into the same controlRelease at the plan node; startup crash recovery is its own
// node). These prove that whole loop on a real in-process Solarman-V5 logger.

const REG = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
const RECOVER = byId['auto-control-recover'].func;

// The installer's pre-control state the logger holds before VoltPilot ever writes.
function installerStore() {
  return {
    [REG.energyPattern]: 0,   // Battery First
    [REG.workMode]: 1,        // Zero-Export-to-Load (NOT our Export First)
    [REG.maxSellPower]: 8000, // installer sell cap
    [REG.solarSell]: 0,       // Solar Sell OFF
    [REG.touEnable]: 0,       // scheduler off (self-consumption)
    [REG.progTimeBase]: 0,
    [REG.progPowerBase]: 0,
    [REG.progSocBase]: 20,
    [REG.progChargeBase]: 0,
    [REG.exportLimit]: 9999,
  };
}

test('the executor SNAPSHOTS the installer pre-control values BEFORE its first write', async () => {
  const { server, port, store } = await startSolarmanServer(installerStore());
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        const flow = {};
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flow);
        assert.ok(out, 'the write + readback completed');
        assert.strictEqual(out.payload.snapshot_captured, true, 'a snapshot was captured');
        const snap = flow['deye_ctrl_snapshot'];
        assert.ok(snap && snap.regs, 'the snapshot was persisted durably (file store)');
        // it captured the PRE-control values (before the discharge writes changed them)
        assert.strictEqual(snap.regs[REG.maxSellPower], 8000, 'captured installer Max-Sell-Power');
        assert.strictEqual(snap.regs[REG.solarSell], 0, 'captured Solar-Sell OFF');
        assert.strictEqual(snap.regs[REG.workMode], 1, 'captured installer work-mode');
        assert.strictEqual(snap.regs[REG.touEnable], 0, 'captured scheduler off');
        // ... and the writes THEN changed the live registers (post-control)
        assert.strictEqual(store[REG.solarSell], 1, 'discharge enabled Solar-Sell');
        assert.strictEqual(store[REG.energyPattern], 1, 'discharge set Load First');
        assert.strictEqual(store[REG.maxSellPower], 20000, 'discharge set the sell-power forcing lever');
        assert.strictEqual(store[REG.touEnable], 0x00ff, 'ToU activated last');
        // the snapshot carries the identity so crash recovery works before config reload
        assert.strictEqual(snap.family, 'hybrid_3p');
        assert.strictEqual(snap.connection.serial, '2985159064');
        assert.strictEqual(snap.connection.control_write_fc, 16);
      },
    );
  } finally {
    server.close();
  }
});

test('the executor does NOT re-capture once a snapshot exists (one pre-control baseline)', async () => {
  const { server, port } = await startSolarmanServer(installerStore());
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        const ctx = {}; const flow = {};
        const out1 = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flow);
        assert.strictEqual(out1.payload.snapshot_captured, true);
        const snap1 = flow['deye_ctrl_snapshot'];
        // tick 2 (same plan, dwell): NOT re-captured, so a post-control read can never
        // overwrite the true pre-control baseline; EEPROM cadence unchanged (no writes).
        const out2 = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flow);
        assert.strictEqual(out2.payload.snapshot_captured, false, 'no re-capture once a snapshot exists');
        assert.strictEqual(out2.payload.wrote, false, 'dwell -> no rewrite (cadence unchanged)');
        assert.strictEqual(flow['deye_ctrl_snapshot'], snap1, 'the baseline snapshot is untouched');
      },
    );
  } finally {
    server.close();
  }
});

test('a RELEASE restores every captured register and CLEARS the snapshot (hand-back)', async () => {
  const { server, port, store } = await startSolarmanServer(installerStore());
  try {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
    try {
      const sel = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1' } };
      // 1) discharge -> capture the snapshot + change the registers
      const dis = controlRouting.controlRoute(sel, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 }, { ratedKw: 30 });
      dis.connection.port = port;
      const flow = {};
      await runExec(DEYE_EXEC, { control: dis, setpoint: {} }, {}, flow);
      const snap = flow['deye_ctrl_snapshot'];
      assert.ok(snap, 'snapshot captured');
      assert.strictEqual(store[REG.solarSell], 1, 'discharge changed Solar-Sell');
      // 2) release built FROM the snapshot (as the plan node / crash recovery would). This
      //    is the SAME release plan for every trigger (TTL/abort/disarm/loss/kill-off).
      const rel = controlRouting.controlRelease(sel, { snapshot: snap.regs });
      rel.connection.port = port;
      const out = await runExec(DEYE_EXEC, { control: rel, setpoint: {} }, {}, flow);
      assert.ok(out, 'release readback published');
      assert.strictEqual(out.payload.mode, 'release');
      // every installer value is restored on the wire - nothing left latched
      assert.strictEqual(store[REG.solarSell], 0, 'Solar-Sell restored OFF');
      assert.strictEqual(store[REG.energyPattern], 0, 'Energy-Pattern restored');
      assert.strictEqual(store[REG.workMode], 1, 'work-mode restored');
      assert.strictEqual(store[REG.maxSellPower], 8000, 'Max-Sell-Power restored');
      assert.strictEqual(store[REG.exportLimit], 9999, 'export cap restored');
      assert.strictEqual(store[REG.touEnable], 0, 'scheduler restored OFF (touEnable last)');
      assert.ok(out.payload.registers.every((r) => r.match), 'restore confirmed by readback');
      // the snapshot is CLEARED after a successful hand-back
      assert.strictEqual(flow['deye_ctrl_snapshot'], null, 'snapshot cleared on release');
      // idempotent: a second release with no snapshot is the plain touEnable=0 hand-back
      const rel2 = controlRouting.controlRelease(sel, {});
      rel2.connection.port = port;
      const out2 = await runExec(DEYE_EXEC, { control: rel2, setpoint: {} }, {}, flow);
      assert.ok(out2.payload.registers.every((r) => r.match), 'no-snapshot release still confirms');
    } finally {
      controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
    }
  } finally {
    server.close();
  }
});

test('CRASH RECOVERY: a leftover snapshot at startup restores the installer values + clears it', async () => {
  // The logger currently holds VoltPilot's discharge state (we crashed mid-control);
  // was_controlling lived in volatile context and is gone, but the durable snapshot
  // survived. The startup recovery node must hand the inverter back.
  const { server, port, store } = await startSolarmanServer({
    [REG.energyPattern]: 1, [REG.workMode]: 0, [REG.maxSellPower]: 20000, [REG.solarSell]: 1,
    [REG.touEnable]: 0x00ff, [REG.progTimeBase]: 0, [REG.progPowerBase]: 20000,
    [REG.progSocBase]: 10, [REG.progChargeBase]: 0, [REG.exportLimit]: 2500,
  });
  try {
    const flow = { deye_ctrl_snapshot: {
      family: 'hybrid_3p',
      connection: { ip: '127.0.0.1', port, serial: '2985159064', mb_slave_id: 1, control_write_fc: 16 },
      regs: installerStore(),
    } };
    // 1) the startup recovery node builds a restore plan from the leftover snapshot
    const recMsg = await runExec(RECOVER, {}, {}, flow);
    assert.ok(recMsg && recMsg.control, 'recovery emitted a restore plan');
    assert.strictEqual(recMsg.control.mode, 'release');
    assert.ok(recMsg.control.writes.length >= 5, 'the restore plan is executable (calibration bypass)');
    // 2) the executor restores the installer values + clears the snapshot
    const out = await runExec(DEYE_EXEC, recMsg, {}, flow);
    assert.ok(out, 'restore readback published');
    assert.strictEqual(store[REG.solarSell], 0, 'crash recovery restored Solar-Sell OFF');
    assert.strictEqual(store[REG.energyPattern], 0, 'restored Energy-Pattern');
    assert.strictEqual(store[REG.maxSellPower], 8000, 'restored Max-Sell-Power');
    assert.strictEqual(store[REG.touEnable], 0, 'restored scheduler OFF');
    assert.ok(out.payload.registers.every((r) => r.match), 'restore confirmed on the wire');
    assert.strictEqual(flow['deye_ctrl_snapshot'], null, 'snapshot cleared after recovery');
  } finally {
    server.close();
  }
});

test('CRASH RECOVERY is a no-op when there is no leftover snapshot', async () => {
  const recMsg = await runExec(RECOVER, {}, {}, {});
  assert.strictEqual(recMsg, null, 'no snapshot -> nothing to restore');
});

// --- N1 scale + N2 slot-time detection at the executor ---------------------------

test('N1: an UNCONFIRMED power_scale writes NOTHING to the logger (the 10x bug, live)', async () => {
  // The live symptom: an HV SG01HP3 on power_scale "Automatisch" fell back to scale 1,
  // so a commanded 0,3 kW discharge wrote raw 300 which the inverter read as 3000 W -
  // and the raised export ceiling let it empty the battery at 14,6 kW. Now the whole
  // plan is withheld until the scale is known: the wire audit must stay EMPTY.
  const { server, port, writes } = await startSolarmanServer({});
  try {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
    try {
      const base = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1', power_scale: undefined } };
      const sp = { battery_setpoint_kw: -0.3, source: 'schedule', control_enabled: true, soc_min_pct: 10 };
      const unset = controlRouting.controlRoute(base, sp, { ratedKw: 30 });
      assert.strictEqual(unset.powerScaleConfirmed, false);
      assert.deepStrictEqual(unset.writes, [], 'plan withheld');
      unset.connection.port = port;
      const { out, warns } = await runExecWarns(DEYE_EXEC, { control: unset, setpoint: {} }, {}, {});
      assert.strictEqual(out, null, 'no readback surface -> nothing published');
      assert.deepStrictEqual(writes, [], 'NOT ONE register was written to the logger');
      assert.ok(warns.some((w) => /Faehigkeitspruefung/.test(w)), 'the capability probe ran and reported: ' + JSON.stringify(warns));

      // HV auto-detect from the device register: the SAME setpoint now writes 30 raw
      // (decawatt), not 300. This is the fix, proven on the wire.
      const hvCap = controlRouting.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: null });
      const hv = controlRouting.controlRoute(base, sp, { ratedKw: 30, deye: hvCap });
      hv.connection.port = port;
      const r2 = await runExecWarns(DEYE_EXEC, { control: hv, setpoint: {} }, {}, {});
      assert.strictEqual(r2.out.payload.power_scale_confirmed, true);
      assert.ok(!r2.warns.some((w) => /N1/.test(w)), 'confirmed scale -> no N1 warn: ' + JSON.stringify(r2.warns));
      const byReg = Object.fromEntries(writes.map((w) => [w.reg, w.value]));
      const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
      assert.strictEqual(byReg[reg.progPowerBase], 30, 'HV 0,3 kW -> 30 raw (was 300 = the 10x bug)');
      assert.strictEqual(byReg[reg.maxSellPower], 30, 'the export ceiling is scaled too');
    } finally {
      controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
    }
  } finally {
    server.close();
  }
});

test('N2: the executor reads Programs 1-6 and surfaces a slot-time conflict (never rewrites 2-6)', async () => {
  // Programs 3 @ 00:01 and 5 @ 00:02 have started before Program 1 (00:00) is due, so at
  // essentially any time of day a LATER program governs "now" and our Program 1 is inert.
  const initial = installerStore();
  initial[REG.progTimeBase + 2] = 1; // Program 3 @ 00:01 (HHMM 1)
  initial[REG.progTimeBase + 4] = 2; // Program 5 @ 00:02
  const { server, port, writes } = await startSolarmanServer(initial);
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        const flow = {};
        const { out, warns } = await runExecWarns(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flow);
        assert.ok(out);
        // the executor READ all 6 program start times into the snapshot
        const snap = flow['deye_ctrl_snapshot'];
        assert.deepStrictEqual(snap.programTimes, [0, 0, 1, 0, 2, 0], 'captured all 6 program times');
        // the conflict flag matches the pure helper on the captured times + wall clock
        const d = new Date(); const nowMin = d.getHours() * 60 + d.getMinutes();
        const expected = controlRouting.deyeProgram1Displaced(snap.programTimes, nowMin);
        assert.strictEqual(out.payload.active_slot_conflict, expected, 'flag matches the pure detection');
        if (expected) assert.ok(warns.some((w) => /N2/.test(w)), 'displaced -> N2 warn: ' + JSON.stringify(warns));
        // it NEVER wrote Programs 2-6 (only Program 1's own time is a write op)
        const timeWrites = writes.filter((w) => w.reg > REG.progTimeBase && w.reg <= REG.progTimeBase + 5);
        assert.strictEqual(timeWrites.length, 0, 'Programs 2-6 start times are never rewritten');
      },
    );
  } finally {
    server.close();
  }
});

// =============================================================================
// Deye REMOTE MODE at the EXECUTOR (registers 1100-1121) - the wire proof.
// Drives the ACTUAL auto-control-exec-deye body from flows.json against the
// in-process Solarman-V5 logger: capability probe -> path interlock -> the ordered
// FC16 writes -> FC3 readback (+ the 1121 observation) -> release.
// =============================================================================

// A logger whose 1100..1121 block answers like the owner's SUN-30K-SG01HP3-EU
// (live read-only probe 2026-07-27): 1101 = 0xFFFF, 1105 = 2, everything else 0,
// plus the HV device-identity code 0x0008 in register 0x0000.
function remoteCapableStore(extra = {}) {
  return Object.assign({ 0x0000: 0x0008, 0x044d: 0xffff, 0x0451: 0x0002, 0x0456: 0x0320, 0x045b: 0x03e8, 0x045c: 0xffff }, extra);
}
const REMOTE_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', control_tier: 3, rated_kw: 30,
  communication: 'solarman_v5', connection: { ip: '127.0.0.1', serial: '2985159064', mb_slave_id: 1 },
};
// Build the remote plan the way controlRoute WOULD once the family is certified.
function certifiedRemotePlan(setpoint, cap, fn) {
  controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
  try {
    return fn(controlRouting.controlRoute(REMOTE_SEL, setpoint, { ratedKw: 30, deye: cap }));
  } finally {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
  }
}
function ownerCapability() {
  const b = new Array(22).fill(0);
  b[1] = 0xffff; b[5] = 0x0002; b[10] = 0x0320; b[15] = 0x03e8; b[16] = 0xffff;
  return controlRouting.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: b });
}

test('remote: the executor PROBES 1100..1121, caches the verdict and never writes on that tick', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    // A plan built with NO capability plans the ToU path; the probe then discovers
    // remote mode, so the executor must SKIP this tick (the plan targets the wrong
    // registers) and let the next one re-plan. Never write into the void.
    const tou = controlRouting.controlRoute(
      { ...REMOTE_SEL, connection: { ...REMOTE_SEL.connection, power_scale: 1 } },
      { battery_setpoint_kw: -1, source: 'calibration', control_enabled: true, calibration: true, soc_min_pct: 20 },
      { ratedKw: 30 },
    );
    assert.strictEqual(tou.controlPath, 'tou');
    tou.connection.port = port;
    const flowStore = {};
    const { out, warns } = await runExecWarns(DEYE_EXEC, { control: tou, setpoint: {} }, {}, flowStore);
    assert.strictEqual(out, null, 'the mismatched tick publishes nothing');
    assert.deepStrictEqual(writes, [], 'and writes NOTHING');
    assert.ok(warns.some((w) => /Steuerpfad wechselt zu Fernsteuerung/.test(w)), 'the path switch is audible: ' + JSON.stringify(warns));
    // the verdict is cached under the shared key so the PLAN node picks it up next tick
    const cap = flowStore[controlRouting.deyeCapabilityKey('127.0.0.1', port)];
    assert.ok(cap, 'capability cached');
    assert.strictEqual(cap.present, true);
    assert.strictEqual(cap.layout, 'pr978');
    assert.strictEqual(cap.scaleClass, 10, 'the HV identity register was read in the same pass');
    assert.ok(cap.at > 0);
    assert.strictEqual(store[0x044c], undefined, 'remote mode was NOT enabled by a probe');
  } finally {
    server.close();
  }
});

test('remote: the ordered write lands on the wire - watchdog FIRST, enable LAST, 1109 signed', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: -1, source: 'schedule', slot_start: '2026-07-27T12:00:00Z', control_enabled: true, soc_min_pct: 20, soc_max_pct: 95 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        // seed the cache so the interlock sees the SAME path the plan assumed
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, flowStore);
        assert.ok(out, 'the executor published a readback');
        // (a) ORDER on the wire is the safety property: the dead-man's switch is armed
        //     before anything can move, activation is last.
        const order = writes.map((w) => w.reg);
        assert.deepStrictEqual(order, [0x044d, 0x0450, 0x0451, 0x0454, 0x0455, 0x044c],
          'watchdog, battery-side, strategy, SoC belt, setpoint, ENABLE');
        assert.ok(writes.every((w) => w.fc === 0x10), 'FC16 (write-multiple) - the only code this firmware answers');
        // (b) the VALUES
        assert.strictEqual(store[0x044d], 60, 'watchdog 60 s');
        assert.strictEqual(store[0x0450], 1, 'BATTERY-side (PV production untouched)');
        assert.strictEqual(store[0x0451], 5, 'Power+SOC strategy');
        assert.strictEqual(store[0x0454], 20, 'the discharge SoC floor as an on-device belt');
        assert.strictEqual(store[0x0455], 33, 'discharge 1 kW of 30 kW rated -> +33 (0,1 %/unit)');
        assert.strictEqual(store[0x044c], 1, 'remote mode ENABLED');
        // (c) NOT ONE installer register was touched - the whole point of this path.
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        for (const inst of [reg.energyPattern, reg.workMode, reg.solarSell, reg.maxSellPower, reg.touEnable, reg.exportLimit]) {
          assert.strictEqual(store[inst], undefined, 'installer register 0x' + inst.toString(16) + ' untouched');
        }
        // (d) the readback confirms every commanded register and decodes 1109 to kW
        const rb = out.payload;
        assert.strictEqual(rb.control_path, 'remote');
        assert.ok(rb.registers.every((r) => r.match), 'all registers confirmed');
        const bp = rb.registers.find((r) => r.role === 'battery_power');
        assert.strictEqual(bp.actual_raw, 33);
        // 33 units x 0,1 % of 30 kW = 0,99 kW: the register's ~30 W quantization, not a
        // rounding bug. Decoded back into OUR sign convention (- = discharge).
        assert.strictEqual(bp.commanded_kw, -0.99);
        assert.strictEqual(bp.actual_kw, -0.99);
        // (e) 1121 rides `observations` - it is READ-ONLY and must never enter the
        //     commanded-vs-actual list (it would fabricate or break all_match).
        assert.strictEqual(rb.remote_status_raw, 0);
        assert.strictEqual(rb.registers.find((r) => r.role === 'remote_status'), undefined);
        // (f) no snapshot is captured: nothing installer-level was changed.
        assert.strictEqual(rb.snapshot_captured, false);
      },
    );
  } finally {
    server.close();
  }
});

test('remote: a CHARGE writes the NEGATED register and the SoC ceiling', async () => {
  const { server, port, store } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: 3, source: 'schedule', control_enabled: true, soc_min_pct: 20, soc_max_pct: 90 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, flowStore);
        assert.ok(out);
        assert.strictEqual(store[0x0455], 0xff9c, 'charge 3 kW of 30 kW -> -100 (two\'s complement)');
        assert.strictEqual(store[0x0454], 90, 'a charge is bounded by the SoC ceiling');
        const bp = out.payload.registers.find((r) => r.role === 'battery_power');
        assert.strictEqual(bp.commanded_kw, 3, '+ = charge in OUR convention');
      },
    );
  } finally {
    server.close();
  }
});

test('remote: EVERY tick re-asserts all six registers - the write IS the watchdog kick', async () => {
  // RAM registers have no write-endurance cost, and skipping an unchanged value would
  // let the dead-man's switch expire mid-operation (and leave a reverted 1100 off).
  const { server, port, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const ctx = {};
        await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        const first = writes.length;
        assert.strictEqual(first, 6, 'watchdog, mode, strategy, belt, setpoint, enable');
        // second tick with the IDENTICAL plan: write-on-change would skip everything.
        await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        assert.strictEqual(writes.length, first * 2, 'every register re-asserted (watchdog kicked)');
        assert.ok(writes.slice(first).some((w) => w.reg === 0x044d), 'incl. the watchdog itself');
      },
    );
  } finally {
    server.close();
  }
});

test('remote: release writes 1100 <- 0 and restores NOTHING (no installer setting was touched)', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore({ 0x044c: 1, 0x0455: 33 }));
  try {
    const cap = ownerCapability();
    const rel = controlRouting.controlRelease(REMOTE_SEL, { calibration: true, deye: cap });
    rel.connection.port = port;
    const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    const out = await runExec(DEYE_EXEC, { control: rel, setpoint: { source: 'calibration' } }, {}, flowStore);
    assert.ok(out, 'the release published a readback');
    assert.strictEqual(store[0x044c], 0, 'remote mode disabled -> the inverter is its own again');
    assert.deepStrictEqual(writes.map((w) => w.reg), [0x044c], 'exactly ONE register touched on the way out');
    assert.strictEqual(out.payload.mode, 'release');
    assert.strictEqual(out.payload.control_path, 'remote');
    assert.ok(out.payload.registers.every((r) => r.match));
  } finally {
    server.close();
  }
});

test('remote: an ABSENT block (Modbus exception) is classified definitively and keeps the ToU path', async () => {
  // A logger that answers the 1100 block with a Modbus exception = firmware without
  // remote mode. The executor must cache "absent" and run the legacy ToU plan.
  const { server, port, writes } = await startSolarmanServer({}, { exceptionFrom: [0x044c] });
  try {
    const tou = controlRouting.controlRoute(
      { ...REMOTE_SEL, connection: { ...REMOTE_SEL.connection, power_scale: 1 } },
      { battery_setpoint_kw: -1, source: 'calibration', control_enabled: true, calibration: true, soc_min_pct: 20 },
      { ratedKw: 30 },
    );
    tou.connection.port = port;
    const flowStore = {};
    const { out, warns } = await runExecWarns(DEYE_EXEC, { control: tou, setpoint: {} }, {}, flowStore);
    const cap = flowStore[controlRouting.deyeCapabilityKey('127.0.0.1', port)];
    assert.ok(cap, 'a verdict was cached');
    assert.strictEqual(cap.present, false, 'remote mode absent');
    assert.strictEqual(cap.definitive, true, 'a Modbus exception is DEFINITIVE');
    assert.ok(out, 'the ToU plan ran normally (no path switch)');
    assert.strictEqual(out.payload.control_path, 'tou');
    assert.ok(writes.some((w) => w.reg === controlRouting.DEYE_CONTROL_REG.hybrid_3p.touEnable), 'the ToU fallback wrote');
    assert.ok(warns.some((w) => /Faehigkeitspruefung/.test(w) && /nicht vorhanden|nicht lesbar/.test(w)));
  } finally {
    server.close();
  }
});

test('remote: remote_mode "off" forces ToU and does NOT deadlock the executor interlock', async () => {
  // REGRESSION: the interlock compares the plan's assumed path with the probed one.
  // The operator's force-ToU setting lives on the SELECTION, so unless the plan
  // carries it into `connection` the executor would compute "remote" from the cached
  // capability, disagree with the plan's "tou" and skip EVERY tick forever.
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
    try {
      const cap = ownerCapability();
      const sel = { ...REMOTE_SEL, connection: { ...REMOTE_SEL.connection, remote_mode: 'off', power_scale: 1 } };
      const plan = controlRouting.controlRoute(sel,
        { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
        { ratedKw: 30, deye: cap });
      assert.strictEqual(plan.controlPath, 'tou', 'the operator forced the ToU path');
      plan.connection.port = port;
      const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
      const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flowStore);
      assert.ok(out, 'the ToU plan RAN - the interlock must not veto a deliberate override');
      assert.ok(writes.length > 0, 'and it wrote');
      assert.strictEqual(store[0x044c], undefined, 'remote mode was never enabled');
      assert.strictEqual(out.payload.control_path, 'tou');
    } finally {
      controlRouting.CERTIFIED_CONTROL_FAMILIES.delete('hybrid_3p');
    }
  } finally {
    server.close();
  }
});

// --- Defect 2: a BLOCKED plan (empty because something is WRONG) is never silent ---
//
// The remote-mode nameplate-unknown refusal (and the ToU scale-suppressed refusal)
// carry blocked:true. The executor must SURFACE that - a rate-limited node.warn AND a
// blocked readback for the :8484 card - instead of the old silent "Probe-only tick"
// return. A legitimately QUIET plan (uncertified / Not-Aus, no blocked flag) must stay
// silent. No server needed: a blocked/quiet plan returns before opening a socket (a
// fresh cached capability makes the probe not-due, so the early-return branch runs).
test('Defect 2: a blocked (nameplate-unknown) remote plan warns AND publishes a blocked readback', async () => {
  const cap = ownerCapability();
  // The live-pilot defect: rated_kw absent from the (old) selection -> the plan node
  // passes ratedKw undefined -> deyeRemoteControl refuses with blocked:true.
  const blocked = controlRouting.controlRoute(
    REMOTE_SEL,
    { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true },
    { deye: cap }, // NO ratedKw -> nameplate unknown
  );
  assert.strictEqual(blocked.controlPath, 'remote');
  assert.strictEqual(blocked.blocked, true, 'precondition: the plan is flagged blocked');
  assert.deepStrictEqual(blocked.readbacks, []);
  // A FRESH cached capability so the executor's probe is not due -> early-return branch.
  const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', 8899)]: Object.assign({}, cap, { at: Date.now() }) };
  const { out, warns } = await runExecWarns(
    DEYE_EXEC, { control: blocked, setpoint: { source: 'schedule' } }, {}, flowStore,
  );
  assert.ok(out && out.payload, 'the executor publishes a blocked readback, not null');
  assert.strictEqual(out.payload.blocked, true, 'the readback is flagged blocked for the card');
  assert.match(out.payload.reason, /Nennleistung/, 'the readback carries the cause');
  // (registers is a vm-realm array, so compare by length, not deepStrictEqual)
  assert.strictEqual(out.payload.registers.length, 0, 'a blocked readback has no registers');
  assert.ok(
    warns.some((w) => /angehalten/.test(w) && /Nennleistung/.test(w)),
    'the refusal is audible in the log, never silent: ' + JSON.stringify(warns),
  );
});

test('Defect 2: a legitimately quiet (uncertified) plan stays SILENT - no warn, no readback', async () => {
  // A properly-configured but uncertified Deye (the live read-only sites): readbacks
  // empty, reason "noch nicht freigegeben", NO blocked flag. Its power_scale is known
  // (DEYE_SEL sets 1), so it is NOT scale-suppressed - purely the routine quiet case.
  const quiet = controlRouting.controlRoute(
    DEYE_SEL, { battery_setpoint_kw: -5, source: 'schedule', control_enabled: true }, { ratedKw: 30 },
  );
  assert.notStrictEqual(quiet.blocked, true, 'precondition: the quiet plan is not blocked');
  assert.deepStrictEqual(quiet.readbacks, []);
  const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', 8899)]: { at: Date.now() } };
  const { out, warns } = await runExecWarns(
    DEYE_EXEC, { control: quiet, setpoint: { source: 'schedule' } }, {}, flowStore,
  );
  assert.strictEqual(out, null, 'a quiet plan publishes nothing');
  assert.deepStrictEqual(warns, [], 'and stays silent (the read-only sites must not spam)');
});
