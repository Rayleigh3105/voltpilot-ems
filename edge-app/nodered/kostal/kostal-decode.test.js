'use strict';

// Offline unit tests for kostal-decode.js (node --test, no hardware/network
// except an in-process TCP server for the reader factory). Register vectors
// follow the official interface description (Rev. 2.9) - see the module
// header + firstmate data/vp-kostal-plenticore-s5/report.md.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const kostal = require('./kostal-decode');

// --- vector helpers ----------------------------------------------------------

// float32 -> [wordAtAddr, wordAtAddr+1] per byte order ('little' = CDAB, the
// factory default: LOW word first on the wire).
function f32words(value, order) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  const hi = buf.readUInt16BE(0);
  const lo = buf.readUInt16BE(2);
  return order === 'big' ? [hi, lo] : [lo, hi];
}

const u16 = (v) => v & 0xffff;

// Build the block list of one poll as the device would answer it. `regs` maps
// absolute address -> u16 value; unset addresses inside a block read as 0.
function blocksFrom(regs, opts) {
  opts = opts || {};
  const plan = kostal.planReads({ family: 'kostal_plenticore' });
  const blocks = [];
  for (const b of plan) {
    if (opts.omit && opts.omit.includes(b.start)) continue;
    const out = [];
    for (let i = 0; i < b.count; i++) {
      const v = regs[b.start + i];
      out.push(v === undefined ? 0 : u16(v));
    }
    blocks.push({ start: b.start, regs: out });
  }
  return blocks;
}

// A healthy PLENTICORE BI 10/26 image: byte order little (0), state 6 (FeedIn),
// KSEM at the grid connection point importing 1.5 kW, SoC 87 %, battery
// CHARGING 2 kW (register -2000: negative = charge per doc note 1), BYD
// battery, external Modbus management active, BMS limits 9 kW / 10 kW.
function healthyRegs(order) {
  const regs = {
    [kostal.REG.BYTE_ORDER]: order === 'big' ? 1 : 0,
    [kostal.REG.BATTERY_SOC_PCT]: 87,
    [kostal.REG.INVERTER_MAX_POWER_W]: 10000,
    [kostal.REG.BATTERY_POWER_W]: u16(-2000),
    [kostal.REG.BATTERY_TYPE]: 0x0004, // BYD
    [kostal.REG.BATTERY_MGMT_MODE]: kostal.MGMT_MODE_EXTERNAL_MODBUS,
    [kostal.REG.SENSOR_TYPE]: 0x03, // KSEM
  };
  const put2 = (addr, value) => {
    const [w0, w1] = f32words(value, order);
    regs[addr] = w0;
    regs[addr + 1] = w1;
  };
  put2(kostal.REG.POWERMETER_TOTAL_W, 1500); // + Bezug (sensor position 2)
  put2(kostal.REG.BMS_MAX_CHARGE_W, 9000);
  put2(kostal.REG.BMS_MAX_DISCHARGE_W, 10000);
  put2(kostal.REG.BATTERY_WORK_CAPACITY_WH, 10240);
  // state 6 as U32 in the same word order
  const stateWords = order === 'big' ? [0, 6] : [6, 0];
  regs[kostal.REG.INVERTER_STATE] = stateWords[0];
  regs[kostal.REG.INVERTER_STATE + 1] = stateWords[1];
  return regs;
}

// --- planReads ---------------------------------------------------------------

test('planReads covers exactly the documented blocks and nothing for unknown families', () => {
  const plan = kostal.planReads({ family: 'kostal_plenticore' });
  assert.deepStrictEqual(plan.map((b) => [b.start, b.count]), [
    [5, 1],
    [56, 2],
    [252, 2],
    [514, 75],
    [1068, 16],
  ]);
  // 514 + 75 - 1 = 588 (battery type), 1068 + 16 - 1 = 1083 - each block ends
  // exactly on its last needed register and stays far under the FC3 cap of 125.
  for (const b of plan) assert.ok(b.count <= 125);
  assert.deepStrictEqual(kostal.planReads({ family: 'hybrid_3p' }), []);
  assert.deepStrictEqual(kostal.planReads({}), []);
});

// --- decode: the sign conventions --------------------------------------------

