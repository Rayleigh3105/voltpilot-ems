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
// Die Zeitfenster der Bus-Warteschlange - dieselbe Quelle, die die Knoten tragen.
const bus = require('./bus-arbitration');
const sharedBus = require('./measurements/shared-bus-arbiter');

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
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
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
//
// ⚠ EIN GESCHLOSSENER SOCKET IST NICHT SOFORT WEG - DER STUB DARF DEN
// UEBERGANG NICHT ALS ZWEITEN KLIENTEN LESEN (Gate-Fehlschlag edge-2026.08.22,
// zwei Tests, nur auf Linux). `state.live` haengt am 'close'-Ereignis des
// SERVER-Sockets, und das ist ein I/O-Ereignis: es wird erst in der naechsten
// Poll-Phase zugestellt. Genau dazwischen verbindet sich der naechste Halter -
// die UEBERGABE der Bus-Warteschlange ist ja absichtlich unmittelbar (siehe
// bus-arbitration.js: „wer freigibt, UEBERGIBT"). Auf macOS gewann die
// close-Zustellung das Rennen, auf Linux gewann das accept: der Stub verwarf
// die legitime Folgeverbindung, der Knoten wartete sein volles Socket-Budget ab
// und meldete `unreachable`/`Zeitueberschreitung`. Beide Ausgaenge sind erlaubt
// - der Test war also auf JEDER Plattform ein Rennen, Linux verlor es nur
// zuverlaessig.
//
// Der Stub urteilt deshalb ueber die ECHTE Ueberlappung statt ueber die
// Zustellreihenfolge zweier Ereignisse:
//   (1) Haelt der Halter eine OFFENE Anfrage (Bytes empfangen, Antwort noch
//       nicht geschrieben), ist eine zweite Verbindung unzweideutig ein zweiter
//       Klient -> sofort melden und verwerfen. Das ist der Kollisionsfall, fuer
//       den es diesen Server ueberhaupt gibt (Lese-Poll mitten im Block, waehrend
//       der Schreiber verbindet), und er bleibt scharf.
//   (2) Ist der Halter still, KANN sein Schliessen nur noch unterwegs sein: die
//       neue Verbindung wird geparkt (ein net.Socket ist ohne 'data'-Hoerer
//       pausiert, es geht kein Byte verloren) und bedient, sobald der Halter
//       wirklich zu ist. Bleibt er ueber `concurrentGraceMs` hinaus offen, war es
//       doch ein zweiter Klient -> melden und verwerfen.
// Das ist HOEHERE Treue, keine Aufweichung: ein echter LSW3-Stick gibt seinen
// Platz frei, sobald das FIN da ist - er wartet nicht auf eine JS-Ereignisrunde.
function startSingleClientSolarmanServer(initial = {}, opts = {}) {
  const store = Object.assign({}, initial);
  const writes = [];
  const state = { live: 0, totalConns: 0, sawConcurrent: false };
  const latencyMs = opts.latencyMs || 0;
  // Grosszuegig gegenueber der Zustellrunde (Mikrosekunden), winzig gegenueber
  // jeder echten Ueberlappung in diesen Tests (der Halter bleibt dort offen).
  const graceMs = opts.concurrentGraceMs === undefined ? 500 : opts.concurrentGraceMs;
  return new Promise((resolve) => {
    let holder = null; // { sock, pending } - wer den Logger gerade haelt
    const serve = (sock) => {
      const me = { sock, pending: 0 };
      holder = me;
      state.live += 1;
      let acc = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('close', () => { state.live -= 1; if (holder === me) holder = null; });
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
          me.pending += 1;
          if (latencyMs > 0) setTimeout(() => { me.pending -= 1; try { sock.write(resp); } catch (e) { /* closed */ } }, latencyMs);
          else { me.pending -= 1; sock.write(resp); }
          try { need = SV5.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
        }
      });
    };
    const refuse = (sock) => { state.sawConcurrent = true; sock.destroy(); };
    const server = net.createServer((sock) => {
      state.totalConns += 1;
      if (!holder) { serve(sock); return; }
      // (1) Der Halter ist mitten in einer Anfrage - ein zweiter Klient, sofort.
      if (holder.pending > 0) { refuse(sock); return; }
      // (2) Der Halter ist still: sein Schliessen kann noch unterwegs sein.
      const waiting = holder;
      const timer = setTimeout(() => { waiting.sock.removeListener('close', onGone); refuse(sock); }, graceMs);
      // Warten ZWEI auf denselben Halter, ist der zweite ein echter zweiter
      // Klient - er hat sich neben einen Wartenden gestellt, nicht hinter einen
      // Schliessenden. Sonst haetten kurz zwei Halter `state.live` auf 2.
      const onGone = () => { clearTimeout(timer); if (holder) refuse(sock); else serve(sock); };
      waiting.sock.once('close', onGone);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, store, writes, state }));
  });
}

