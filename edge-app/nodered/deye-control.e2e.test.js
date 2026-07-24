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
            respMb = SV5.writeSingleRegisterRequest(slave, reg, opts.dropWrites ? (store[reg] || 0) : value); // FC6 echo
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

async function runExec(func, msg, ctxStore = {}, flowStore = {}) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, log() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get: (k) => flowStore[k], set: (k, v) => { flowStore[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : undefined) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
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
