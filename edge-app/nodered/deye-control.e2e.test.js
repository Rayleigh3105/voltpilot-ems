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
            // zeroReads models the DOCUMENTED Solarman failure mode: the logger cannot
            // reach the inverter yet still answers with a well-framed, CRC-VALID
            // ALL-ZERO register block. Scoped to the remote block (0x044c..0x0461) so
            // the capability probe of the device register 0x0000 stays honest.
            const zeroed = opts.zeroReads && addr >= 0x044c && addr <= 0x0461;
            // fillerReads models what the pilot's logger ACTUALLY did (live sampling
            // 2026-07-30 09:34:36Z / 09:36:16Z): individual registers of the remote
            // block come back 0xFFFF - impossible for a 0..3 / 0..2 / 0..5 register,
            // so it is a filler for a register the gateway could not fetch.
            const filler = Array.isArray(opts.fillerReads) && opts.fillerReads.indexOf(addr) !== -1;
            if (filler) {
              for (let i = 0; i < count; i++) body.writeUInt16BE(0xffff, 3 + i * 2);
              const fcrc = SV5.modbusCrc16(body);
              sock.write(buildV5Response(serial, seq, Buffer.concat([body, Buffer.from([fcrc & 0xff, (fcrc >> 8) & 0xff])])));
              try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
              continue;
            }
            for (let i = 0; i < count; i++) {
              // watchdogRead models a LIVE countdown: register 1101 answers the
              // remaining seconds, not the value we armed it with a moment ago.
              const live = (opts.watchdogRead !== undefined && addr + i === 0x044d)
                ? opts.watchdogRead : (store[addr + i] || 0);
              body.writeUInt16BE(zeroed ? 0 : live & 0xffff, 3 + i * 2);
            }
            const crc = SV5.modbusCrc16(body);
            respMb = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
            // flakyReads: the first N single-register reads of the remote block come
            // back GARBLED (broken CRC) on a socket that is otherwise perfectly alive -
            // this exercises the executor's bounded per-register retry.
            if (opts.flakyReads > 0 && count === 1 && addr >= 0x044c && addr <= 0x0461) {
              opts.flakyReads -= 1;
              respMb = Buffer.from(respMb);
              respMb[respMb.length - 1] ^= 0xff; // corrupt the CRC
            }
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
// The deliberate-fallback gate (2026-07-28): certified ToU writes engage only on a
// DEFINITIVE "no remote mode" capability verdict (or remote_mode=off / a calibration
// test) - never on a guess. These e2e tests exercise the ToU WIRE path, so they plan
// with the definitive absent verdict (an unreadable block with no error), exactly what
// the executor caches after a real 0x02 illegal-data-address answer.
const TOU_E2E_CAP = controlRouting.classifyDeyeCapability({ deviceType: null, remoteBlock: null });

function certifiedDeyePlan(setpoint, fn) {
  controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
  try {
    const plan = controlRouting.controlRoute({ ...DEYE_SEL, connection: { ...DEYE_SEL.connection, ip: '127.0.0.1' } }, setpoint, { ratedKw: 30, deye: TOU_E2E_CAP });
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
        { ratedKw: 30, deye: TOU_E2E_CAP },
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
  //
  // The store carries the installer's OWN non-zero values (the live max_sell_power
  // 7182 is the real one from Pilsting). That matters since the flap fix: an
  // ALL-ZERO answer to registers we commanded non-zero values into is the Solarman
  // "inverter did not answer" stub and is reported as UNCONFIRMED, so a faithful
  // "the device really ignored the write" test must not accidentally use that
  // shape - a real inverter's registers are not all zero.
  const { server, port } = await startSolarmanServer(
    { [controlRouting.DEYE_CONTROL_REG.hybrid_3p.maxSellPower]: 7182 },
    { dropWrites: true },
  );
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

test('a pending Deye write WINS the single-client logger by waiting out an in-flight read (no collision, lands in one tick)', async () => {
  // Defect 2, the core fix: drive the read poll AND the write executor concurrently
  // against a single-client logger on a SHARED flow context. The read claims the
  // socket first; the write ANNOUNCES intent (sv5_write_want) and WAITS the in-flight
  // read OUT (bounded), then claims the freed socket and lands its ToU registers - all
  // within ONE tick, with NEVER a colliding second connection. Previously the write
  // bounced to the next ~10 s setpoint tick (the "auf den naechsten Takt verschoben"
  // symptom); now it reliably wins the socket.
  const { server, port, store, state } = await startSingleClientSolarmanServer({}, { latencyMs: 40 });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      async (plan) => {
        plan.connection.port = port;
        // Snappy acquire polling for the test (production polls every 300 ms).
        const sharedFlow = { sv5_acquire_poll_ms: 20 };
        const readCtx = {};
        const writeCtx = {};

        const [ro, wo] = await Promise.all([
          runExec(READ_POLL, deyeReadMsg(port), readCtx, sharedFlow),
          runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow),
        ]);
        assert.ok(ro, 'the read completed');
        assert.ok(wo, 'the write WON the socket by waiting out the read - it did NOT defer to the next tick');
        assert.ok(wo.payload.registers.every((r) => r.match), 'write -> readback matched on the single-client logger');
        assert.strictEqual(state.sawConcurrent, false, 'never a concurrent connection to the single-client logger');
        // The write releases its intent + resets the deferral counter on a landed write.
        assert.ok(!sharedFlow['sv5_write_want:127.0.0.1:' + port], 'the write cleared its intent after landing');
        assert.strictEqual(sharedFlow['sv5_write_defers:127.0.0.1:' + port] || 0, 0, 'a landed write leaves the defer counter at 0');

        // and the ToU discharge power actually reached the logger.
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        assert.strictEqual(store[reg.progPowerBase], 20000, 'the discharge power (20 kW -> 20000 W) reached the logger');
      },
    );
  } finally {
    server.close();
  }
});