// v5ReadRequest - ein V5-gerahmter FC3-Leseauftrag von Hand. Die zwei
// Ein-Klient-Tests unten muessen wirklich eine Anfrage OFFEN halten; alle
// anderen Tests fahren den Knoten, der seinen Rahmen selbst baut.
function v5ReadRequest(serial, seq, slave, start, count) {
  const b = Buffer.alloc(6);
  b[0] = slave; b[1] = 0x03; b.writeUInt16BE(start, 2); b.writeUInt16BE(count, 4);
  const c = SV5.modbusCrc16(b);
  const mb = Buffer.concat([b, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
  const h = Buffer.alloc(11);
  h[0] = 0xa5; h.writeUInt16LE(15 + mb.length, 1); h.writeUInt16LE(0x4510, 3);
  h.writeUInt16LE(seq & 0xffff, 5); h.writeUInt32LE(SV5.normLoggerSerial(serial), 7);
  const pre = Buffer.alloc(15); pre[0] = 0x02;
  const fr = Buffer.concat([h, pre, mb, Buffer.from([0x00, 0x15])]);
  let sum = 0; for (let i = 1; i < fr.length - 2; i++) sum = (sum + fr[i]) & 0xff;
  fr[fr.length - 2] = sum & 0xff;
  return fr;
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
  const s1 = net.connect(port, '127.0.0.1');
  try {
    await new Promise((res, rej) => { s1.once('connect', res); s1.once('error', rej); });
    const s2 = net.connect(port, '127.0.0.1');
    // the second concurrent connect is refused/closed by the single-client server
    await new Promise((res) => { s2.once('close', res); s2.once('error', () => {}); });
    assert.strictEqual(state.sawConcurrent, true, 'the server flagged the concurrent connection');
  } finally {
    // s. u.: ein offener Klient laesst server.close() warten - eine gerissene
    // Zusicherung muss ROT werden, nicht haengen.
    s1.destroy();
    server.close();
  }
});

test('single-client server: ein Halter MITTEN in einer Anfrage macht den zweiten Klienten SOFORT sichtbar', async () => {
  // Die scharfe Kante des Modells: waehrend eine Anfrage offen ist (Bytes da,
  // Antwort noch nicht geschrieben), ist eine zweite Verbindung unzweideutig ein
  // zweiter Klient - genau die Kollision, fuer die dieser Server gebaut wurde.
  // Sie wird OHNE Karenz gemeldet, sonst koennte ein kurzer Halter eine echte
  // Ueberlappung ueberdecken.
  const { server, port, state } = await startSingleClientSolarmanServer(
    { 0x024c: 7 }, { latencyMs: 400, concurrentGraceMs: 5000 });
  // ⚠ Die Sockets im finally: eine gerissene Zusicherung darf den Lauf ROT
  // machen, nie AUFHAENGEN - ein offener Klient laesst server.close() warten
  // und das ganze Gate liefe in seine 90-Minuten-Schranke.
  const open = [];
  try {
    const s1 = net.connect(port, '127.0.0.1'); open.push(s1);
    await new Promise((res, rej) => { s1.once('connect', res); s1.once('error', rej); });
    s1.write(v5ReadRequest('2985159064', 1, 1, 0x024c, 1));
    await waitFor(() => state.totalConns === 1 && state.live === 1);
    await new Promise((r) => setTimeout(r, 30)); // Anfrage angekommen, Antwort haengt noch
    const t0 = Date.now();
    const s2 = net.connect(port, '127.0.0.1'); open.push(s2);
    await new Promise((res) => { s2.once('close', res); s2.once('error', () => {}); });
    assert.strictEqual(state.sawConcurrent, true, 'die echte Ueberlappung ist gemeldet');
    assert.ok(Date.now() - t0 < 200, 'und zwar sofort, nicht erst nach der Karenz');
  } finally {
    open.forEach((s) => s.destroy());
    server.close();
  }
});

test('single-client server: ein Nachfolger, dessen Vorgaenger gerade SCHLIESST, ist kein zweiter Klient', async () => {
  // Der Gate-Fehlschlag edge-2026.08.22 (nur Linux): `state.live` haengt am
  // 'close' des Server-Sockets, einem I/O-Ereignis. Die UEBERGABE der
  // Bus-Warteschlange verbindet den naechsten Halter absichtlich unmittelbar -
  // also im selben Durchlauf, bevor dieses 'close' zugestellt ist. Das ist
  // KEINE Ueberlappung; der Server bedient den Nachfolger und meldet nichts.
  const { server, port, state } = await startSingleClientSolarmanServer({ 0x024c: 7 });
  const open = []; // s. o.: rot, nie haengend
  try {
    const s1 = net.connect(port, '127.0.0.1'); open.push(s1);
    await new Promise((res, rej) => { s1.once('connect', res); s1.once('error', rej); });
    s1.write(v5ReadRequest('2985159064', 1, 1, 0x024c, 1));
    await new Promise((r) => s1.once('data', r));
    s1.destroy();                       // ab hier ist das Schliessen UNTERWEGS
    const s2 = net.connect(port, '127.0.0.1'); open.push(s2);
    await new Promise((res, rej) => { s2.once('connect', res); s2.once('error', rej); });
    s2.write(v5ReadRequest('2985159064', 2, 1, 0x024c, 1));
    const got = await Promise.race([
      new Promise((r) => s2.once('data', () => r('data'))),
      new Promise((r) => setTimeout(() => r('timeout'), 4000)),
    ]);
    assert.strictEqual(got, 'data', 'der Nachfolger wird bedient, nicht verworfen');
    assert.strictEqual(state.sawConcurrent, false, 'und er gilt nie als zweiter Klient');
  } finally {
    open.forEach((s) => s.destroy());
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

test('installer write e2e: since Stufe 2 a FREE register lands, and only a non-word is refused', async () => {
  const { server, port, writes } = await startSolarmanServer({ 0x00e7: 3300, 0x1234: 12 });
  try {
    // ⚠ THE HANDOVER ITSELF: another register is no longer refused - the address
    // allowlist was replaced by LANE rules (Konzept §2.8 Stufe 2), and what a
    // customer may write is decided by the CLOUD's reach plus the core's
    // self-conflict lock, not by a static table in this node.
    const ok = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-4', mode: 'apply', addr: 0x1234, value: 65535 } },
      {}, installerFlow(port));
    assert.strictEqual(ok.payload.ok, true, JSON.stringify(ok.payload));
    assert.strictEqual(ok.payload.wrote, true);
    assert.strictEqual(ok.payload.after, 65535);
    assert.deepStrictEqual(writes, [{ reg: 0x1234, value: 65535, fc: 16 }],
      'exactly one FC16 write, at the requested address');

    // What still refuses is what THIS node can judge without the device: a value
    // or an address that is not a register word at all.
    writes.length = 0;
    for (const req of [
      { request_id: 'iw-5', mode: 'apply', addr: 0x00e7, value: 65536 },
      { request_id: 'iw-6', mode: 'apply', addr: 0x10000, value: 1 },
    ]) {
      const out = await runExec(INSTALLER_EXEC, { payload: req }, {}, installerFlow(port));
      assert.strictEqual(out.payload.ok, false, JSON.stringify(req));
      assert.strictEqual(out.payload.wrote, false);
      assert.strictEqual(out.payload.error_code, 'invalid_request');
      assert.ok(out.payload.message && out.payload.message.length > 10, 'a refusal names its reason');
    }
    // A device read over ANOTHER transport has no path through this node at all.
    const other = installerFlow(port);
    other.inverter_config = Object.assign({}, other.inverter_config, { communication: 'modbus_tcp' });
    const out = await runExec(INSTALLER_EXEC,
      { payload: { request_id: 'iw-7', mode: 'apply', addr: 0x00e7, value: 7000 } }, {}, other);
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

// --- DIE WARTESCHLANGE: eine Einmal-Lesung unter aktiver Steuerlast ----------
//
// Der Produktionsvorfall (Box edge-45gz7da, Anlage Pilsting/Herzogau, 20.08.2026
// 20:08-20:10Z): das Portal fragte den Ist-Wert von 0x00E7 ab, die Box nahm den
// Auftrag an ("Auftrag angenommen (lesen, lane primary, register 231)") - und
// 30 s spaeter meldete sie `timeout`. Die ganze Kette davor lief; es scheiterte
// AUSSCHLIESSLICH die Slot-Vergabe am einen Logger-Socket, waehrend Steuerung
// (~10 s) und Lese-Poll (5 s) ihn belegten. Am Vormittag ging derselbe Weg ueber
// dieselbe Taste sofort - der UNTERSCHIED war nicht der Ausloeser, sondern die
// LAST: abends steuert die Anlage in die Abendspitze.
//
// Diese vier Tests fahren genau diese Konstellation gegen einen echten
// Ein-Klient-Logger auf einem GETEILTEN Flow-Kontext.

// A one-shot request/msg, and the flow store the three nodes share.
function oneShotMsg(id, port, extra) {
  return { payload: Object.assign({ request_id: id, mode: 'dry_run', register: '0x00e7', addr: 0x00e7 }, extra || {}) };
}

test('EINMAL-LESUNG UNTER STEUERLAST: sie kommt durch, waehrend Poll und Steuerung takten', async () => {
  const { server, port, state } = await startSingleClientSolarmanServer({ 0x00e7: 3300 }, { latencyMs: 25 });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        // ONE flow context for all three nodes - exactly the production tab.
        const sharedFlow = installerFlow(port);
        sharedFlow.sv5_acquire_poll_ms = 10; // the test's own cadence, not a product change

        const readCtx = {};
        const ctrlCtx = {};
        let ticking = true;
        // The plant is BUSY: the read poll (5 s) and the control executor (~10 s)
        // keep taking the socket, compressed here into a tight loop so the
        // one-shot really has to queue for it.
        // ⚠ OHNE PAUSE, und das ist der Punkt: Lese-Poll und Steuer-Executor sind
        // INJECT-getrieben und pruefen die Sperre EINMAL synchron, waehrend ein
        // Wartender nur alle paar Millisekunden nachsieht. Genau dieses Rennen
        // verliert ein Auftrag ohne Warteschlange - deshalb greift der naechste
        // Takt hier sofort zu, statt zu schlafen.
        const ticker = (async () => {
          let n = 0;
          while (ticking) {
            n += 1;
            await runExec(READ_POLL, deyeReadMsg(port), readCtx, sharedFlow);
            if (n % 2 === 0) {
              await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, ctrlCtx, sharedFlow);
            }
          }
        })();

        const started = Date.now();
        const out = await runExec(INSTALLER_EXEC, oneShotMsg('rw-load-1', port), {}, sharedFlow);
        const took = Date.now() - started;
        ticking = false;
        await ticker;

        assert.strictEqual(out.payload.ok, true,
          'die Einmal-Lesung muss durchkommen, nicht `busy`/`timeout`: ' + JSON.stringify(out.payload));
        assert.strictEqual(out.payload.before, 3300, 'und sie liefert den ECHTEN Ist-Wert');
        assert.strictEqual(out.payload.wrote, false, 'eine Vorschau schreibt nichts');
        // ⚠ Die eigentliche Zusage: sie wartet BEGRENZT, nicht bis der Kern aufgibt.
        assert.ok(took < 15000,
          'die Lesung kam nach ' + took + ' ms durch - unter dem Warte-Budget des Knotens');
        assert.strictEqual(state.sawConcurrent, false,
          'und NIE eine zweite Verbindung zum Ein-Klient-Logger');
        // Aufgeraeumt: weder Reservierung noch Uebergabe bleiben liegen.
        assert.ok(!sharedFlow['sv5_oneshot:127.0.0.1:' + port], 'die Reservierung ist zurueckgegeben');
        assert.ok(!sharedFlow['sv5_busy:127.0.0.1:' + port], 'der Socket ist zurueckgegeben');
      },
    );
  } finally {
    server.close();
  }
});

test('BEFUND 1: eine Steuerrunde loescht die Reservierung des Einmal-Auftrags NICHT mehr', async () => {
  // Vorher teilten sich Steuerung und Einmal-Auftrag die Absichts-Fahne
  // sv5_write_want; der Steuer-Executor setzt sie am Ende JEDER Runde (und beim
  // Verschieben) auf 0 - und loeschte damit die Absicht eines noch WARTENDEN
  // Einmal-Auftrags. Der Lese-Poll, der genau auf diese Fahne zurueckritt, nahm
  // sich den Socket danach wieder.
  const { server, port } = await startSingleClientSolarmanServer({ 0x00e7: 3300 });
  try {
    await certifiedDeyePlan(
      { battery_setpoint_kw: -20, source: 'schedule', control_enabled: true, soc_min_pct: 10 },
      async (plan) => {
        plan.connection.port = port;
        const target = '127.0.0.1:' + port;
        const sharedFlow = installerFlow(port);
        // Ein Einmal-Auftrag wartet (die Reservierung, die der Knoten legt).
        sharedFlow['sv5_oneshot:' + target] = { id: 'rw-keep-1', at: Date.now() };

        // Eine volle Steuerrunde laeuft durch.
        const ctrlOut = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'schedule' } }, {}, sharedFlow);
        assert.ok(ctrlOut, 'die Steuerrunde ist gelaufen (sie wird nie abgebrochen)');

        const res = sharedFlow['sv5_oneshot:' + target];
        assert.ok(res && res.id === 'rw-keep-1', 'die Reservierung steht noch: ' + JSON.stringify(res));
        // Und sie hat die UEBERGABE hinterlassen - das ist die „eingereihte
        // Ausfuehrung direkt nach Abschluss der laufenden Steuerrunde".
        const grant = sharedFlow['sv5_grant:' + target];
        assert.ok(grant && grant.id === 'rw-keep-1', 'die Steuerrunde uebergibt den Socket: ' + JSON.stringify(grant));

        // Der Lese-Poll faellt der Uebergabe nicht in den Ruecken.
        const readOut = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
        assert.strictEqual(readOut, null, 'der Lese-Poll tritt fuer die Uebergabe zurueck');
      },
    );
  } finally {
    server.close();
  }
});