test('decode maps the healthy little-endian (factory default) image with the documented signs', () => {
  const out = kostal.decode(blocksFrom(healthyRegs('little')), {});
  assert.ok(out);
  // Kostal register: -2000 = CHARGING 2 kW -> VoltPilot battery_power_kw + charge.
  assert.strictEqual(out.battKw, 2);
  assert.strictEqual(out.reading.soc_pct, 87);
  // KSEM position 2: +1500 W = Bezug = VoltPilot +import.
  assert.strictEqual(out.reading.power_kw, 1.5);
  // The BI has no PV and no load channel - absent, never fabricated.
  assert.strictEqual(out.reading.pv_power_kw, undefined);
  assert.strictEqual(out.reading.load_kw, undefined);
  assert.strictEqual(out.meta.byte_order, 'little');
  assert.strictEqual(out.meta.state, 6);
  assert.strictEqual(out.meta.inverter_max_power_w, 10000);
  assert.strictEqual(out.meta.battery_type, 0x0004);
  assert.strictEqual(out.meta.battery_mgmt_mode, kostal.MGMT_MODE_EXTERNAL_MODBUS);
  assert.strictEqual(out.meta.bms_max_charge_w, 9000);
  assert.strictEqual(out.meta.bms_max_discharge_w, 10000);
  assert.strictEqual(out.meta.battery_work_capacity_wh, 10240);
});

test('decode discharge reads negative in VoltPilot convention and the invert hatches flip', () => {
  const regs = healthyRegs('little');
  regs[kostal.REG.BATTERY_POWER_W] = u16(3000); // Kostal +3000 = discharge
  let out = kostal.decode(blocksFrom(regs), {});
  assert.strictEqual(out.battKw, -3);
  out = kostal.decode(blocksFrom(regs), { invertBattSign: true });
  assert.strictEqual(out.battKw, 3);
  out = kostal.decode(blocksFrom(regs), { invertGridSign: true });
  assert.strictEqual(out.reading.power_kw, -1.5);
});

test('decode honors the big-endian byte order from register 5 and an explicit override wins', () => {
  const out = kostal.decode(blocksFrom(healthyRegs('big')), {});
  assert.ok(out);
  assert.strictEqual(out.meta.byte_order, 'big');
  assert.strictEqual(out.reading.power_kw, 1.5);
  assert.strictEqual(out.meta.state, 6);
  // Explicit override beats register 5: decoding the big image as 'little'
  // garbles the float - the finite/plausibility gates then DROP the channel
  // instead of publishing a plausible-but-wrong number.
  const forced = kostal.decode(blocksFrom(healthyRegs('big')), { byteOrder: 'little' });
  assert.strictEqual(forced.meta.byte_order, 'little');
  assert.notStrictEqual(forced.reading.power_kw, 1.5);
});

// --- decode: honesty rules ---------------------------------------------------

test('decode drops an implausible SoC instead of fabricating (socPlausible discipline)', () => {
  for (const bad of [0, 101, 1270, 0xffff]) {
    const regs = healthyRegs('little');
    regs[kostal.REG.BATTERY_SOC_PCT] = u16(bad);
    const out = kostal.decode(blocksFrom(regs), {});
    assert.strictEqual(out.reading.soc_pct, undefined, 'SoC ' + bad + ' must be dropped');
    // the other channels survive
    assert.strictEqual(out.battKw, 2);
  }
});

test('decode publishes NO grid power without an installed sensor', () => {
  // Sensor type 0xFF = "no sensor": register 252 would read a fabricated 0.
  const regs = healthyRegs('little');
  regs[kostal.REG.SENSOR_TYPE] = kostal.SENSOR_NONE;
  let out = kostal.decode(blocksFrom(regs), {});
  assert.strictEqual(out.reading.power_kw, undefined);
  assert.strictEqual(out.battKw, 2); // battery unaffected
  // Sensor register unreadable (block missing) -> same honesty.
  out = kostal.decode(blocksFrom(healthyRegs('little'), { omit: [1068] }), {});
  assert.strictEqual(out.reading.power_kw, undefined);
});