test('the read poll yields to a pending write for a BOUNDED number of ticks, then forces a read so telemetry never starves', async () => {
  // Defect 2, telemetry protection: the read yields to an announced write, but only up
  // to maxSkips consecutive ticks; past the bound it takes the socket anyway and REPORTS
  // it, so a stuck write intent can never starve telemetry indefinitely.
  const { server, port, state } = await startSingleClientSolarmanServer({});
  try {
    const target = '127.0.0.1:' + port;
    const sharedFlow = {};
    const runRead = () => {
      sharedFlow['sv5_write_want:' + target] = Date.now(); // keep a fresh write intent each tick
      return runExecWarns(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
    };
    // Non-calibration intent -> the bound is 3 consecutive skips.
    for (let i = 0; i < 3; i++) {
      const r = await runRead();
      assert.strictEqual(r.out, null, 'tick ' + (i + 1) + ': the read yields to the pending write');
    }
    assert.strictEqual(state.totalConns, 0, 'no socket opened while yielding');
    assert.strictEqual(sharedFlow['sv5_read_skips:' + target], 3, 'three consecutive skips recorded');

    // The 4th tick FORCES a read (telemetry protection) and reports it.
    const forced = await runRead();
    assert.ok(forced.out, 'the 4th tick forces a read despite the pending write (telemetry never starves)');
    assert.ok(forced.warns.some((l) => /erzwungen/.test(l)), 'the forced read is reported: ' + JSON.stringify(forced.warns));
    assert.strictEqual(sharedFlow['sv5_read_skips:' + target], 0, 'the skip counter reset after the forced read');
  } finally {
    server.close();
  }
});

test('a calibration write earns a STRONGER read-yield claim (a higher skip bound than a normal write)', async () => {
  // Defect 2: an active First-Light calibration test (bounded, supervised, short) gets a
  // higher yield budget (6 vs 3), so its write is not forced to compete after 3 ticks.
  const { server, port } = await startSingleClientSolarmanServer({});
  try {
    const target = '127.0.0.1:' + port;
    const sharedFlow = {};
    // A normal write would be forced to yield after 3 ticks; a calibration write yields
    // up to 6, so the read still steps aside on the 4th and 5th ticks.
    for (let i = 0; i < 5; i++) {
      sharedFlow['sv5_write_want:' + target] = Date.now();
      sharedFlow['sv5_write_cal:' + target] = Date.now(); // a calibration test is in progress
      const r = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
      assert.strictEqual(r, null, 'calibration tick ' + (i + 1) + ': the read still yields (stronger claim)');
    }
    assert.strictEqual(sharedFlow['sv5_read_skips:' + target], 5, 'five skips and still yielding for calibration');
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

test('a starved Deye write is DEFERRED, COUNTED and reported LOUDLY (never invisible), then lands once the socket frees', async () => {
  // Defect 2, measurable: if the write genuinely cannot win the socket within its
  // acquire budget (a logger held busy by the read poll for too long), it DEFERS one
  // tick - but a REPEATED deferral must never be invisible. The 1st defer is audible
  // (rate-limited), the Nth consecutive defer WARNs with the running count, and a
  // landed write RESETS the counter.
  const { server, port, store } = await startSingleClientSolarmanServer({});
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -0.3, source: 'calibration', control_enabled: true, soc_min_pct: 10, calibration: true },
      async (plan) => {
        plan.connection.port = port;
        const target = '127.0.0.1:' + port;
        const busyK = 'sv5_busy:' + target;
        const deferK = 'sv5_write_defers:' + target;
        // A short acquire budget + a socket held busy the whole time forces a real,
        // fast, deterministic deferral (models a read poll that keeps the logger busy).
        const sharedFlow = { sv5_acquire_ms: 300, sv5_acquire_poll_ms: 30 };
        const writeCtx = {};

        // 1st defer: LOUD via the rate-limited busy warn.
        sharedFlow[busyK] = Date.now();
        const d1 = await runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow);
        assert.strictEqual(d1.out, null, 'the write could not win the busy socket -> deferred');
        assert.ok(d1.warns.some((l) => /Logger belegt/.test(l)), '1st defer is audible: ' + JSON.stringify(d1.warns));
        assert.strictEqual(sharedFlow[deferK], 1, 'the consecutive-defer counter incremented');
        // The write released its intent so a real read poll would resume (telemetry safe).
        assert.ok(!sharedFlow['sv5_write_want:' + target], 'the deferred write released its intent so reads resume');

        // 2nd consecutive defer: the count-based WARN names the running total.
        sharedFlow[busyK] = Date.now();
        const d2 = await runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow);
        assert.strictEqual(d2.out, null, 'still deferred while the socket stays busy');
        assert.ok(
          d2.warns.some((l) => /Takte in Folge verschoben/.test(l)),
          '2nd consecutive defer is reported with the running count: ' + JSON.stringify(d2.warns),
        );
        assert.strictEqual(sharedFlow[deferK], 2, 'the deferral count is now 2');

        // Socket frees: the write wins it, lands, and RESETS the deferral counter.
        sharedFlow[busyK] = 0;
        const done = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'calibration' } }, writeCtx, sharedFlow);
        assert.ok(done, 'the write lands once the socket frees');
        assert.ok(done.payload.registers.every((r) => r.match), 'write -> readback matched');
        assert.strictEqual(sharedFlow[deferK], 0, 'a landed write RESETS the consecutive-defer counter');
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
      const dis = controlRouting.controlRoute(sel, { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 }, { ratedKw: 30, deye: TOU_E2E_CAP });
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
      const unset = controlRouting.controlRoute(base, sp, { ratedKw: 30, deye: TOU_E2E_CAP });
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
// `sel` defaults to REMOTE_SEL; pass an override (e.g. connection.remote_battery_strategy=5)
// to exercise the opt-in Power+SOC belt path.
function certifiedRemotePlan(setpoint, cap, fn, sel = REMOTE_SEL) {
  controlRouting.CERTIFIED_CONTROL_FAMILIES.add('hybrid_3p');
  try {
    return fn(controlRouting.controlRoute(sel, setpoint, { ratedKw: 30, deye: cap }));
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

test('remote: the DEFAULT ordered write lands on the wire - strategy 2, watchdog FIRST, enable LAST, NO 1108', async () => {
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
        //     before anything can move, activation is last. THE DEFAULT is strategy 2,
        //     so 1108 (0x0454) is NOT on the wire at all - the setpoint is the only
        //     instruction (the fix for the live SUN-30K reading 1108 as a target).
        const order = writes.map((w) => w.reg);
        assert.deepStrictEqual(order, [0x044d, 0x0450, 0x0451, 0x0455, 0x044c],
          'watchdog, battery-side, strategy, setpoint, ENABLE - no SoC belt');
        assert.ok(writes.every((w) => w.fc === 0x10), 'FC16 (write-multiple) - the only code this firmware answers');
        // (b) the VALUES
        assert.strictEqual(store[0x044d], 60, 'watchdog 60 s');
        assert.strictEqual(store[0x0450], 1, 'BATTERY-side (PV production untouched)');
        assert.strictEqual(store[0x0451], 2, 'Power (2) strategy by default');
        assert.strictEqual(store[0x0454], undefined, 'strategy 2 writes NO on-device SoC belt (1108)');
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

test('remote: strategy 5 (opt-in) - a CHARGE writes the NEGATED register and the SoC CEILING', async () => {
  const { server, port, store } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    const strat5 = { ...REMOTE_SEL, connection: { ...REMOTE_SEL.connection, remote_battery_strategy: 5 } };
    await certifiedRemotePlan(
      { battery_setpoint_kw: 3, source: 'schedule', control_enabled: true, soc_min_pct: 20, soc_max_pct: 90 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, flowStore);
        assert.ok(out);
        assert.strictEqual(store[0x0451], 5, 'Power+SOC strategy (opt-in)');
        assert.strictEqual(store[0x0455], 0xff9c, 'charge 3 kW of 30 kW -> -100 (two\'s complement)');
        assert.strictEqual(store[0x0454], 90, 'a charge is bounded by the SoC ceiling');
        const bp = out.payload.registers.find((r) => r.role === 'battery_power');
        assert.strictEqual(bp.commanded_kw, 3, '+ = charge in OUR convention');
      },
      strat5,
    );
  } finally {
    server.close();
  }
});

test('remote: every tick re-asserts the watchdog kick + command + enable, and NOT the two config registers', async () => {
  // RAM registers have no write-endurance cost, but the Solarman logger has ONE
  // socket: every avoided write is socket time the readback and the read poll get
  // back. So the per-tick re-assert is scoped to the three ops where it IS the
  // mechanism (watchdog kick / the command / an enable that self-heals a watchdog
  // expiry within one tick); the battery-side selector + strategy re-assert on an
  // interval and on demand (see the mismatch self-heal test below).
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
        assert.strictEqual(first, 5, 'first tick: watchdog, mode, strategy, setpoint, enable');
        // second tick with the IDENTICAL plan
        await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        const second = writes.slice(first).map((w) => w.reg);
        assert.deepStrictEqual(second, [0x044d, 0x0455, 0x044c],
          'watchdog 1101 + setpoint 1109 + enable 1100 - in the load-bearing order, and nothing else');
        assert.ok(second.includes(0x044d), 'incl. the watchdog itself (the kick must never be skipped)');
        assert.ok(!second.includes(0x0450) && !second.includes(0x0451),
          'the configuration registers are not re-written on an unchanged tick');
      },
    );
  } finally {
    server.close();
  }
});