test('BEFUND 2: beim Freigeben wird UEBERGEBEN, statt den Socket ins Rennen zu entlassen', async () => {
  const { server, port, state } = await startSingleClientSolarmanServer({ 0x00e7: 3300 }, { latencyMs: 20 });
  try {
    const target = '127.0.0.1:' + port;
    const sharedFlow = installerFlow(port);
    sharedFlow.sv5_acquire_poll_ms = 10;

    // Der Lese-Poll haelt den Socket; der Einmal-Auftrag reserviert und wartet.
    const readDone = runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
    await waitFor(() => !!sharedFlow['sv5_busy:' + target]);
    const oneDone = runExec(INSTALLER_EXEC, oneShotMsg('rw-hand-1', port), {}, sharedFlow);
    await waitFor(() => !!sharedFlow['sv5_oneshot:' + target]);

    const out = await oneDone;
    await readDone;
    assert.strictEqual(out.payload.ok, true, JSON.stringify(out.payload));
    assert.strictEqual(out.payload.before, 3300, 'der Einmal-Auftrag hat wirklich gelesen');
    assert.strictEqual(state.sawConcurrent, false, 'nie zwei Klienten am Ein-Klient-Logger');
    assert.ok(!sharedFlow['sv5_grant:' + target], 'die Uebergabe ist eingeloest und geraeumt');
  } finally {
    server.close();
  }
});

test('eine TOTE Reservierung kann den Bus nicht festhalten', async () => {
  // Die Kehrseite der Zusage: ein abgestuerzter Einmal-Auftrag darf Telemetrie
  // und Steuerung nicht aushungern. Reservierung und Uebergabe verfallen.
  const { server, port } = await startSingleClientSolarmanServer({ 0x00e7: 3300 });
  try {
    const target = '127.0.0.1:' + port;
    const sharedFlow = installerFlow(port);

    // (a) eine verfallene Reservierung haelt den Lese-Poll nicht auf
    sharedFlow['sv5_oneshot:' + target] = { id: 'dead', at: Date.now() - bus.ONESHOT_RESERVE_TTL_MS - 1 };
    const read1 = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
    assert.ok(read1, 'eine verfallene Reservierung wird ignoriert');

    // (b) eine LEBENDE haelt ihn auf - aber nur GEBUNDEN, dann erzwingt er und sagt es
    const warns = [];
    for (let i = 0; i < bus.ONESHOT_READ_YIELD_TICKS; i += 1) {
      sharedFlow['sv5_oneshot:' + target] = { id: 'stuck', at: Date.now() };
      const r = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow, warns);
      assert.strictEqual(r, null, 'Takt ' + (i + 1) + ': der Lese-Poll tritt zurueck');
    }
    sharedFlow['sv5_oneshot:' + target] = { id: 'stuck', at: Date.now() };
    const forced = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow, warns);
    assert.ok(forced, 'nach der Schranke liest er wieder - die Telemetrie verhungert nie');
    assert.ok(warns.some((w) => /erzwungen/.test(w)), 'und er sagt es: ' + JSON.stringify(warns));

    // (c) eine verfallene UEBERGABE blockiert die Steuerung nicht
    sharedFlow['sv5_oneshot:' + target] = 0;
    sharedFlow['sv5_grant:' + target] = { id: 'ghost', at: Date.now() - bus.ONESHOT_GRANT_TTL_MS - 1 };
    const read2 = await runExec(READ_POLL, deyeReadMsg(port), {}, sharedFlow);
    assert.ok(read2, 'eine verfallene Uebergabe wird ignoriert');
  } finally {
    server.close();
  }
});


// --- NATIVE SELF-REGULATION on the Deye REMOTE tier (the released pilot) -----
//
// The execution path of "Wechselrichter-Automatik" on a Deye, driven END TO END
// from flows.json: the AUTO plan node ("Steuerung / Schreibplan") and the Deye
// Solarman-V5 executor, against the same in-process logger the tests above use.
//
// The one question it answers is the one the whole feature stands or falls on -
// and on this tier it is asked of a device that must first PROVE its own
// Time-of-Use configuration can cover the house at all:
//
//   Decken-Slot -> Vorbedingung gelesen -> EIN Schreibvorgang (1100 <- 0)
//   -> nur noch Lesen -> Beleg -> Ruecknahme
//
// SAFETY: nothing here mutates the certified-family allowlist. The pilot is
// released through the PRODUCTION catalog entry in unplanned-load-native.js
// (deye / sun-30k-sg01hp3 / the probed PR-978 layout), which is exactly what the
// plan node consults - so what these tests exercise is the shipped release, not
// an un-gating.

const DEYE_NATIVE_PLAN = byId['auto-control-plan'].func;

// The owner's inverter as the core publishes it on edge/inverter/config: the
// CATALOG MODEL ID (never the label), the family, the nameplate.
function nativeSel(port) {
  return {
    schema_version: '1.0', brand: 'deye', model: 'sun-30k-sg01hp3', family: 'hybrid_3p',
    communication: 'solarman_v5', control_tier: 3, rated_kw: 30,
    connection: { ip: '127.0.0.1', port, serial: '2985159064', mb_slave_id: 1, power_scale: 10 },
  };
}

// The live probe of the owner's SUN-30K-SG01HP3-EU (2026-07-27): 1100=0,
// 1101=0xFFFF, 1104=0, 1105=2, 1121=0 -> the PR-978 layout. Everything else in
// the block reads 0, which is what a real answer looks like.
const REG_REMOTE = { mode: 0x044c, watchdog: 0x044d, powerControlMode: 0x0450, batteryStrategy: 0x0451, constantPower: 0x0455, status: 0x0461 };
const REG_TOU = { touEnable: 0x0092, progSoc1: 0x00a6, progCharge1: 0x00ac,
  energyPattern: 0x008d, workMode: 0x008e, solarSell: 0x0091, progTime1: 0x0094, progPower1: 0x009a };

function nativeStore(overrides = {}, { workMode = 2, pattern = 1, solarSell = 1, prog = {} } = {}) {
  const p = { power: 3000, soc: 5, charge: 0, ...prog };
  const out = {
    0x0000: 0x0008, // HV identity -> power scale 10 (the N1 auto-detect)
    [REG_REMOTE.mode]: 0,
    [REG_REMOTE.watchdog]: 0xffff,
    [REG_REMOTE.powerControlMode]: 0,
    [REG_REMOTE.batteryStrategy]: 2,
    [REG_REMOTE.status]: 0,
    // The inverter's OWN configuration (vp-wr-deye-tou-schreibbudget: E-down reads
    // the whole block): Zero Export To CT with Solar Sell, Load First, Time-of-Use
    // armed all week, EVERY program discharging down to 5 % (past a 10 % reserve
    // floor) and never charging from the grid - so the wall-clock time of the
    // test cannot pick a different program.
    [REG_TOU.energyPattern]: pattern,
    [REG_TOU.workMode]: workMode,
    [REG_TOU.solarSell]: solarSell,
    [REG_TOU.touEnable]: 0x00ff,
  };
  const times = [0, 500, 900, 1300, 1700, 2100];
  for (let i = 0; i < 6; i++) {
    out[REG_TOU.progTime1 + i] = times[i];
    out[REG_TOU.progPower1 + i] = p.power;
    out[REG_TOU.progSoc1 + i] = p.soc;
    out[REG_TOU.progCharge1 + i] = p.charge;
  }
  return { ...out, ...overrides };
}

