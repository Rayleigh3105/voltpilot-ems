'use strict';

// Offline unit tests for huawei-decode.js (node --test, no hardware/network
// except an in-process TCP server for the reader factory). Register vectors
// follow the sourced field documentation - see the module header + firstmate
// data/vp-kundenanlage-huawei-s1/report.md.

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const huawei = require('./huawei-decode');

// --- vector helpers ----------------------------------------------------------

const u16 = (v) => v & 0xffff;

// i32 -> [hiWord, loWord] - ALWAYS big-endian with the high word first (the
// documented trap; unlike KOSTAL there is no byte-order register).
function i32words(value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

// Build the block list of one poll as the device would answer it. `regs` maps
// absolute address -> u16 value; unset addresses inside a block read as 0.
function blocksFrom(regs, opts) {
  opts = opts || {};
  const plan = huawei.planReads({ family: 'huawei_sun2000_luna' });
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

// A healthy SUN2000-3KTL-M1 + LUNA2000 image: PV input 2,5 kW, AC active power
// 1,8 kW (lower than PV because the LUNA2000 is charging), grid meter
// importing 0,3 kW, SoC 62,5 %, battery CHARGING 0,7 kW, running status 2.
function healthyRegs() {
  const regs = {
    [huawei.REG.BATTERY_SOC_PCT_X10]: 625,
    [huawei.REG.BATTERY_RUNNING_STATUS]: 2,
  };
  const put2 = (addr, value) => {
    const [hi, lo] = i32words(value);
    regs[addr] = hi;
    regs[addr + 1] = lo;
  };
  put2(huawei.REG.INPUT_POWER_W, 2500);
  put2(huawei.REG.ACTIVE_POWER_W, 1800);
  put2(huawei.REG.METER_ACTIVE_POWER_W, 300);
  put2(huawei.REG.BATTERY_CHARGE_DISCHARGE_POWER_W, 700);
  return regs;
}

// --- planReads ---------------------------------------------------------------

test('planReads covers exactly the documented blocks and nothing for unknown families', () => {
  const plan = huawei.planReads({ family: 'huawei_sun2000_luna' });
  assert.deepStrictEqual(plan.map((b) => [b.start, b.count]), [
    [32064, 2],
    [32080, 2],
    [37113, 2],
    [37760, 7],
  ]);
  for (const b of plan) assert.ok(b.count <= 125);
  assert.deepStrictEqual(huawei.planReads({ family: 'kostal_plenticore' }), []);
  assert.deepStrictEqual(huawei.planReads({}), []);
});

// --- decode: the sign conventions --------------------------------------------

test('decode maps the healthy image with the documented signs', () => {
  const out = huawei.decode(blocksFrom(healthyRegs()), {});
  assert.ok(out);
  // PV comes from the DC-side input power (32064), never the AC side (32080) -
  // the KACO-hybrid lesson: on a hybrid the AC side already nets out the
  // battery.
  assert.strictEqual(out.reading.pv_power_kw, 2.5);
  assert.strictEqual(out.reading.soc_pct, 62.5);
  assert.strictEqual(out.reading.power_kw, 0.3);
  // Field source: "+ charging" already matches VoltPilot's own convention.
  assert.strictEqual(out.battKw, 0.7);
  assert.strictEqual(out.meta.active_power_w, 1800);
  assert.strictEqual(out.meta.battery_running_status, 2);
});

test('decode negative registers (discharge, export) read negative, and the invert hatches flip', () => {
  const regs = healthyRegs();
  const [hi, lo] = i32words(-700); // discharging 0,7 kW
  regs[huawei.REG.BATTERY_CHARGE_DISCHARGE_POWER_W] = hi;
  regs[huawei.REG.BATTERY_CHARGE_DISCHARGE_POWER_W + 1] = lo;
  const [ghi, glo] = i32words(-300); // exporting 0,3 kW
  regs[huawei.REG.METER_ACTIVE_POWER_W] = ghi;
  regs[huawei.REG.METER_ACTIVE_POWER_W + 1] = glo;

  let out = huawei.decode(blocksFrom(regs), {});
  assert.strictEqual(out.battKw, -0.7);
  assert.strictEqual(out.reading.power_kw, -0.3);

  out = huawei.decode(blocksFrom(regs), { invertBattSign: true });
  assert.strictEqual(out.battKw, 0.7);
  out = huawei.decode(blocksFrom(regs), { invertGridSign: true });
  assert.strictEqual(out.reading.power_kw, 0.3);
});

// --- decode: honesty rules ---------------------------------------------------

test('decode drops an implausible SoC instead of fabricating (socPlausible discipline)', () => {
  for (const bad of [0, 1010, 12700, 0xffff]) {
    const regs = healthyRegs();
    regs[huawei.REG.BATTERY_SOC_PCT_X10] = u16(bad);
    const out = huawei.decode(blocksFrom(regs), {});
    assert.strictEqual(out.reading.soc_pct, undefined, 'SoC-Rohwert ' + bad + ' muss verworfen werden');
    // the other channels survive
    assert.strictEqual(out.reading.pv_power_kw, 2.5);
  }
});

test('decode degrades per block and returns null only when nothing decoded', () => {
  // Grid meter block missing (no Smart Power Sensor installed) -> power_kw
  // absent, every other channel still present.
  const noMeter = huawei.decode(blocksFrom(healthyRegs(), { omit: [37113] }), {});
  assert.ok(noMeter);
  assert.strictEqual(noMeter.reading.power_kw, undefined);
  assert.strictEqual(noMeter.reading.pv_power_kw, 2.5);
  assert.strictEqual(noMeter.battKw, 0.7);

  // Battery block missing -> SoC/battery absent, PV still present.
  const noBatt = huawei.decode(blocksFrom(healthyRegs(), { omit: [37760] }), {});
  assert.ok(noBatt);
  assert.strictEqual(noBatt.battKw, null);
  assert.strictEqual(noBatt.reading.soc_pct, undefined);
  assert.strictEqual(noBatt.reading.pv_power_kw, 2.5);

  // Nothing at all -> null, never an empty fabricated reading.
  assert.strictEqual(huawei.decode([], {}), null);
  assert.strictEqual(huawei.decode(null, {}), null);
});

// --- makeHuaweiReader against an in-process Modbus-TCP server ---------------

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

test('makeHuaweiReader reads the whole plan over one socket and decodes it', async () => {
  const { server, port } = await startServer(healthyRegs());
  try {
    const read = huawei.makeHuaweiReader({ net, connectTimeoutMs: 2000, readTimeoutMs: 2000 });
    const out = await read({ ip: '127.0.0.1', port, unitId: 0 });
    assert.ok(out);
    assert.strictEqual(out.reading.pv_power_kw, 2.5);
    assert.strictEqual(out.reading.power_kw, 0.3);
    assert.strictEqual(out.reading.soc_pct, 62.5);
    assert.strictEqual(out.battKw, 0.7);
  } finally {
    server.close();
  }
});

test('makeHuaweiReader isolates a refused block and returns null when unreachable', async () => {
  // The grid meter block is refused (exception) - the reading degrades to the
  // PV/battery channels instead of failing wholesale (no Smart Power Sensor
  // installed is an expected field situation, not a comms error).
  const { server, port } = await startServer(healthyRegs(), { refuse: [37113] });
  try {
    const read = huawei.makeHuaweiReader({ net, connectTimeoutMs: 2000, readTimeoutMs: 2000 });
    const out = await read({ ip: '127.0.0.1', port, unitId: 0 });
    assert.ok(out);
    assert.strictEqual(out.reading.power_kw, undefined);
    assert.strictEqual(out.reading.pv_power_kw, 2.5);
    assert.strictEqual(out.battKw, 0.7);
  } finally {
    server.close();
  }

  const read = huawei.makeHuaweiReader({ net, connectTimeoutMs: 300, readTimeoutMs: 300 });
  assert.strictEqual(await read({ ip: '127.0.0.1', port: 1 }), null);
  assert.strictEqual(await read({}), null);
});