test('remote: a config register the inverter did NOT hold is re-written on the very next tick', async () => {
  // The self-heal that makes the reduced cadence safe: the readback verdict for
  // 1104 is 'mismatch', so the executor drops its write-cache entry and the next
  // tick writes exactly that register again - no waiting for the interval.
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
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
        // the inverter drops the battery-side selector back to AC-side behind our back
        store[0x0450] = 0;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        assert.strictEqual(out.payload.verify, 'mismatch', 'a REAL deviation is still reported as one');
        const pcm = out.payload.registers.find((r) => r.role === 'power_control_mode');
        assert.strictEqual(pcm.verdict, 'mismatch');
        assert.strictEqual(pcm.actual_raw, 0);
        // third tick: the mismatch invalidated the cache -> 1104 is written again
        const before = writes.length;
        await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        assert.ok(writes.slice(before).some((w) => w.reg === 0x0450),
          'the not-held configuration register is re-asserted immediately');
        assert.strictEqual(store[0x0450], 1, 'and the inverter is back on battery-side control');
        assert.ok(writes.length > first, 'sanity: writes did happen');
      },
    );
  } finally {
    server.close();
  }
});

// --- THE FLAP (live Pilsting, 2026-07-30) -------------------------------------
//
// Symptom: "Er uebernimmt den Sollwert, aber jede 8 Sekunden meldet er dass es nicht
// uebernommen wird und kurz danach geht es wieder ... aber die Batterie macht das was
// wir ihr sagen", with the register list remote_watchdog, power_control_mode,
// battery_strategy, remote_mode - i.e. EVERY register whose commanded value is
// non-zero, while battery_power (commanded ~0 at the time) "matched" a zero.
// That is the signature of a Solarman zero-answer being read as the inverter's actual
// value. Here the logger accepts every write and answers the READBACK with a
// well-framed, CRC-valid all-zero block.
test('FLAP: a Solarman all-zero readback answer is UNCONFIRMED, never "Sollwert nicht uebernommen"', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore(), { zeroReads: true });
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: 0, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const { out, warns } = await runExecWarns(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, flowStore);
        assert.ok(out, 'the cycle is still PUBLISHED - the operator is not left on a stale verdict');
        const rb = out.payload;
        // The control itself happened: every register was written to the inverter.
        assert.strictEqual(writes.length, 5, 'the writes landed - the battery IS being commanded');
        assert.strictEqual(store[0x044c], 1, 'remote mode enabled on the device');
        // ... and the confirmation is honest about knowing nothing.
        assert.strictEqual(rb.verify, 'unconfirmed');
        assert.ok(rb.registers.every((r) => r.verdict === 'unread'), 'no register is claimed to deviate');
        assert.ok(rb.registers.every((r) => r.actual_raw === null), 'and none reports a fabricated 0');
        assert.ok(rb.registers.every((r) => r.actual_kw === undefined), 'not even a fabricated 0 kW');
        // The palette node is what publishes all_match/mismatch_roles to the core.
        const shaped = require('./vp-palette/nodes/vp-control-readback').shape(rb);
        assert.strictEqual(shaped.all_match, null, 'null = no verdict, NOT a mismatch');
        assert.deepStrictEqual(shaped.mismatch_roles, [], 'the four registers are NOT accused');
        assert.deepStrictEqual(
          shaped.unread_roles,
          ['remote_watchdog', 'power_control_mode', 'battery_strategy', 'battery_power', 'remote_mode'],
        );
        assert.strictEqual(shaped.dual_controller.possible_conflict, false,
          'and no second controller is blamed for a read that never arrived');
        // The silence is AUDIBLE in the log instead of being swallowed.
        assert.ok(warns.some((w) => /ohne Rueckmeldung/.test(w)), 'the missing confirmation is logged: ' + warns.join(' | '));
      },
    );
  } finally {
    server.close();
  }
});

test('FLAP (measured live): 0xFFFF fillers on 1100/1104/1105 are UNCONFIRMED, not a refusal', async () => {
  // The pilot's exact 09:36:16Z cycle: power_control_mode, battery_strategy and
  // remote_mode all answered 65535 while the write had just landed. 65535 is
  // impossible for those registers (0..2 / 0..5 / 0..3), so it is a filler.
  const opts = { fillerReads: [0x0450, 0x0451, 0x044c] };
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore(), opts);
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const ctx = {};
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, ctx, flowStore);
        assert.ok(out);
        assert.strictEqual(writes.length, 5, 'the control writes landed');
        assert.strictEqual(store[0x044c], 1, 'the device really is in remote mode');
        const rb = out.payload;
        assert.strictEqual(rb.verify, 'unconfirmed', 'a filler is no answer - and no accusation');
        const shaped = require('./vp-palette/nodes/vp-control-readback').shape(rb);
        assert.deepStrictEqual(shaped.mismatch_roles, []);
        assert.deepStrictEqual(shaped.unread_roles, ['power_control_mode', 'battery_strategy', 'remote_mode']);
        assert.strictEqual(shaped.all_match, null);
        for (const role of ['power_control_mode', 'battery_strategy', 'remote_mode']) {
          const r = rb.registers.find((x) => x.role === role);
          assert.strictEqual(r.actual_raw, null, role + ' must not report 65535 as the inverter value');
          assert.match(r.note, /unplausibler Rueckgabewert 65535/);
        }
        // the registers that DID answer are still judged normally
        assert.strictEqual(rb.registers.find((r) => r.role === 'remote_watchdog').verdict, 'held');
        assert.strictEqual(rb.registers.find((r) => r.role === 'battery_power').verdict, 'held');
        // ... and the next healthy cycle confirms again (the "kurz danach geht es wieder")
        opts.fillerReads = [];
        const ok = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, ctx, flowStore);
        assert.strictEqual(ok.payload.verify, 'held');
      },
    );
  } finally {
    server.close();
  }
});