// The core's published command. `battery_mode` is the additive native field;
// device_certified_path seeds the plan node's sticky remote decision exactly as
// a First-Light-granted pilot does after a restart.
function nativeSetpoint(mode, extra = {}) {
  return {
    battery_setpoint_kw: -7.087, source: 'schedule', ts: new Date().toISOString(),
    control_enabled: true, device_certified: true, device_certified_path: 'remote',
    grid_charge_allowed: true, soc_min_pct: 5, soc_max_pct: 95,
    effective_floor_soc_pct: 10,
    battery_mode: mode,
    battery_native_duty: mode === 'native' ? 'cover_load' : undefined,
    ...extra,
  };
}

// One rig = one plant: ONE shared flow store (the capability probe, the sticky
// path decision and the native config cache all live there, exactly as in
// Node-RED) plus one context per node.
function makeNativeRig(port, sel = nativeSel(port), planFunc = DEYE_NATIVE_PLAN) {
  const planCtx = {};
  const execCtx = {};
  const flowStore = { inverter_config: sel };
  const warns = [];
  // Kept apart on purpose: the PLAN node's status is the one that carries a
  // standing native refusal, the executor's is the write/readback verdict.
  const planStatuses = [];
  const execStatuses = [];
  const sandbox = (msg, ctxStore, statuses) => ({
    msg,
    node: {
      status(st) { statuses.push(st && st.text); }, error() {},
      warn(l) { warns.push(String(l)); }, log() {}, send() {},
    },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  });
  const tick = async (setpoint) => {
    const msg = { setpoint };
    const planBox = sandbox(msg, planCtx, planStatuses);
    vm.createContext(planBox);
    const planned = vm.runInContext('(function () {\n' + planFunc + '\n})()', planBox);
    if (!planned) return { plan: null, out: null };
    const execBox = sandbox(msg, execCtx, execStatuses);
    vm.createContext(execBox);
    const ret = vm.runInContext('(function () {\n' + DEYE_EXEC + '\n})()', execBox);
    const out = ret && typeof ret.then === 'function' ? await ret : ret;
    return { plan: msg.control, out };
  };
  return { tick, warns, planStatuses, execStatuses, flowStore };
}

test('a covering slot goes native on the Deye pilot: ONE write (1100 <- 0), then only reads', async () => {
  const { server, port, writes, store } = await startSolarmanServer(nativeStore());
  try {
    const rig = makeNativeRig(port);

    // 1. The plant arrives on the ordinary REMOTE setpoint path - the proven
    //    10-second follower every Deye pilot runs today.
    const first = await rig.tick(nativeSetpoint('setpoint'));
    assert.strictEqual(first.plan.controlPath, 'remote', 'the pilot plans on the remote path');
    assert.strictEqual(first.out.payload.mode, 'normal');
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'remote mode is armed');
    assert.ok(writes.some((w) => w.reg === REG_REMOTE.constantPower), 'the setpoint is written');

    // 2. The core asks for the native mode. The FIRST such tick has not read the
    //    inverter's own Time-of-Use configuration yet, so the last gate refuses -
    //    honestly, by name - and the follower carries the slot. That tick is what
    //    fills the cache: the executor reads the three registers.
    const cfgKey = 'deye_native_cfg:127.0.0.1:' + port;
    assert.ok(!rig.flowStore[cfgKey], 'nothing was read before a native intent stood');
    const pending = await rig.tick(nativeSetpoint('native'));
    assert.notStrictEqual(pending.plan.mode, 'native', 'no hand-over without the device answer');
    assert.ok(rig.warns.some((w) => /eigene Konfiguration/.test(w)),
      'the refusal names itself: ' + JSON.stringify(rig.warns));
    assert.deepStrictEqual(
      { tou: rig.flowStore[cfgKey].tou_enable, soc: rig.flowStore[cfgKey].program_target_soc, chg: rig.flowStore[cfgKey].grid_charge_enable },
      { tou: 0x00ff, soc: 5, chg: 0 },
      'the executor read the inverter own Time-of-Use program');
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'and nothing was handed over on that tick');
    // The EEG question is answered from that same read, BEFORE any hand-over -
    // and kept apart from the in-mode evidence, which a non-native cycle never has.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(pending.out.payload.native_precondition || null)), { grid_charge_blocked: true },
      'the pre-hand-over read states the device answer');
    assert.strictEqual(pending.out.payload.native, undefined, 'no in-mode evidence before the hand-over');

    // 3. THE HAND-OVER. Exactly one register write: 1100 <- 0.
    const before = writes.length;
    const nat = await rig.tick(nativeSetpoint('native'));
    assert.strictEqual(nat.plan.mode, 'native');
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(nat.plan.writes.map((w) => ({ addr: w.addr, value: w.value })))),
      [{ addr: REG_REMOTE.mode, value: 0 }],
      'disabling remote mode IS the hand-over - nothing else is written');
    assert.deepStrictEqual(writes.slice(before).map((w) => ({ reg: w.reg, value: w.value })),
      [{ reg: REG_REMOTE.mode, value: 0 }], 'and that is the only frame that reached the logger');
    assert.strictEqual(store[REG_REMOTE.mode], 0, 'the inverter now runs its own loop');

    // The EVIDENCE half: the mode is claimed because 1100 really read back 0, and
    // the device answered the EEG question from its own Program-1 charging enum.
    assert.strictEqual(nat.out.payload.mode, 'native', 'the readback is the evidence');
    assert.strictEqual(nat.out.payload.native.grid_charge_blocked, true);
    assert.strictEqual(nat.out.payload.native_precondition, undefined,
      'a native cycle carries ONLY the answer read in the device own mode');
    assert.ok(nat.out.payload.registers.every((r) => r.match), 'and it holds what it says');
    assert.ok(rig.planStatuses.some((t) => /Wechselrichter-Automatik \(umgeschaltet\)/.test(t || '')),
      'the node names the hand-over: ' + JSON.stringify(rig.planStatuses.slice(-2)));
    assert.ok(rig.execStatuses.some((t) => /Wechselrichter-Automatik/.test(t || '')),
      'and so does the readback: ' + JSON.stringify(rig.execStatuses.slice(-2)));

    // 4. Further native ticks write NOTHING - they only read the state back. That
    //    is the whole point of the mode on a one-client logger.
    const after = writes.length;
    for (let i = 0; i < 3; i += 1) {
      const t = await rig.tick(nativeSetpoint('native'));
      assert.strictEqual(t.plan.writes.length, 0, 'write once, then only read');
      assert.strictEqual(t.out.payload.mode, 'native');
      assert.strictEqual(t.out.payload.wrote, false);
    }
    assert.strictEqual(writes.length, after, 'not one further register write');
    assert.strictEqual(store[REG_REMOTE.mode], 0);

    // 5. THE TAKE-BACK is the ordinary remote plan in its UNCHANGED order:
    //    watchdog FIRST, enable LAST (the setpoint in between).
    const backFrom = writes.length;
    const back = await rig.tick(nativeSetpoint('setpoint'));
    assert.notStrictEqual(back.plan.mode, 'native');
    const backWrites = writes.slice(backFrom).map((w) => w.reg);
    assert.strictEqual(backWrites[0], REG_REMOTE.watchdog, 'watchdog first');
    assert.strictEqual(backWrites[backWrites.length - 1], REG_REMOTE.mode, 'enable LAST');
    assert.ok(backWrites.indexOf(REG_REMOTE.constantPower) > 0, 'the setpoint is written again');
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'remote mode is armed again');
    assert.strictEqual(back.out.payload.mode, 'normal', 'and the readback says so');
  } finally {
    server.close();
  }
});

test('the pilot refuses when its own Time-of-Use program cannot cover the house', async () => {
  // Bit 0 of 0x0092 is the ENABLE; without it the Deye manual is unambiguous -
  // the inverter charges normally but only discharges for its own consumption,
  // never into the loads. The supervision could not catch this (the device would
  // report the mode correctly), so the refusal has to happen BEFORE the hand-over.
  const { server, port, writes, store } = await startSolarmanServer(
    nativeStore({ [REG_TOU.touEnable]: 0x00fe }));
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint'));
    await rig.tick(nativeSetpoint('native')); // fills the cache
    const t = await rig.tick(nativeSetpoint('native'));

    assert.notStrictEqual(t.plan.mode, 'native', 'nothing is handed over');
    assert.ok(rig.warns.some((w) => /Time of Use/.test(w) && /10-Sekunden-Nachfuehrung/.test(w)),
      'the refusal names the cause AND the path it stays on: ' + JSON.stringify(rig.warns));
    // ⚠ SAID ONCE, SHOWN ALWAYS: a standing refusal must not write a log line
    // every ~10 s (it would bury the lines the bench checklist reads), but it
    // must stay visible - so the node carries the cause on every tick.
    await rig.tick(nativeSetpoint('native'));
    await rig.tick(nativeSetpoint('native'));
    assert.strictEqual(rig.warns.filter((w) => /Time of Use/.test(w)).length, 1,
      'the standing cause is logged once, not once per tick: ' + JSON.stringify(rig.warns));
    assert.ok(/Automatik: .*Time of Use/.test(rig.planStatuses[rig.planStatuses.length - 1] || ''),
      'and the node still shows it on the LAST tick: ' + JSON.stringify(rig.planStatuses.slice(-2)));
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'remote mode stays armed');
    assert.ok(writes.some((w) => w.reg === REG_REMOTE.constantPower),
      'and the proven follower keeps writing the setpoint');
    assert.strictEqual(t.out.payload.mode, 'normal');
    assert.strictEqual(t.out.payload.native, undefined, 'no evidence block for a mode we are not in');
  } finally {
    server.close();
  }
});