test('decode degrades per block and returns null only when nothing decoded', () => {
  // Battery block missing -> soc/battery absent, grid still present.
  const noBatt = kostal.decode(blocksFrom(healthyRegs('little'), { omit: [514] }), {});
  assert.ok(noBatt);
  assert.strictEqual(noBatt.battKw, null);
  assert.strictEqual(noBatt.reading.soc_pct, undefined);
  assert.strictEqual(noBatt.reading.power_kw, 1.5);
  // Nothing at all -> null, never an empty fabricated reading.
  assert.strictEqual(kostal.decode([], {}), null);
  assert.strictEqual(kostal.decode(null, {}), null);
});

test('resolveByteOrder: explicit wins, register decides on auto, little is the fallback', () => {
  assert.strictEqual(kostal.resolveByteOrder('big', 0), 'big');
  assert.strictEqual(kostal.resolveByteOrder('little', 1), 'little');
  assert.strictEqual(kostal.resolveByteOrder('auto', 1), 'big');
  assert.strictEqual(kostal.resolveByteOrder('auto', 0), 'little');
  assert.strictEqual(kostal.resolveByteOrder(undefined, null), 'little');
});

// --- makeKostalReader against an in-process Modbus-TCP server ----------------

// A minimal Modbus-TCP server answering FC3 from an absolute register image.
// `refuse` lists block start addresses answered with exception 0x02.
function startServer(regs, opts) {
  opts = opts || {};
  const server = net.createServer((sock) => {
    let acc = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 6) {
        const need = 6 + acc.readUInt16BE(4);
        if (acc.length < need) return;
        const frame = acc.slice(0, need);
        acc = acc.slice(need);
        const txid = frame.readUInt16BE(0);
        const unit = frame[6];
        const fn = frame[7];
        const addr = frame.readUInt16BE(8);
        const count = frame.readUInt16BE(10);
        if (fn !== 0x03 || (opts.refuse || []).includes(addr)) {
          const ex = Buffer.alloc(9);
          ex.writeUInt16BE(txid, 0);
          ex.writeUInt16BE(0, 2);
          ex.writeUInt16BE(3, 4);
          ex[6] = unit;
          ex[7] = fn | 0x80;
          ex[8] = 0x02;
          sock.write(ex);
          continue;
        }
        const body = Buffer.alloc(9 + count * 2);
        body.writeUInt16BE(txid, 0);
        body.writeUInt16BE(0, 2);
        body.writeUInt16BE(3 + count * 2, 4);
        body[6] = unit;
        body[7] = 0x03;
        body[8] = count * 2;
        for (let i = 0; i < count; i++) {
          const v = regs[addr + i];
          body.writeUInt16BE(v === undefined ? 0 : u16(v), 9 + i * 2);
        }
        sock.write(body);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('makeKostalReader reads the whole plan over one socket and decodes it', async () => {
  const { server, port } = await startServer(healthyRegs('little'));
  try {
    const read = kostal.makeKostalReader({ net, connectTimeoutMs: 2000, readTimeoutMs: 2000 });
    const out = await read({ ip: '127.0.0.1', port, unitId: 71 });
    assert.ok(out);
    assert.strictEqual(out.battKw, 2);
    assert.strictEqual(out.reading.power_kw, 1.5);
    assert.strictEqual(out.reading.soc_pct, 87);
    assert.strictEqual(out.meta.battery_mgmt_mode, kostal.MGMT_MODE_EXTERNAL_MODBUS);
  } finally {
    server.close();
  }
});

test('makeKostalReader isolates a refused block and returns null when unreachable', async () => {
  // The grid block is refused (exception) - the reading degrades to the
  // battery channels instead of failing wholesale.
  const { server, port } = await startServer(healthyRegs('little'), { refuse: [252] });
  try {
    const read = kostal.makeKostalReader({ net, connectTimeoutMs: 2000, readTimeoutMs: 2000 });
    const out = await read({ ip: '127.0.0.1', port, unitId: 71 });
    assert.ok(out);
    assert.strictEqual(out.reading.power_kw, undefined);
    assert.strictEqual(out.battKw, 2);
  } finally {
    server.close();
  }
  // Unreachable port -> null (idle-safe, never fabricated).
  const read = kostal.makeKostalReader({ net, connectTimeoutMs: 300, readTimeoutMs: 300 });
  const out = await read({ ip: '127.0.0.1', port: 1 });
  assert.strictEqual(out, null);
});