test('FLAP: a garbled readback frame is RETRIED on the socket we hold and then confirms', async () => {
  // Coordination + retry instead of alarm: one corrupt FC3 answer (bad CRC) used to
  // abort the whole tick; now the register is simply read again on the same socket.
  const { server, port } = await startSolarmanServer(remoteCapableStore(), { flakyReads: 1 });
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, flowStore);
        assert.ok(out, 'a single garbled frame no longer aborts the tick');
        assert.strictEqual(out.payload.verify, 'held', 'the retry read the real value -> confirmed');
        assert.ok(out.payload.registers.every((r) => r.match));
      },
    );
  } finally {
    server.close();
  }
});

test('FLAP counter-case: a REAL refusal is still reported as a mismatch naming the register', async () => {
  // The honest other half: the inverter left remote mode (watchdog off, battery-side
  // reverted, enable 0). That is NOT an all-zero block, so nothing swallows it.
  const { server, port } = await startSolarmanServer(remoteCapableStore(), { dropWrites: true });
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, flowStore);
        assert.ok(out);
        assert.strictEqual(out.payload.verify, 'mismatch');
        const shaped = require('./vp-palette/nodes/vp-control-readback').shape(out.payload);
        assert.strictEqual(shaped.all_match, false);
        assert.ok(shaped.mismatch_roles.includes('remote_mode'), 'the refused enable is named: ' + shaped.mismatch_roles);
        assert.strictEqual(shaped.dual_controller.possible_conflict, true, 'a real deviation still raises the only-controller hint');
      },
    );
  } finally {
    server.close();
  }
});