test('E-down: the Herzogau setting (Selling First, ToU active) is refused - no write, the box keeps covering', async () => {
  // vp-wr-deye-tou-schreibbudget: Work Mode 0 "Selling First" with Time of Use
  // active may sell STORAGE energy (manual) - that breaks E-down's "no sale". The
  // block read decides; no installer register is ever written.
  const { server, port, writes, store } = await startSolarmanServer(nativeStore({}, { workMode: 0 }));
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint', { grid_charge_allowed: false }));
    await rig.tick(nativeSetpoint('native', { grid_charge_allowed: false })); // fills the cache
    const t = await rig.tick(nativeSetpoint('native', { grid_charge_allowed: false }));
    assert.notStrictEqual(t.plan.mode, 'native', 'nothing is handed over');
    assert.ok(rig.warns.some((w) => /Selling First/.test(w) && /nur Verbrauch decken/.test(w)),
      'the refusal names the setting: ' + JSON.stringify(rig.warns));
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'remote mode stays armed - no 1100 <- 0');
    assert.ok(!writes.some((w) => w.reg === REG_REMOTE.mode && w.value === 0), 'never a hand-over write');
    assert.ok(!writes.some((w) => w.reg >= 0x008d && w.reg <= 0x00b1), 'no installer register touched');
    assert.ok(writes.some((w) => w.reg === REG_REMOTE.constantPower), 'the follower keeps covering');
    assert.match(String(t.out.payload.native_refusal || ''), /Selling First/, 'and the core hears why');
  } finally {
    server.close();
  }
});

test('an EEG plant is refused unless the inverter own program already blocks grid charging', async () => {
  const { server, port, store } = await startSolarmanServer(
    nativeStore({}, { prog: { charge: 1 } })); // every program's Charging = Grid
  try {
    const rig = makeNativeRig(port);
    const eeg = () => nativeSetpoint('native', { grid_charge_allowed: false });
    await rig.tick(nativeSetpoint('setpoint', { grid_charge_allowed: false }));
    await rig.tick(eeg());
    const t = await rig.tick(eeg());
    assert.notStrictEqual(t.plan.mode, 'native');
    assert.ok(rig.warns.some((w) => /EEG-Anlage/.test(w)),
      'the compliance refusal names itself: ' + JSON.stringify(rig.warns));
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'nothing was handed over');
    // ... and the core hears WHY: the device said, before any hand-over, that it
    // may charge from the grid - the core then takes the intent back for the slot.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(t.out.payload.native_precondition || null)), { grid_charge_blocked: false });
  } finally {
    server.close();
  }
});

test('an EEG plant whose own program blocks grid charging IS handed over: erst normal, dann nativ', async () => {
  // K3 (concept §2.3): the core may only keep an EEG intent standing if it hears
  // the device's grid-charge answer before the hand-over - this is that sequence
  // as the executor really runs it, on an inverter whose Program 1 Charging is
  // Disabled (the only configuration an EEG hand-over may happen on).
  const { server, port, writes, store } = await startSolarmanServer(nativeStore());
  try {
    const rig = makeNativeRig(port);
    const eeg = (mode) => nativeSetpoint(mode, { grid_charge_allowed: false });

    const first = await rig.tick(eeg('setpoint'));
    assert.strictEqual(first.out.payload.mode, 'normal');
    assert.strictEqual(first.out.payload.native_precondition, undefined,
      'nothing is read before a native intent stands');

    // The intent's first tick: refused honestly (nothing read yet), follower
    // carries it, the executor reads 0x00AC and states the answer.
    const pending = await rig.tick(eeg('native'));
    assert.notStrictEqual(pending.plan.mode, 'native');
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'no hand-over on the reading tick');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(pending.out.payload.native_precondition || null)), { grid_charge_blocked: true });

    // The hand-over: the last gate (deyeNativePrecondition, EEG branch) passes on
    // the value just read - one write, and the device repeats the proof in its
    // own mode.
    const before = writes.length;
    const nat = await rig.tick(eeg('native'));
    assert.strictEqual(nat.plan.mode, 'native');
    assert.deepStrictEqual(writes.slice(before).map((w) => ({ reg: w.reg, value: w.value })),
      [{ reg: REG_REMOTE.mode, value: 0 }]);
    assert.strictEqual(nat.out.payload.mode, 'native');
    // K5 (K4b point 4): the proving cycle now also names the intent it realises.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nat.out.payload.native || null)),
      { grid_charge_blocked: true, intent: 'cover_load' });
    assert.strictEqual(nat.out.payload.native_precondition, undefined);
  } finally {
    server.close();
  }
});

test('a hand-over the device does not confirm is NOT reported as native', async () => {
  // dropWrites models the live-Pilsting shape: the logger accepts the frame and
  // echoes it, but the register never changes. 1100 keeps reading 1, so there is
  // no proof - and "we stopped writing" must never look like "the inverter
  // regulates itself". The core then withdraws the intent (nachweis_fehlt).
  const { server, port, store } = await startSolarmanServer(nativeStore(), { dropWrites: true });
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint'));
    await rig.tick(nativeSetpoint('native'));
    const t = await rig.tick(nativeSetpoint('native'));

    assert.strictEqual(t.plan.mode, 'native', 'the plan node did hand over');
    assert.strictEqual(store[REG_REMOTE.mode], 0, 'setup: the register never moved (it was 0 all along)');
    // The store starts at 0 and dropWrites keeps it there, so the proof HOLDS -
    // flip the device instead: it reports remote mode still ON.
    store[REG_REMOTE.mode] = 1;
    const t2 = await rig.tick(nativeSetpoint('native'));
    assert.strictEqual(t2.out.payload.mode, 'normal',
      'a mode the device does not confirm is never claimed');
    assert.strictEqual(t2.out.payload.native, undefined,
      'and no grid-charge statement is made about a mode we are not in');
  } finally {
    server.close();
  }
});

test('every OTHER Deye stays on the proven follower - the release is bound to the pilot', async () => {
  const { server, port, store, writes } = await startSolarmanServer(nativeStore());
  try {
    // Same family, same firmware layout, a different catalog model id.
    const other = nativeSel(port);
    other.model = 'sun-12k-sg04lp3';
    const rig = makeNativeRig(port, other);
    await rig.tick(nativeSetpoint('setpoint'));
    await rig.tick(nativeSetpoint('native'));
    const t = await rig.tick(nativeSetpoint('native'));

    assert.notStrictEqual(t.plan.mode, 'native');
    assert.ok(rig.warns.some((w) => /Pruefstand|Prüfstand/.test(w)),
      'the refusal names the missing release: ' + JSON.stringify(rig.warns));
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'remote mode stays armed');
    assert.ok(writes.some((w) => w.reg === REG_REMOTE.constantPower),
      'and the setpoint keeps being written');
  } finally {
    server.close();
  }
});

// =============================================================================
// NETZ-SOLLWERT-TEST auf dem DRAHT (Konzept `vp-deye-netzseitig-drossel-k2` P1).
// Derselbe Executor, derselbe Logger - was hier bewiesen wird, ist die REIHEN-
// FOLGE der Register, die Umschaltung auf die Netzseite UND die vollstaendige
// Rueckkehr. Der Test schreibt ausschliesslich in 1100-1121; kein einziges
// Installateur-Register wird angefasst.
// =============================================================================

function gridTestSetpoint(gt) {
  return {
    battery_setpoint_kw: 0, source: 'grid-test', control_enabled: true,
    device_certified: true, grid_charge_allowed: false,
    soc_min_pct: 20, soc_max_pct: 95,
    grid_test: { mode: 'grid', ...gt },
  };
}