test('remote: a WATCHDOG counting down reads as HELD (the register is a timer, not a value)', async () => {
  // The dynamic-register half of the flap: 1101 is a dead-man's timer the inverter
  // owns after we arm it. A remaining 43 s of an armed 60 s is the timer WORKING.
  // The register answers the REMAINING seconds (43 of the armed 60), which is what a
  // live timer does between our write and our read.
  const opts = { watchdogRead: 43 };
  const { server, port } = await startSolarmanServer(remoteCapableStore(), opts);
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      { battery_setpoint_kw: -1, source: 'schedule', control_enabled: true, soc_min_pct: 20 },
      cap,
      async (plan) => {
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const ctx = {};
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        assert.strictEqual(out.payload.verify, 'held', 'a counting watchdog is not a refused write');
        const wd = out.payload.registers.find((r) => r.role === 'remote_watchdog');
        assert.strictEqual(wd.match, true);
        assert.strictEqual(wd.actual_raw, 43);
        assert.match(wd.note, /laeuft ab \(43 s von 60 s\)/, 'and the technician sees WHY it differs');
        // an EXPIRED / switched-off watchdog stays a real mismatch
        opts.watchdogRead = 0xffff;
        const off = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        assert.strictEqual(off.payload.verify, 'mismatch');
        const offWd = off.payload.registers.find((r) => r.role === 'remote_watchdog');
        assert.strictEqual(offWd.verdict, 'mismatch');
        assert.match(offWd.note, /AUS/);
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

// =============================================================================
// THE FAHRPLAN PATH, END TO END, WITH A RUNTIME FIRST-LIGHT GRANT.
//
// Everything above that exercises a live Deye write either mutates
// CERTIFIED_CONTROL_FAMILIES (a bench certification we have NOT granted) or sets
// the calibration bypass. Neither is what runs on the pilot at 20:00: there the
// core publishes a NORMAL schedule setpoint carrying the per-device First-Light
// grant it earned. These tests drive the REAL chain - the plan node from
// flows.json, then the real executor - against the in-process Solarman-V5 logger,
// with NO allowlist mutation and NO calibration flag anywhere.
// =============================================================================

// runPlan - run the actual "Steuerung / Schreibplan" node body (auto-control-plan)
// from flows.json, so the gate under test is the SHIPPED inline copy, not the module.
function runPlan(msg, ctxStore = {}, flowStore = {}) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON,
  };
  const script = new vm.Script('(function(){' + byId['auto-control-plan'].func + '\n})()');
  return script.runInContext(vm.createContext(sandbox));
}

// The pilot as the core sees it: remote-capable, 30 kW nameplate, on the test logger.
function pilotSelection(port) {
  return { ...REMOTE_SEL, connection: { ...REMOTE_SEL.connection, port } };
}
// A NORMAL Fahrplan setpoint - source 'schedule', no calibration flag anywhere.
function fahrplanSetpoint(grant, over = {}) {
  return {
    battery_setpoint_kw: -1, source: 'schedule', slot_start: '2026-07-27T19:45:00Z',
    ts: new Date().toISOString(), control_enabled: true, device_certified: grant,
    soc_min_pct: 20, soc_max_pct: 95, grid_charge_allowed: false, ...over,
  };
}

test('FAHRPLAN e2e: a runtime-granted schedule setpoint drives the real inverter (plan node -> executor -> wire)', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const sel = pilotSelection(port);
    const cap = ownerCapability();
    const flowStore = { inverter_config: sel, [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    const ctx = {};

    // 1) THE PLAN NODE - the shipped inline gate, fed the real setpoint shape.
    const sp = fahrplanSetpoint(true);
    const planned = runPlan({ setpoint: sp }, ctx, flowStore);
    assert.ok(planned, 'the plan node emitted a message');
    assert.strictEqual(planned.control.mode, undefined, 'a normal command, not a release');
    assert.strictEqual(planned.control.calibration, false, 'NO calibration bypass involved');
    assert.strictEqual(planned.control.certified, true, 'the runtime grant certified this device');
    assert.strictEqual(planned.control.controlPath, 'remote');
    assert.ok(planned.control.writes.length > 0, 'the Fahrplan is executable - THE fix');
    assert.strictEqual(ctx.was_controlling, true, 'the node recorded that it took control');
    assert.ok(!controlRouting.CERTIFIED_CONTROL_FAMILIES.has('hybrid_3p'),
      'and the fleet allowlist was never touched');

    // 2) THE EXECUTOR - the same message, onto the real wire.
    const out = await runExec(DEYE_EXEC, { control: planned.control, setpoint: sp }, {}, flowStore);
    assert.ok(out, 'the executor published a readback');

    // 3) THE WIRE: the complete remote write plan, in the load-bearing order.
    assert.deepStrictEqual(writes.map((w) => w.reg), [0x044d, 0x0450, 0x0451, 0x0455, 0x044c],
      'watchdog FIRST, battery-side, strategy, setpoint, ENABLE LAST');
    assert.ok(writes.every((w) => w.fc === 0x10), 'FC16 - the only code this firmware answers');
    assert.strictEqual(store[0x044d], 60, 'the dead-man\'s switch is armed');
    assert.strictEqual(store[0x0450], 1, 'BATTERY-side (PV production untouched)');
    assert.strictEqual(store[0x0451], 2, 'Power strategy (the default)');
    assert.strictEqual(store[0x0454], undefined, 'no on-device SoC belt on the default strategy');
    assert.strictEqual(store[0x0455], 33, 'discharge 1 kW of 30 kW rated -> +33');
    assert.strictEqual(store[0x044c], 1, 'remote mode ENABLED - the inverter is following us');
    // NOT ONE installer register touched - the property that makes this path safe.
    const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
    for (const inst of [reg.energyPattern, reg.workMode, reg.solarSell, reg.maxSellPower, reg.touEnable, reg.exportLimit]) {
      assert.strictEqual(store[inst], undefined, 'installer register 0x' + inst.toString(16) + ' untouched');
    }

    // 4) THE READBACK the core folds into :8484 + the heartbeat.
    const rb = out.payload;
    assert.strictEqual(rb.source, 'schedule', 'this is the Fahrplan, not a calibration test');
    assert.strictEqual(rb.control_path, 'remote');
    assert.strictEqual(rb.control_enabled, true);
    assert.strictEqual(rb.certified, true, 'the readback agrees with the core instead of diverging');
    assert.ok(rb.registers.every((r) => r.match), 'every commanded register confirmed');
    assert.strictEqual(rb.wrote, true);
    const bp = rb.registers.find((r) => r.role === 'battery_power');
    assert.strictEqual(bp.commanded_kw, -0.99, 'decoded back to kW in OUR sign convention');
    assert.strictEqual(bp.actual_kw, -0.99);
  } finally {
    server.close();
  }
});

test('FAHRPLAN e2e: the SAME setpoint without a grant writes NOTHING (no static allowlist entry)', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const sel = pilotSelection(port);
    const cap = ownerCapability();
    const flowStore = { inverter_config: sel, [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    const ctx = {};

    const sp = fahrplanSetpoint(false);
    const planned = runPlan({ setpoint: sp }, ctx, flowStore);
    assert.ok(planned, 'the plan node still reports (read-only)');
    assert.strictEqual(planned.control.certified, false);
    // NOTE the vm-realm rule: a plan built inside the function-node sandbox carries
    // that realm's Array prototype, so deepStrictEqual against an outer-realm [] fails.
    // Compare lengths (or JSON round-trip) - see edge-app/AGENTS.md.
    assert.strictEqual(planned.control.writes.length, 0, 'no grant -> no writes');
    assert.strictEqual(planned.control.readbacks.length, 0, 'and no readbacks');
    assert.notStrictEqual(ctx.was_controlling, true, 'it never took control');

    const out = await runExec(DEYE_EXEC, { control: planned.control, setpoint: sp }, {}, flowStore);
    assert.strictEqual(out, null, 'the executor no-ops');
    assert.deepStrictEqual(writes, [], 'NOTHING reached the inverter');
    assert.strictEqual(store[0x044c], undefined, 'remote mode was never enabled');

    // An ABSENT field (an older core that predates the grant) behaves identically.
    const legacy = fahrplanSetpoint(true);
    delete legacy.device_certified;
    const legacyPlan = runPlan({ setpoint: legacy }, {}, flowStore);
    assert.strictEqual(legacyPlan.control.writes.length, 0, 'absent device_certified == no grant');
    assert.deepStrictEqual(writes, [], 'still nothing on the wire');
  } finally {
    server.close();
  }
});

test('FAHRPLAN e2e: control_enabled=false writes NOTHING even with the grant (Not-Aus)', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const sel = pilotSelection(port);
    const cap = ownerCapability();
    const flowStore = { inverter_config: sel, [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };

    // Kill-switch off from boot: was_controlling was never set, so this is NOT a
    // hand-back either - it is simply quiet. Nothing may reach the inverter.
    const sp = fahrplanSetpoint(true, { control_enabled: false });
    const planned = runPlan({ setpoint: sp }, {}, flowStore);
    assert.strictEqual(planned.control.writes.length, 0, 'Not-Aus -> no writes despite the grant');
    assert.match(planned.control.reason, /Not-Aus/, 'and it is named as the Not-Aus');

    const out = await runExec(DEYE_EXEC, { control: planned.control, setpoint: sp }, {}, flowStore);
    assert.strictEqual(out, null);
    assert.deepStrictEqual(writes, [], 'the global kill-switch still stops everything dead');
    assert.strictEqual(store[0x044c], undefined);
  } finally {
    server.close();
  }
});

test('FAHRPLAN e2e: a granted device HANDS CONTROL BACK on a kill-off (1100 <- 0 on the wire)', async () => {
  // The other half of the gate: whatever the Fahrplan may DRIVE must be releasable,
  // or a released device would take control and never give it back.
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const sel = pilotSelection(port);
    const cap = ownerCapability();
    const flowStore = { inverter_config: sel, [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    const ctx = {};

    // 1) take control via the Fahrplan
    const took = runPlan({ setpoint: fahrplanSetpoint(true) }, ctx, flowStore);
    await runExec(DEYE_EXEC, { control: took.control, setpoint: { source: 'schedule' } }, {}, flowStore);
    assert.strictEqual(store[0x044c], 1, 'remote mode on');
    const wroteWhileControlling = writes.length;

    // 2) the core switches control off -> a real, EXECUTABLE hand-back
    const relSp = fahrplanSetpoint(true, { control_enabled: false });
    const released = runPlan({ setpoint: relSp }, ctx, flowStore);
    assert.strictEqual(released.control.mode, 'release', 'the failsafe hand-back fires');
    assert.strictEqual(released.control.writes.length, 1, 'and it is executable thanks to the grant');
    assert.strictEqual(ctx.was_controlling, false);

    const out = await runExec(DEYE_EXEC, { control: released.control, setpoint: relSp }, {}, flowStore);
    assert.ok(out, 'the release published a readback');
    assert.strictEqual(store[0x044c], 0, 'remote mode OFF - the inverter is on its own again');
    assert.strictEqual(writes.length, wroteWhileControlling + 1, 'exactly one release write');
    assert.strictEqual(writes[writes.length - 1].reg, 0x044c);
    assert.ok(out.payload.registers.every((r) => r.match), 'the hand-back is confirmed');
    // Nothing installer-level was captured or restored: the remote path touches none.
    assert.strictEqual(out.payload.snapshot_captured, false);
  } finally {
    server.close();
  }
});

test('FAHRPLAN e2e: a STALE setpoint hands control back too (core went silent)', async () => {
  const { server, port, store } = await startSolarmanServer(remoteCapableStore());
  try {
    const sel = pilotSelection(port);
    const cap = ownerCapability();
    const flowStore = { inverter_config: sel, [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    const ctx = {};

    const took = runPlan({ setpoint: fahrplanSetpoint(true) }, ctx, flowStore);
    await runExec(DEYE_EXEC, { control: took.control, setpoint: { source: 'schedule' } }, {}, flowStore);
    assert.strictEqual(store[0x044c], 1);

    // control_enabled is STILL true, but the core's ts is 30 min old -> it went silent.
    const staleSp = fahrplanSetpoint(true, { ts: new Date(Date.now() - 30 * 60 * 1000).toISOString() });
    const released = runPlan({ setpoint: staleSp }, ctx, flowStore);
    assert.strictEqual(released.control.mode, 'release', 'a silent core is a hand-back, not a latch');
    assert.strictEqual(released.control.controlEnabled, true, 'stale != switched off');
    await runExec(DEYE_EXEC, { control: released.control, setpoint: staleSp }, {}, flowStore);
    assert.strictEqual(store[0x044c], 0, 'remote mode released');
  } finally {
    server.close();
  }
});

// =============================================================================
// The 2026-07-28 live Pilsting regression, end to end: a RESTART plus degenerate
// probe answers must never flip a certified remote pilot onto the EEPROM ToU
// path - and the path decision is STICKY (no per-tick flap), with bounded
// re-probing until the proven path resumes.
// =============================================================================

test('PILSTING e2e: grant-carried remote path drives the Fahrplan even while the probe answers zeros (restart moment)', async () => {
  // The restart moment: the volatile capability cache is GONE, and the logger
  // answers the probe with the all-zero "inverter did not answer" stub (the RS485
  // side is busy with the reconnect burst). The NEW core carries the proven path
  // on the setpoint (device_certified_path), so the plan node seeds the sticky
  // decision and plans REMOTE from the very first tick - no ToU detour at all.
  const { server, port, store, writes } = await startSolarmanServer({});
  try {
    const sel = pilotSelection(port);
    const flowStore = { inverter_config: sel }; // NO cap, NO sticky - a fresh restart
    const ctx = {};
    const sp = fahrplanSetpoint(true, { device_certified_path: 'remote' });

    const planned = runPlan({ setpoint: sp }, ctx, flowStore);
    assert.ok(planned, 'the plan node emitted a plan');
    assert.strictEqual(planned.control.controlPath, 'remote', 'the PROVEN path is planned, not ToU');
    assert.ok(planned.control.writes.length > 0, 'and it is executable');

    const out = await runExec(DEYE_EXEC, { control: planned.control, setpoint: sp }, {}, flowStore);
    assert.ok(out, 'the executor published a readback');
    assert.strictEqual(out.payload.control_path, 'remote');
    // The probe ran, read zeros, and classified TRANSIENT - which must neither
    // veto the proven path (interlock) nor be cached as a definitive ToU verdict.
    const cap = flowStore['deye_cap:127.0.0.1:' + port];
    assert.ok(cap, 'the probe ran and cached its verdict');
    assert.strictEqual(cap.definitive, false, 'an all-zero stub is transient, never "Firmware ohne Fernsteuerung"');
    // The remote writes LANDED (watchdog first, enable last) and NOT ONE installer
    // EEPROM register was touched - the old behaviour wrote the full ToU set here.
    assert.strictEqual(store[0x044c], 1, 'remote mode enabled');
    const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
    for (const inst of [reg.energyPattern, reg.workMode, reg.solarSell, reg.maxSellPower, reg.touEnable, reg.exportLimit]) {
      assert.strictEqual(store[inst], undefined, 'installer register 0x' + inst.toString(16) + ' untouched');
    }
    assert.ok(writes.every((w) => w.reg >= 0x044c && w.reg <= 0x0461), 'only remote-block registers written');
    // The landed write recorded the proven path DURABLY - the device is now
    // self-standing even if the core stops sending the path field.
    const sticky = flowStore['deye_path:127.0.0.1:' + port];
    assert.ok(sticky && sticky.path === 'remote' && sticky.everRemote === true, 'proven path persisted durably');
  } finally {
    server.close();
  }
});

test('PILSTING e2e: an OLD core (no path field) HOLDS instead of ToU, bounded re-probe, remote resumes', async () => {
  // Same restart, but the setpoint carries only device_certified (an older core).
  // The old behaviour: plan ToU + write the full EEPROM set + fight the inverter.
  // New: the plan is HELD (blocked, loud), the probe retries bounded (60 s), and
  // the first successful probe decides REMOTE - which then drives the Fahrplan.
  const { server, port, store, writes } = await startSolarmanServer({});
  try {
    const sel = pilotSelection(port);
    const flowStore = { inverter_config: sel };
    const ctx = {};
    const sp = fahrplanSetpoint(true); // no device_certified_path

    // Tick 1: the plan is the HOLD - writes:[], blocked, the honest reason.
    const p1 = runPlan({ setpoint: sp }, ctx, flowStore);
    assert.ok(p1, 'a (blocked) plan is still emitted for visibility');
    assert.strictEqual(p1.control.blocked, true);
    assert.strictEqual(p1.control.pathHold, 'unconfirmed');
    assert.strictEqual(p1.control.writes.length, 0, 'NOTHING is written on an unconfirmed path');
    // Executor tick 1: the probe runs (zeros -> transient), nothing on the wire.
    await runExec(DEYE_EXEC, { control: p1.control, setpoint: sp }, {}, flowStore);
    assert.deepStrictEqual(writes, [], 'not one register written while the path is unconfirmed');
    const capKey = 'deye_cap:127.0.0.1:' + port;
    assert.strictEqual(flowStore[capKey].definitive, false, 'transient verdict cached');
    assert.strictEqual(flowStore['deye_path:127.0.0.1:' + port], undefined, 'no path decided from a failure');

    // Executor tick 2 (verdict still fresh): the blocked plan surfaces its reason -
    // the stable "one truth" the card renders - and still writes nothing.
    const p2 = runPlan({ setpoint: sp }, ctx, flowStore);
    const out2 = await runExec(DEYE_EXEC, { control: p2.control, setpoint: sp }, {}, flowStore);
    assert.ok(out2, 'a blocked readback is published (never silent)');
    assert.strictEqual(out2.payload.blocked, true);
    assert.match(out2.payload.reason, /Steuerpfad noch unbestätigt/);
    assert.deepStrictEqual(writes, []);

    // The device becomes reachable; the 60 s retry window elapses.
    Object.assign(store, remoteCapableStore());
    flowStore[capKey] = Object.assign({}, flowStore[capKey], { at: Date.now() - 61 * 1000 });

    // Tick 3: plan still held; the probe now SUCCEEDS -> the sticky decision is
    // REMOTE; the interlock skips this tick (the held plan assumed 'tou').
    const p3 = runPlan({ setpoint: sp }, ctx, flowStore);
    const out3 = await runExec(DEYE_EXEC, { control: p3.control, setpoint: sp }, {}, flowStore);
    assert.strictEqual(out3, null, 'the path-change tick writes nothing (interlock)');
    const sticky = flowStore['deye_path:127.0.0.1:' + port];
    assert.ok(sticky && sticky.path === 'remote' && sticky.everRemote === true, 'remote decided + persisted');
    assert.deepStrictEqual(writes, [], 'still nothing written before the re-plan');

    // Tick 4: the plan node reads the durable decision -> the REMOTE Fahrplan runs.
    const p4 = runPlan({ setpoint: sp }, ctx, flowStore);
    assert.strictEqual(p4.control.controlPath, 'remote', 'recovered to the remote path');
    const out4 = await runExec(DEYE_EXEC, { control: p4.control, setpoint: sp }, {}, flowStore);
    assert.ok(out4 && out4.payload.registers.every((r) => r.match), 'remote writes landed + confirmed');
    assert.strictEqual(store[0x044c], 1, 'remote mode enabled');
    const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
    for (const inst of [reg.energyPattern, reg.workMode, reg.solarSell, reg.maxSellPower, reg.touEnable, reg.exportLimit]) {
      assert.strictEqual(store[inst], undefined, 'the ToU/installer registers were NEVER touched');
    }
  } finally {
    server.close();
  }
});

test('PILSTING e2e: the decided path is STICKY - one contrary definitive verdict never flaps it', async () => {
  // The flap symptom: the card alternated "bestätigt" -> "Steuerung kann nicht
  // ausgeführt werden" -> "VoltPilot steuert die Anlage" every ~10 s tick because
  // the path followed each raw probe result. With the hysteresis (N=3) a single
  // contrary verdict - here a genuine 0x02 exception on the remote block - only
  // counts; the plan keeps the decided remote path and keeps driving.
  const { server, port, store } = await startSolarmanServer(remoteCapableStore());
  try {
    const sel = pilotSelection(port);
    const sticky = { path: 'remote', since: 1, contrary: 0, everRemote: true, verdict: ownerCapability(), verdictAt: 1 };
    const flowStore = { inverter_config: sel, ['deye_path:127.0.0.1:' + port]: sticky };
    const ctx = {};
    const sp = fahrplanSetpoint(true);

    // A REAL contrary verdict arrives (e.g. a firmware update removed the block):
    // the volatile cache now holds a definitive tou verdict. The hysteresis maths
    // (contrary counting, N=3 flip) is unit-tested via deyeUpdateSticky; what
    // matters ON THE WIRE is that the plan node keeps planning the decided remote
    // path while the raw verdict disagrees - no per-tick alternation.
    flowStore['deye_cap:127.0.0.1:' + port] = Object.assign(
      {}, controlRouting.classifyDeyeCapability({ deviceType: 0x0008, remoteBlock: null, error: 'Modbus-Ausnahme 0x02: unzulaessige Datenadresse (illegal data address)', definitive: true }),
      { at: Date.now() },
    );
    const p = runPlan({ setpoint: sp }, ctx, flowStore);
    assert.strictEqual(p.control.controlPath, 'remote', 'the sticky decision beats the raw contrary verdict');
    assert.ok(p.control.writes.length > 0, 'and keeps driving - no per-tick flap');
    const out = await runExec(DEYE_EXEC, { control: p.control, setpoint: sp }, {}, flowStore);
    assert.ok(out && out.payload.registers.every((r) => r.match), 'the remote write landed');
    assert.strictEqual(store[0x044c], 1);
  } finally {
    server.close();
  }
});

// --- the NARROW installer write: ONE register, 0x00E7 ------------------------
//
// „Grid Max Export power" is the inverter's OWN feed-in cap - normally only
// reachable through the installer menu ON SITE. These drive the ACTUAL flow node
// (auto-installer-exec, taken from flows.json) against the same in-process
// Solarman-V5 logger, so the whole wire path is proven: FC3 read -> FC16 write
// -> settle -> FC3 read-back.
const INSTALLER_EXEC = byId['auto-installer-exec'].func;

const INSTALLER_SEL = {
  schema_version: '1.0', brand: 'deye', family: 'hybrid_3p', control_tier: 3,
  communication: 'solarman_v5',
  connection: { ip: '127.0.0.1', serial: '2985159064', mb_slave_id: 1, power_scale: 10 },
};

// A fast settle so the test does not wait the production 2 s.
function installerFlow(port, extra) {
  return Object.assign({
    inverter_config: Object.assign({}, INSTALLER_SEL, {
      connection: Object.assign({}, INSTALLER_SEL.connection, { port }),
    }),
    installer_settle_ms: 10,
  }, extra || {});
}

test('installer write e2e: a dry run READS 0x00E7 and writes nothing at all', async () => {
  // The captain's Herzogau state: the installer cap sits at 33,0 kW.
  const { server, port, store, writes } = await startSolarmanServer({ 0x00e7: 3300 });
  try {
    const flowStore = installerFlow(port);
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-1', mode: 'dry_run', register: '0x00e7', addr: 0x00e7, value: 7000 } },
      {}, flowStore);
    assert.ok(out, 'the dry run must answer');
    assert.strictEqual(out.payload.request_id, 'iw-1');
    assert.strictEqual(out.payload.ok, true);
    assert.strictEqual(out.payload.wrote, false);
    assert.strictEqual(out.payload.before, 3300, 'it reports the Ist-value');
    // null, not 0: „not read\u201c and „read as 0\u201c are different facts (0 is a
    // legitimate value of this register - „may not feed in at all\u201c).
    assert.strictEqual(out.payload.after, null);
    assert.deepStrictEqual(writes, [], 'a dry run touches NOTHING');
    assert.strictEqual(store[0x00e7], 3300);
    // The one-socket lock is handed back in every exit.
    assert.ok(!flowStore['sv5_busy:127.0.0.1:' + port]);
    assert.ok(!flowStore['sv5_write_want:127.0.0.1:' + port]);
  } finally {
    server.close();
  }
});

test('installer write e2e: the confirmed write lands ONCE as FC16 and reads back 70,0 kW', async () => {
  const { server, port, store, writes } = await startSolarmanServer({ 0x00e7: 3300 });
  try {
    const flowStore = installerFlow(port);
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-2', mode: 'apply', register: '0x00e7', addr: 0x00e7, value: 7000 } },
      {}, flowStore);
    assert.strictEqual(out.payload.ok, true);
    assert.strictEqual(out.payload.wrote, true);
    assert.strictEqual(out.payload.before, 3300);
    assert.strictEqual(out.payload.after, 7000, '70,0 kW at scale 10');
    // EXACTLY ONE write, to EXACTLY that register, over FC16 (the Deye default).
    assert.deepStrictEqual(writes, [{ reg: 0x00e7, value: 7000, fc: 0x10 }]);
    assert.strictEqual(store[0x00e7], 7000);
    assert.ok(!flowStore['sv5_busy:127.0.0.1:' + port], 'the socket is handed back');
  } finally {
    server.close();
  }
});

test('installer write e2e: a device that swallows the write is an honest MISMATCH, never a claimed success', async () => {
  // dropWrites models a logger that acknowledges but never applies - the
  // documented Deye/Fronius failure shape.
  const { server, port, writes } = await startSolarmanServer({ 0x00e7: 3300 }, { dropWrites: true });
  try {
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-3', mode: 'apply', register: '0x00e7', addr: 0x00e7, value: 7000 } },
      {}, installerFlow(port));
    assert.strictEqual(out.payload.ok, true, 'the exchange itself succeeded');
    assert.strictEqual(out.payload.wrote, true);
    assert.strictEqual(out.payload.after, 3300, 'the register did not move - the CORE turns this into a mismatch');
    assert.deepStrictEqual(writes, [], 'and the device really never took it');
  } finally {
    server.close();
  }
});