test('Netz-Sollwert-Test: der Seitenwechsel landet in der RICHTIGEN Reihenfolge auf dem Draht', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    await certifiedRemotePlan(
      gridTestSetpoint({ step: 'halten', side: 'grid', target_kw: -24.9, neutralize: true }),
      cap,
      async (plan) => {
        assert.strictEqual(plan.controlPath, 'remote');
        assert.ok(plan.gridTest, 'der Plan traegt den Testschritt');
        plan.connection.port = port;
        const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: { source: 'grid-test' } }, {}, flowStore);
        assert.ok(out, 'der Executor hat eine Rueckmeldung veroeffentlicht');

        // ⚠ DIE REIHENFOLGE IST DIE SICHERHEIT: Totmann (1101) zuerst, dann der
        // Neutralschritt auf 1109, DANN die Regelseite 1104, dann das Ziel auf
        // derselben 1109, und ZULETZT der Schalter 1100. Ohne den Neutralschritt
        // dazwischen wechselte 1104 die Bedeutung eines stehenden Wertes.
        assert.deepStrictEqual(writes.map((w) => w.reg),
          [0x044d, 0x0455, 0x0450, 0x0455, 0x044c],
          'Totmann, Neutral, Regelseite, Ziel, Enable');
        assert.ok(writes.every((w) => w.fc === 0x10), 'FC16 - der einzige Code, den diese Firmware beantwortet');
        assert.strictEqual(writes[1].value, 0, 'der Neutralschritt schreibt wirklich 0');

        // Die Werte, die danach im Geraet stehen.
        assert.strictEqual(store[0x044d], 60, 'Totmann 60 s');
        assert.strictEqual(store[0x0450], 2, 'NETZ-seitig (1104 = 2)');
        assert.strictEqual(store[0x0455], (-830) & 0xffff, '-24,9 kW von 30 kW = -830 Einheiten, NICHT negiert');
        assert.strictEqual(store[0x044c], 1, 'Fernsteuerung eingeschaltet');

        // Kein Installateur-Register - der Testpfad kann nichts latchen.
        const reg = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
        for (const inst of [reg.energyPattern, reg.workMode, reg.solarSell, reg.maxSellPower, reg.touEnable, reg.exportLimit]) {
          assert.strictEqual(store[inst], undefined, 'Installateur-Register 0x' + inst.toString(16) + ' unberuehrt');
        }

        // Die Rueckmeldung bestaetigt jedes kommandierte Register - und der
        // Neutralschritt ist bewusst NICHT dabei (er wird im selben Takt
        // ueberschrieben, ein Rueckelesen ergaebe eine garantierte Abweichung).
        const rb = out.payload;
        assert.strictEqual(rb.control_path, 'remote');
        assert.ok(rb.registers.every((r) => r.match), 'alle Register bestaetigt: ' + JSON.stringify(rb.registers));
        assert.ok(!rb.registers.some((r) => r.role === 'grid_neutral'));
        assert.ok(rb.registers.some((r) => r.role === 'grid_power'), 'der Netz-Sollwert traegt seine eigene Rolle');
      },
    );
  } finally {
    server.close();
  }
});

test('Netz-Sollwert-Test: die PV-Kappe 1115 landet - und nur im erlaubten Band', async () => {
  const { server, port, store } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    await certifiedRemotePlan(
      gridTestSetpoint({ step: 'pv_kappe', side: 'grid', target_kw: -24.9, pv_cap_permille: 999 }),
      cap,
      async (plan) => {
        plan.connection.port = port;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flowStore);
        assert.ok(out);
        assert.strictEqual(store[0x045b], 999, '1115 = 999 (die letzte Stufe UNTER der Voll-Drosselung)');
        assert.ok(out.payload.registers.find((r) => r.role === 'pv_max_permille').match);
      },
    );
    // ⚠ 1000 hiesse auf diesem Register „eigene PV auf 0" - der Wert erreicht
    // das Geraet nie, und der Rest des Schrittes laeuft trotzdem.
    const before = store[0x045b];
    await certifiedRemotePlan(
      gridTestSetpoint({ step: 'pv_kappe', side: 'grid', target_kw: -24.9, pv_cap_permille: 1000 }),
      cap,
      async (plan) => {
        plan.connection.port = port;
        assert.ok(!plan.writes.some((w) => w.role === 'pv_max_permille'));
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flowStore);
        assert.ok(out, 'der Schritt laeuft weiter');
        assert.strictEqual(store[0x045b], before, '1115 wurde NICHT veraendert');
      },
    );
  } finally {
    server.close();
  }
});

test('Netz-Sollwert-Test: die RUECKKEHR stellt die Batterieseite wirklich wieder her', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    // Erst netzseitig gehen ...
    await certifiedRemotePlan(
      gridTestSetpoint({ step: 'halten', side: 'grid', target_kw: -24.9, neutralize: true }),
      cap,
      async (plan) => { plan.connection.port = port; await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flowStore); },
    );
    assert.strictEqual(store[0x0450], 2, 'Vorbedingung: das Geraet steht netzseitig');
    writes.length = 0;

    // ... und dann zurueck. Auch das ist ein Seitenwechsel, also mit Neutralschritt.
    await certifiedRemotePlan(
      gridTestSetpoint({ step: 'rueckkehr', side: 'battery', target_kw: 0, neutralize: true }),
      cap,
      async (plan) => {
        plan.connection.port = port;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {}, flowStore);
        assert.ok(out);
        assert.deepStrictEqual(writes.map((w) => w.reg),
          [0x044d, 0x0455, 0x0450, 0x0455, 0x044c], 'dieselbe Reihenfolge zurueck');
        assert.strictEqual(store[0x0450], 1, 'BATTERIE-seitig - das Geraet regelt wieder wie im Betrieb');
        assert.strictEqual(store[0x0455], 0, 'und mit Sollwert 0');
        assert.ok(out.payload.registers.every((r) => r.match));
      },
    );
  } finally {
    server.close();
  }
});

test('Netz-Sollwert-Test: der Totmann wird in JEDEM Schritt neu gespannt', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    const flowStore = { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) };
    // ⚠ EIN gemeinsamer Knoten-Kontext ueber alle Takte - so laeuft der Flow
    // wirklich. Nur damit ist der Test nicht vakuum: mit einem frischen Kontext
    // je Takt waere der Schreib-Cache immer leer und jeder Wert wuerde ohnehin
    // geschrieben.
    const ctx = {};
    const ticks = [
      { step: 'halten', side: 'grid', target_kw: -24.9, neutralize: true },
      { step: 'schritt', side: 'grid', target_kw: -22.9 },
      { step: 'null_export', side: 'grid', target_kw: 0 },
    ];
    for (const gt of ticks) {
      writes.length = 0;
      store[0x044d] = 12; // als waere er zwischen den Takten abgelaufen
      await certifiedRemotePlan(gridTestSetpoint(gt), cap, async (plan) => {
        plan.connection.port = port;
        const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, ctx, flowStore);
        assert.ok(out, gt.step);
        // ⚠ Der Totmann ist KEIN „write-on-change": das Neuschreiben IST der
        // Mechanismus. Ohne ihn liefe der Test in die eigene Frist des Geraets.
        assert.strictEqual(writes[0].reg, 0x044d, gt.step + ': der Totmann kommt zuerst');
        assert.strictEqual(store[0x044d], 60, gt.step + ': und er steht wieder auf 60 s');
      });
    }
  } finally {
    server.close();
  }
});