test('installer write e2e: the node refuses a foreign register / an over-ceiling value WITHOUT touching the device', async () => {
  const { server, port, writes } = await startSolarmanServer({ 0x00e7: 3300, 0x0028: 100 });
  try {
    for (const req of [
      { request_id: 'iw-4', mode: 'apply', addr: 0x0028, value: 50 },      // another register
      { request_id: 'iw-5', mode: 'apply', addr: 0x00e7, value: 7001 },    // above the ceiling
      { request_id: 'iw-6', mode: 'apply', addr: 0x00e7, value: 0 },       // "0 is not a raise"
    ]) {
      const out = await runExec(INSTALLER_EXEC, { payload: req }, {}, installerFlow(port));
      assert.strictEqual(out.payload.ok, false, JSON.stringify(req));
      assert.strictEqual(out.payload.wrote, false);
      assert.strictEqual(out.payload.error_code, 'invalid_request');
      assert.ok(out.payload.message && out.payload.message.length > 10, 'a refusal names its reason');
    }
    // A family whose 0x00E7 is OUR OWN discharge lever is refused too.
    const oneP = installerFlow(port);
    oneP.inverter_config = Object.assign({}, oneP.inverter_config, { family: 'hybrid_1p' });
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-7', mode: 'apply', addr: 0x00e7, value: 7000 } }, {}, oneP);
    assert.strictEqual(out.payload.ok, false);
    assert.deepStrictEqual(writes, [], 'not a single byte reached the inverter');
  } finally {
    server.close();
  }
});