test('Netz-Sollwert-Test: ohne Freigabe erreicht KEIN Byte den Wechselrichter', async () => {
  const { server, port, store, writes } = await startSolarmanServer(remoteCapableStore());
  try {
    const cap = ownerCapability();
    // Kein certifiedRemotePlan -> die ausgelieferte Allowlist gilt, und
    // hybrid_3p steht nicht darin.
    const plan = controlRouting.controlRoute(REMOTE_SEL,
      { ...gridTestSetpoint({ step: 'halten', side: 'grid', target_kw: -24.9 }), device_certified: false },
      { ratedKw: 30, deye: cap });
    plan.connection.port = port;
    assert.deepStrictEqual(plan.writes, []);
    const out = await runExec(DEYE_EXEC, { control: plan, setpoint: {} }, {},
      { [controlRouting.deyeCapabilityKey('127.0.0.1', port)]: Object.assign({}, cap, { at: Date.now() }) });
    assert.deepStrictEqual(writes, [], 'nichts geschrieben');
    assert.strictEqual(store[0x044c], undefined, 'die Fernsteuerung wurde nie eingeschaltet');
    assert.ok(!out || out.payload.wrote !== true);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// K5 "Deye Überschuss-Übergabe": the CHARGE side of the same pilot, through the
// shipped plan node + Deye executor against the Solarman stub. Two candidates
// (grid_zero, own_config), each released only by its own certificate entry -
// none is in the production catalog yet, so the armed pilot window
// (`native_pilot`, only the core's operator path publishes it) is the one way
// to run them, exactly like the grid-setpoint test.
// ---------------------------------------------------------------------------

const REG_K5 = {
  energyPattern: 0x008d, workMode: 0x008e, solarSell: 0x0091, touEnable: 0x0092,
  progTime: 0x0094, progPower: 0x009a, progSoc: 0x00a6, progCharge: 0x00ac, pvMax: 0x045b,
};
// The device's OWN configuration: `prog` is applied to ALL six ToU programs, so
// which one governs at the test's wall-clock time does not matter here (the
// active-program choice is proven in deye-charge-side.test.js with an injected
// time of day).
function k5Store({ workMode = 0, pattern = 1, solarSell = 1, tou = 0x00ff, prog = {} } = {}) {
  const p = { power: 3000, soc: 5, charge: 0, ...prog };
  const out = nativeStore({
    [REG_K5.energyPattern]: pattern, [REG_K5.workMode]: workMode,
    [REG_K5.solarSell]: solarSell, [REG_K5.touEnable]: tou, [REG_K5.pvMax]: 1000,
  });
  const times = [0, 500, 900, 1300, 1700, 2100];
  for (let i = 0; i < 6; i++) {
    out[REG_K5.progTime + i] = times[i];
    out[REG_K5.progPower + i] = p.power;
    out[REG_K5.progSoc + i] = p.soc;
    out[REG_K5.progCharge + i] = p.charge;
  }
  return out;
}
function k5Setpoint(intent, extra = {}) {
  const win = intent === 'surplus_charge' ? { battery_window_min_kw: 0, battery_window_max_kw: 30 }
    : { battery_window_min_kw: -30, battery_window_max_kw: 30 };
  return nativeSetpoint('native_window', {
    battery_native_intent: intent, battery_native_duty: undefined, battery_setpoint_kw: 0,
    grid_charge_allowed: false, ...win, ...extra,
  });
}
const k5Pilot = (candidate, intent) => ({ native_pilot: { candidate, intent, run: 'k5-test' } });

test('K5: ohne Zertifikat bleibt die Ladeseite gedämpft - nur E↓ wird gemeldet, nichts wird übergeben', async () => {
  const { server, port, writes, store } = await startSolarmanServer(k5Store());
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint'));
    const r = await rig.tick(k5Setpoint('self_consumption'));
    assert.notStrictEqual(r.plan.mode, 'native', 'no certificate, no hand-over');
    assert.strictEqual(store[REG_REMOTE.mode], 1, 'remote mode stays armed (the box regulates)');
    assert.ok(!writes.some((w) => w.reg === REG_REMOTE.powerControlMode && w.value === 2), 'never the grid side');
    // K4b point 4: the Deye executor reports its levers - today exactly E↓.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.out.payload.native_capabilities)),
      { intents: ['cover_load'], window: false, persistent: false });
    assert.match(r.out.payload.native_refusal, /Prüfstand/, 'and says why nothing moved');
  } finally {
    server.close();
  }
});

test('K5 Pilot Kandidat 1 (netzseitig Ziel 0): Totmann zuerst, 1109 <- 0 vor 1104 <- 2, 1115 <- 999, 1100 zuletzt; danach nur der Herzschlag', async () => {
  const { server, port, writes, store } = await startSolarmanServer(k5Store());
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint', { battery_setpoint_kw: -7.087 }));
    // First pilot tick: the device's configuration is not read yet -> refused by
    // name, the follower carries it, the executor fills the cache.
    const pending = await rig.tick(k5Setpoint('self_consumption', k5Pilot('grid_zero', 'self_consumption')));
    assert.notStrictEqual(pending.plan.mode, 'native');
    assert.match(pending.out.payload.native_refusal, /eigene Konfiguration/);
    const before = writes.length;
    const nat = await rig.tick(k5Setpoint('self_consumption', k5Pilot('grid_zero', 'self_consumption')));
    assert.strictEqual(nat.plan.mode, 'native');
    assert.strictEqual(nat.plan.candidate, 'grid_zero');
    assert.deepStrictEqual(writes.slice(before).map((w) => [w.reg, w.value]), [
      [REG_REMOTE.watchdog, 60], [REG_REMOTE.constantPower, 0], [REG_REMOTE.powerControlMode, 2],
      [REG_K5.pvMax, 999], [REG_REMOTE.mode, 1],
    ], 'the neutral step stands BEFORE the side switch, the enable LAST');
    assert.strictEqual(nat.out.payload.mode, 'native');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nat.out.payload.native)), {
      grid_charge_blocked: true, intent: 'self_consumption', curtails_own_pv: true, candidate: 'grid_zero',
    }, 'the proof names the intent, the candidate and its PV side effect (§6.3)');
    // Next tick: the watchdog kick keeps remote mode alive (RAM ops re-asserted),
    // the two configuration ops are NOT rewritten while they hold.
    const hb0 = writes.length;
    const hb = await rig.tick(k5Setpoint('self_consumption', k5Pilot('grid_zero', 'self_consumption')));
    assert.strictEqual(hb.out.payload.mode, 'native');
    assert.deepStrictEqual(writes.slice(hb0).map((w) => [w.reg, w.value]),
      [[REG_REMOTE.watchdog, 60], [REG_REMOTE.constantPower, 0], [REG_REMOTE.mode, 1]]);
    // Back to the ordinary plan: battery side again, 1100 stays the last word.
    const back0 = writes.length;
    await rig.tick(nativeSetpoint('setpoint', { battery_setpoint_kw: -5 }));
    const back = writes.slice(back0).map((w) => w.reg);
    assert.ok(back.includes(REG_REMOTE.powerControlMode), 'the side is switched back');
    assert.strictEqual(store[REG_REMOTE.powerControlMode], 1, 'battery side again');
    assert.strictEqual(back[back.length - 1], REG_REMOTE.mode, 'enable last');
  } finally {
    server.close();
  }
});

test('K5 Pilot Kandidat 2 (Eigenkonfiguration): die Herzogau-Einstellung wird gelesen und mit Grund verweigert - kein Schreiben', async () => {
  // Herzogau (m6): Work Mode 0 "Selling First", Load First, Solar Sell on, ToU on.
  const { server, port, writes, store } = await startSolarmanServer(k5Store());
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint'));
    const sc = k5Setpoint('self_consumption', k5Pilot('own_config', 'self_consumption'));
    await rig.tick(sc);
    const w0 = writes.length;
    const r = await rig.tick(sc);
    assert.notStrictEqual(r.plan.mode, 'native');
    assert.match(r.out.payload.native_refusal, /Selling First/);
    assert.ok(!writes.slice(w0).some((w) => w.reg === REG_REMOTE.mode && w.value === 0), 'no 1100 <- 0');
    assert.strictEqual(store[REG_REMOTE.mode], 1);
    const cache = rig.flowStore['deye_native_cfg:127.0.0.1:' + port];
    assert.strictEqual(cache.own_config.length, 37, 'ONE block read of the own configuration');
    assert.strictEqual(cache.own_config[REG_K5.workMode - REG_K5.energyPattern], 0);
    // E-up with a program that may discharge: refused too, with its own reason.
    const sp = k5Setpoint('surplus_charge', k5Pilot('own_config', 'surplus_charge'));
    await rig.tick(sp);
    const up = await rig.tick(sp);
    assert.notStrictEqual(up.plan.mode, 'native');
    assert.match(up.out.payload.native_refusal, /zu entladen/);
    // The box never touched an installer register.
    for (const reg of [REG_K5.workMode, REG_K5.energyPattern, REG_K5.solarSell, REG_K5.touEnable, 0x00e7, 0x006c, 0x006d]) {
      assert.ok(!writes.some((w) => w.reg === reg), 'installer register 0x' + reg.toString(16) + ' untouched');
    }
  } finally {
    server.close();
  }
});

test('K5 Pilot Kandidat 2: E↑ wird übergeben, wenn das gültige Programm nicht entladen darf (Leistung 0)', async () => {
  const { server, port, writes } = await startSolarmanServer(k5Store({ prog: { power: 0 } }));
  try {
    const rig = makeNativeRig(port);
    await rig.tick(nativeSetpoint('setpoint'));
    const sp = k5Setpoint('surplus_charge', k5Pilot('own_config', 'surplus_charge'));
    await rig.tick(sp);
    const w0 = writes.length;
    const r = await rig.tick(sp);
    assert.strictEqual(r.plan.mode, 'native', r.out && r.out.payload.native_refusal);
    assert.deepStrictEqual(writes.slice(w0).map((w) => [w.reg, w.value]), [[REG_REMOTE.mode, 0]]);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.out.payload.native)),
      { grid_charge_blocked: true, intent: 'surplus_charge', candidate: 'own_config' });
    // Write once, then only read (no heartbeat on this candidate).
    const w1 = writes.length;
    await rig.tick(sp);
    assert.strictEqual(writes.length, w1, 'no second write');
  } finally {
    server.close();
  }
});