test('installer write e2e: it YIELDS to an in-flight read instead of opening a second socket', async () => {
  const { server, port, writes } = await startSolarmanServer({ 0x00e7: 3300 });
  try {
    const flowStore = installerFlow(port);
    // Someone else holds the ONE socket and never lets go within our budget.
    flowStore['sv5_busy:127.0.0.1:' + port] = Date.now();
    flowStore.sv5_acquire_ms = 250;
    flowStore.sv5_acquire_poll_ms = 50;
    const warns = [];
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-8', mode: 'apply', register: '0x00e7', addr: 0x00e7, value: 7000 } },
      {}, flowStore, warns);
    assert.strictEqual(out.payload.ok, false);
    assert.strictEqual(out.payload.error_code, 'busy');
    assert.strictEqual(out.payload.wrote, false, 'a deferred attempt must never claim a write');
    assert.deepStrictEqual(writes, [], 'and nothing was written');
    assert.ok(warns.some((w) => /belegt/i.test(w)), 'a starved write is audible in the log');
    // It released its own intent so the read poll resumes.
    assert.ok(!flowStore['sv5_write_want:127.0.0.1:' + port]);
  } finally {
    server.close();
  }
});

test('installer write e2e: an unreachable device fails honestly and never claims a write', async () => {
  const { server, port } = await startSolarmanServer({ 0x00e7: 3300 });
  server.close();
  const out = await runExec(INSTALLER_EXEC,
    { payload: { request_id: 'iw-9', mode: 'apply', register: '0x00e7', addr: 0x00e7, value: 7000 } },
    {}, installerFlow(port));
  assert.strictEqual(out.payload.ok, false);
  assert.strictEqual(out.payload.wrote, false, 'the write frame never left');
  assert.strictEqual(out.payload.error_code, 'unreachable');
});

test('installer write e2e: a stale expected_before aborts BEFORE the write frame leaves', async () => {
  // The register moved to 5000 since the trigger read it; the order still
  // expects 3300.
  const { server, port, store, writes } = await startSolarmanServer({ 0x00e7: 5000 });
  try {
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-10', mode: 'apply', register: '0x00e7', addr: 0x00e7, value: 7000, expected_before: 3300 } },
      {}, installerFlow(port));
    assert.strictEqual(out.payload.ok, false);
    assert.strictEqual(out.payload.error_code, 'precondition');
    assert.strictEqual(out.payload.wrote, false, 'the write frame never left');
    assert.strictEqual(out.payload.before, 5000, 'the refusal reports what it FOUND');
    assert.ok(/5000/.test(out.payload.message) && /3300/.test(out.payload.message),
      'the message names both the reality and the expectation');
    assert.deepStrictEqual(writes, []);
    assert.strictEqual(store[0x00e7], 5000, 'the device is untouched');

    // The MATCHING expectation goes through - the guard blocks staleness, not writes.
    const ok = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-11', mode: 'apply', register: '0x00e7', addr: 0x00e7, value: 7000, expected_before: 5000 } },
      {}, installerFlow(port));
    assert.strictEqual(ok.payload.ok, true);
    assert.strictEqual(ok.payload.after, 7000);
    assert.deepStrictEqual(writes, [{ reg: 0x00e7, value: 7000, fc: 0x10 }]);
  } finally {
    server.close();
  }
});