test('K5: mit Zertifikat-Eintrag (nur Test-Katalog) wählt die Box den Kandidaten ohne Pilot, und die Meldung nennt die Ladeseite', async () => {
  const { server, port, writes } = await startSolarmanServer(k5Store());
  // The ONE line a release after the pilot adds - injected here into the shipped
  // plan node's catalog variable, never into production.
  const line = "var nativeCatalogGeneric = __NATIVE.CERTIFIED_NATIVE_CAPABILITIES;";
  assert.ok(DEYE_NATIVE_PLAN.includes(line), 'the plan node has one catalog variable');
  const planWithEntry = DEYE_NATIVE_PLAN.replace(line,
    "var nativeCatalogGeneric = __NATIVE.CERTIFIED_NATIVE_CAPABILITIES.concat([__NATIVE.releaseDeyeChargeSide('grid_zero', 'self_consumption', 'Test: kein echter Nachweis')]);");
  try {
    const rig = makeNativeRig(port, nativeSel(port), planWithEntry);
    const tick = rig.tick;
    const first = await tick(nativeSetpoint('setpoint'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(first.out.payload.native_capabilities)),
      { intents: ['cover_load', 'self_consumption'], window: false, persistent: false });
    await tick(k5Setpoint('self_consumption'));
    const w0 = writes.length;
    const r = await tick(k5Setpoint('self_consumption'));
    assert.strictEqual(r.plan.mode, 'native');
    assert.strictEqual(r.plan.candidate, 'grid_zero');
    assert.strictEqual(r.plan.certificate.bench_record, 'Test: kein echter Nachweis');
    assert.strictEqual(writes.slice(w0).length, 5);
    // E-up has no entry: it stays with the box.
    const up = await tick(k5Setpoint('surplus_charge'));
    assert.notStrictEqual(up.plan.mode, 'native');
  } finally {
    server.close();
  }
});

// --- vp-wr-deye-tou-schreibbudget: the ToU path's day budget, over a WHOLE day ---
//
// The plan node and the executor from flows.json, the in-process logger and a
// fake clock: 96 quarter hours, every one of them a plan change (discharge <->
// charge - the worst case the 900-s dwell still allows). The budget is 20 plan
// changes per day (concept §6.6, F12; profile deye_tou): 19 plan changes, the
// 20th wanted change is HELD because the day's last room belongs to the release,
// the release restores the device's own configuration, and every later change is
// refused with the reason - until the day turns.
function makeTouRig(port, clock) {
  const sel = { ...DEYE_SEL, connection: { ...DEYE_SEL.connection, port } };
  const target = '127.0.0.1:' + port;
  const flowStore = { inverter_config: sel };
  const planCtx = {};
  const execCtx = {};
  const warns = [];
  class FakeDate extends Date {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  const sandbox = (msg, ctxStore) => ({
    msg,
    node: { status() {}, error() {}, warn(l) { warns.push(String(l)); }, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    Buffer, Date: FakeDate, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  });
  const tick = async (kw, extra = {}) => {
    // The definitive "no remote block" verdict the ToU path needs, kept fresh so
    // no capability re-probe falls into the day (proven elsewhere).
    flowStore['deye_cap:' + target] = { ...TOU_E2E_CAP, at: clock.now };
    const msg = { setpoint: { battery_setpoint_kw: kw, source: 'schedule', control_enabled: true,
      device_certified: true, soc_min_pct: 10, ts: new Date(clock.now).toISOString(), ...extra } };
    const planBox = sandbox(msg, planCtx);
    vm.createContext(planBox);
    const planned = vm.runInContext('(function () {\n' + DEYE_NATIVE_PLAN + '\n})()', planBox);
    if (!planned) return { plan: null, out: null };
    const execBox = sandbox(msg, execCtx);
    vm.createContext(execBox);
    const ret = vm.runInContext('(function () {\n' + DEYE_EXEC + '\n})()', execBox);
    const out = ret && typeof ret.then === 'function' ? await ret : ret;
    return { plan: msg.control, out };
  };
  return { tick, flowStore, warns, budgetKey: 'deye_tou_budget:' + target };
}

test('ToU-Schreibbudget: ein ganzer Tag - 19 Planwechsel, die Rückgabe, der 21. Planwechsel ist gesperrt', async () => {
  const REG = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
  // The installer's own configuration: Load First, Zero Export To CT, ToU OFF.
  const { server, port, store, writes } = await startSolarmanServer({
    [REG.energyPattern]: 1, [REG.workMode]: 2, [REG.maxSellPower]: 7182, [REG.touEnable]: 0,
  });
  try {
    const day0 = new Date(2026, 8, 24, 0, 0).getTime();
    const clock = { now: day0 };
    const rig = makeTouRig(port, clock);
    // Two ticks per quarter hour: at its start (the plan changes) and 10 s later
    // (the republish - readback only, unless the budget hands the device back).
    const ticks = [];
    for (let q = 0; q < 96; q++) {
      for (const offS of [0, 10]) {
        clock.now = day0 + q * 15 * 60 * 1000 + offS * 1000;
        const before = writes.length;
        const t = await rig.tick(q % 2 === 0 ? -5 : 5);
        ticks.push({ q, offS, wrote: writes.length > before, mode: t.plan && t.plan.mode, out: t.out && t.out.payload });
      }
    }
    const wrote = ticks.filter((x) => x.wrote).map((x) => x.q + (x.offS ? '+10s' : ''));
    assert.deepStrictEqual(wrote, [...[...Array(19).keys()].map(String), '19+10s'],
      '19 plan changes, the 20th wanted one held, the release 10 s later - nothing after it');
    // q=19: the wanted change is HELD - nothing written, the reason on the readback.
    const held = ticks.find((x) => x.q === 19 && x.offS === 0).out;
    assert.strictEqual(held.blocked, true);
    assert.match(held.reason, /Tagesbudget der Zeitfenster-Steuerung erreicht \(19 von 20/);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(held.tou_budget)), { day: '2026-09-24', changes: 19, limit: 20, held: true });
    // The next tick hands the device back to ITS OWN configuration.
    const rel = ticks.find((x) => x.q === 19 && x.offS === 10);
    assert.strictEqual(rel.mode, 'release');
    assert.strictEqual(store[REG.touEnable], 0, 'Time of Use back to the installer value (off)');
    assert.strictEqual(store[REG.energyPattern], 1);
    assert.strictEqual(store[REG.maxSellPower], 7182, 'the installer export limit restored');
    assert.strictEqual(rel.out.tou_budget.changes, 20, 'the release is the 20th EEPROM plan write');
    // The 21st plan change (q=20) and every later one: refused, the reason visible.
    for (const x of ticks.filter((t) => t.q >= 20)) {
      assert.strictEqual(x.wrote, false, `q=${x.q}`);
      assert.strictEqual(x.out.blocked, true, `q=${x.q}: blocked readback`);
      assert.match(x.out.reason, /bis Mitternacht keine weiteren Planwechsel/, `q=${x.q}`);
    }
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rig.flowStore[rig.budgetKey])), { day: '2026-09-24', changes: 20, held: true });
    assert.ok(rig.warns.some((w) => /Tagesbudget/.test(w)), 'said in the log too');

    // The next day starts over: the first plan change is written again.
    clock.now = day0 + 24 * 3600 * 1000;
    const before = writes.length;
    const next = await rig.tick(-5);
    assert.ok(writes.length > before, 'a new day, a new budget');
    assert.notStrictEqual(next.out.payload.blocked, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(next.out.payload.tou_budget)), { day: '2026-09-25', changes: 1, limit: 20, held: false });
  } finally {
    server.close();
  }
});

test('ToU-Schreibbudget: ein engeres Profil-Budget (persistent_write_budget) gilt, ein weiteres nicht', async () => {
  const REG = controlRouting.DEYE_CONTROL_REG.hybrid_3p;
  const { server, port, writes } = await startSolarmanServer({ [REG.touEnable]: 0 });
  try {
    const day0 = new Date(2026, 8, 24, 0, 0).getTime();
    const clock = { now: day0 };
    const rig = makeTouRig(port, clock);
    const wrote = [];
    for (let q = 0; q < 8; q++) {
      clock.now = day0 + q * 15 * 60 * 1000;
      const before = writes.length;
      await rig.tick(q % 2 === 0 ? -5 : 5, { persistent_write_budget: 4 });
      wrote.push(writes.length > before);
    }
    assert.deepStrictEqual(wrote, [true, true, true, false, true, false, false, false],
      'budget 4: three plan changes, held, the release on the next tick - then nothing');
    // A looser statement is ignored: 40 is still 20.
    const B = require('./deye-tou-budget');
    assert.strictEqual(B.touBudgetLimit(40), 20);
  } finally {
    server.close();
  }
});
