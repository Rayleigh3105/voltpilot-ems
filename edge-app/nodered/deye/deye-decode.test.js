'use strict';

/**
 * Offline tests for the canonical Deye decode module. No hardware, no network:
 * synthetic `+ok=0103...` responses are built from known register arrays and
 * fed through the exact parser/decoder the flow's function nodes copy.
 *
 * Run: node --test edge-app/nodered/deye/
 */

const { test } = require('node:test');
const assert = require('node:assert');

const D = require('./deye-decode.js');

// --- test helpers ------------------------------------------------------------

// crc16 is irrelevant to the parser (it slices exactly byteCount bytes and
// ignores the trailing CRC), so any 4 hex chars stand in for it.
function buildOk(regs) {
  const byteCount = regs.length * 2;
  const bc = byteCount.toString(16).padStart(2, '0').toUpperCase();
  const data = regs.map((r) => (r & 0xffff).toString(16).padStart(4, '0').toUpperCase()).join('');
  return `+ok=0103${bc}${data}ABCD\n`;
}

// A zero-filled block of `count` regs with { absoluteAddr: value } overlaid.
function block(start, count, overrides) {
  const regs = new Array(count).fill(0);
  for (const [addr, val] of Object.entries(overrides)) {
    regs[Number(addr) - start] = val & 0xffff;
  }
  return { start, regs };
}

function blocksFromResponse(start, stdout) {
  return [{ start, regs: D.parseOk(stdout) }];
}

// --- parseOk -----------------------------------------------------------------

test('parseOk decodes the documented sample and drops the CRC', () => {
  // README sample: +ok=01030204017B44 -> byteCount 02, data 0401, crc 7B44.
  assert.deepStrictEqual(D.parseOk('+ok=01030204017B44'), [0x0401]);
});

test('parseOk reads a multi-register block low-to-high', () => {
  assert.deepStrictEqual(D.parseOk(buildOk([0x0001, 0x00ff, 0xabcd])), [0x0001, 0x00ff, 0xabcd]);
});

test('parseOk returns null for junk / truncated / non-string input', () => {
  assert.strictEqual(D.parseOk('no ok here'), null);
  assert.strictEqual(D.parseOk('+ok=010304DEAD'), null); // claims 4 bytes, only 2 present
  assert.strictEqual(D.parseOk(null), null);
});

// --- string family: AC-output-as-generation, 32-bit low-word-first + x0.1 ----
// Per ha-solarman deye_string.yaml a string inverter reports only its "Total
// Output AC Power" (0x0050/0x0051, u32 low-word-first, x0.1 -> W) = generation
// across all MPPTs. It has NO house-load or grid-meter register (hybrid-only),
// so the family exposes pv_power_kw and nothing else.

test('string decode: AC output at 0x0050 (32-bit low-word-first, x0.1) is pv_power_kw', () => {
  const start = 0x0050;
  const count = 0x0002;
  const regs = block(start, count, {
    // AC output raw 50000 (x0.1 = 5000 W = 5 kW). low word first.
    0x0050: 50000 & 0xffff,
    0x0051: (50000 >> 16) & 0xffff,
  });
  const { reading, batt_kw } = D.decode([regs], { family: 'string' });
  assert.strictEqual(reading.pv_power_kw, 5);
  assert.strictEqual('load_kw' in reading, false, 'string inverter has no load meter');
  assert.strictEqual('power_kw' in reading, false, 'string inverter has no grid meter');
  assert.strictEqual('soc_pct' in reading, false, 'string family has no battery -> no soc');
  assert.strictEqual(batt_kw, undefined);
});

// AC output is post-inverter and therefore already the sum of every MPPT string
// (1..4), so a large multi-string plant still decodes from the one 32-bit pair.
test('string decode: AC output already sums all MPPT strings (>32767 via 32-bit)', () => {
  const regs = block(0x0050, 0x0002, {
    0x0050: 200000 & 0xffff, // 20 kW plant (well past int16) -> x0.1 = 20000 W
    0x0051: (200000 >> 16) & 0xffff,
  });
  const { reading } = D.decode([regs], { family: 'string' });
  assert.strictEqual(reading.pv_power_kw, 20);
});

test('string reads are a single small Modbus block within the 125-register max', () => {
  const [r] = D.planReads({ family: 'string' });
  assert.strictEqual(r.start, 0x0050);
  assert.ok(r.count <= 125, 'must not exceed the Modbus fn-0x03 register limit');
  assert.deepStrictEqual(D.readCmd('1.2.3.4:48899', r.start, r.count), [
    '-t',
    '1.2.3.4:48899',
    '-xmb',
    '00500002',
  ]);
});

// --- hybrid_1p ---------------------------------------------------------------

test('hybrid_1p decode: PV1+PV2 summed, SoC percent, signed grid & battery', () => {
  const b = block(0x00a9, 0x16, {
    0x00a9: 3000, // grid import 3000 W -> 3 kW
    0x00b2: 1600, // load 1600 W -> 1.6 kW
    0x00b8: 55, // SoC 55 %
    0x00ba: 1000, // PV1 1000 W
    0x00bb: 700, // PV2 700 W -> sum 1.7 kW
    0x00be: -1200 & 0xffff, // battery -1200 W (discharge) -> -1.2 kW
  });
  const { reading, batt_kw } = D.decode([b], { family: 'hybrid_1p' });
  assert.strictEqual(reading.power_kw, 3);
  assert.strictEqual(reading.load_kw, 1.6);
  assert.strictEqual(reading.soc_pct, 55);
  assert.strictEqual(reading.pv_power_kw, 1.7);
  assert.strictEqual(batt_kw, -1.2);
});

test('hybrid_1p sign inversion flips grid and battery only', () => {
  const b = block(0x00a9, 0x16, {
    0x00a9: 3000,
    0x00b2: 1600,
    0x00b8: 55,
    0x00ba: 1000,
    0x00bb: 700,
    0x00be: -1200 & 0xffff,
  });
  const { reading, batt_kw } = D.decode([b], {
    family: 'hybrid_1p',
    invert_grid_sign: true,
    invert_batt_sign: true,
  });
  assert.strictEqual(reading.power_kw, -3, 'grid sign inverted');
  assert.strictEqual(batt_kw, 1.2, 'battery sign inverted');
  assert.strictEqual(reading.pv_power_kw, 1.7, 'PV untouched by sign flags');
  assert.strictEqual(reading.load_kw, 1.6, 'load untouched by sign flags');
});

test('hybrid_1p read plan is one block 0x00A9..0x00BE', () => {
  const [r] = D.planReads({ family: 'hybrid_1p' });
  assert.strictEqual(r.start, 0x00a9);
  assert.strictEqual(r.count, 0x16);
  assert.deepStrictEqual(D.readCmd('h:48899', r.start, r.count), ['-t', 'h:48899', '-xmb', '00A90016']);
});

// --- hybrid_3p ---------------------------------------------------------------

test('hybrid_3p decode: high-map registers, PV summed, SoC & signs', () => {
  const b = block(0x024c, 0x58, {
    0x024c: 66, // SoC 66 %
    0x024e: 500, // battery +500 W (charge) -> 0.5 kW
    0x0271: 4000, // grid import 4000 W -> 4 kW
    0x028d: 3000, // load 3000 W -> 3 kW
    0x02a0: 3500, // PV1
    0x02a1: 200, // PV2 -> sum 3.7 kW
  });
  const { reading, batt_kw } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.soc_pct, 66);
  assert.strictEqual(reading.power_kw, 4);
  assert.strictEqual(reading.load_kw, 3);
  assert.strictEqual(reading.pv_power_kw, 3.7);
  assert.strictEqual(batt_kw, 0.5);
});

test('hybrid_3p read plan is one block 0x024C..0x02A3 (covers PV1..PV4)', () => {
  const [r] = D.planReads({ family: 'hybrid_3p' });
  assert.strictEqual(r.start, 0x024c);
  assert.strictEqual(r.count, 0x58);
  // last summed PV register (0x02A3) must fall inside the read block
  assert.ok(r.start + r.count - 1 >= 0x02a3, 'read block must reach PV4 at 0x02A3');
});

// --- SG01HP3 (HV, 3-4 MPPT) - the confirmed captain device -------------------
// SUN-29.9/30/35/40/50K-SG01HP3-EU-BM3/BM4. Synthetic 0x024C block modelling a
// midday PV-surplus moment: 4 MPPTs producing, battery charging, grid EXPORTING.
// Proves all four tracker registers are summed and the grid sign flips to export.
test('hybrid_3p SG01HP3: sums all 4 MPPTs and decodes an export moment', () => {
  const b = block(0x024c, 0x58, {
    0x024c: 88, // SoC 88 %
    0x024e: 6000, // battery +6000 W (charging from PV surplus) -> 6 kW
    0x0271: (-12000 & 0xffff), // raw grid -12000 W; with invert_grid_sign -> +12 kW below
    0x028d: 9000, // total load 9000 W -> 9 kW
    0x02a0: 12000, // PV1 12 kW
    0x02a1: 11000, // PV2 11 kW
    0x02a2: 3000, // PV3  3 kW
    0x02a3: 1000, // PV4  1 kW  -> total 27 kW
  });
  // Raw (no sign flip): grid reads -12 kW (this firmware's raw export sign).
  const raw = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(raw.reading.soc_pct, 88);
  assert.strictEqual(raw.reading.pv_power_kw, 27, 'PV1+PV2+PV3+PV4 summed');
  assert.strictEqual(raw.reading.load_kw, 9);
  assert.strictEqual(raw.reading.power_kw, -12);
  assert.strictEqual(raw.batt_kw, 6, 'battery charge (calibration field only)');
  // With invert_grid_sign the export reads as a negative import per the contract
  // convention (+ import / - export) - here the raw was already negative, so the
  // flag makes it positive; the flag is the on-device grid-sign calibration lever.
  const flipped = D.decode([b], { family: 'hybrid_3p', invert_grid_sign: true });
  assert.strictEqual(flipped.reading.power_kw, 12, 'invert_grid_sign flips grid only');
  assert.strictEqual(flipped.reading.pv_power_kw, 27, 'PV untouched by sign flags');
});

// A BM3 (3-MPPT) unit has no PV4 wired: register 0x02A3 reads 0 and the sum is
// still correct - proves the 4-register sum is safe on 3-MPPT hardware.
test('hybrid_3p BM3: absent PV4 (0x02A3=0) does not corrupt the PV sum', () => {
  const b = block(0x024c, 0x58, {
    0x024c: 50,
    0x02a0: 5000,
    0x02a1: 4000,
    0x02a2: 1000, // 3 trackers -> 10 kW, PV4 absent (0)
  });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.pv_power_kw, 10);
});

// --- end-to-end through a synthetic tool response ----------------------------

test('full path: buildOk -> parseOk -> decode reproduces the reading', () => {
  const start = 0x00a9;
  const regs = new Array(0x16).fill(0);
  regs[0x00a9 - start] = 2500; // grid 2.5 kW
  regs[0x00b8 - start] = 80; // SoC 80 %
  regs[0x00ba - start] = 2000; // PV1
  regs[0x00bb - start] = 1500; // PV2 -> 3.5 kW
  const stdout = buildOk(regs);
  const blocks = blocksFromResponse(start, stdout);
  const { reading } = D.decode(blocks, { family: 'hybrid_1p' });
  assert.strictEqual(reading.power_kw, 2.5);
  assert.strictEqual(reading.soc_pct, 80);
  assert.strictEqual(reading.pv_power_kw, 3.5);
});

// --- power-limit write -------------------------------------------------------

test('powerLimitCmd builds the documented 0x0028 write and clamps 0..100', () => {
  assert.deepStrictEqual(D.powerLimitCmd('1.2.3.4:48899', 100).args, [
    '-t',
    '1.2.3.4:48899',
    '-xmbw',
    '00280001020064',
  ]);
  assert.strictEqual(D.powerLimitCmd('h', 150).pct, 100); // clamp high
  assert.strictEqual(D.powerLimitCmd('h', -5).pct, 0); // clamp low
  assert.strictEqual(D.powerLimitCmd('h', 66.6).pct, 67); // round
});

test('powerLimitCmd snaps to operator stage granularity when provided', () => {
  const stages = [0, 30, 60, 100];
  assert.strictEqual(D.powerLimitCmd('h', 44, stages).pct, 30); // nearest stage below
  assert.strictEqual(D.powerLimitCmd('h', 46, stages).pct, 60); // nearest stage above
  assert.strictEqual(D.powerLimitCmd('h', 100, stages).pct, 100);
});

// --- hybrid family auto-detect ----------------------------------------------

test('detectHybridFamily picks the map whose SoC probe reads a sane 0..100', () => {
  const low = buildOk([55]); // 0x00B8 probe -> 55 %
  const high = buildOk([304]); // 0x024C probe -> 304, out of range
  assert.strictEqual(D.detectHybridFamily(low, high), 'hybrid_1p');
  assert.strictEqual(D.detectHybridFamily(buildOk([9000]), buildOk([66])), 'hybrid_3p');
});

test('detectHybridFamily returns null when both/neither look sane', () => {
  assert.strictEqual(D.detectHybridFamily(buildOk([50]), buildOk([50])), null); // ambiguous
  assert.strictEqual(D.detectHybridFamily('junk', 'junk'), null); // neither parses
});

// --- micro -------------------------------------------------------------------
// ha-solarman deye_2mppt/deye_4mppt (SUN600..2000G3): generation is the single
// "Total AC Output Power (Active)" pair at 0x0056/0x0057 (u32 low-word, x0.1).
// No battery, grid or load. Also keeps the 0x0028 active-power-limit write.

test('micro decode: AC output at 0x0056 (32-bit low-word-first, x0.1) is pv_power_kw', () => {
  const regs = block(0x0056, 0x0002, {
    0x0056: 6000 & 0xffff, // raw 6000 x0.1 = 600 W = 0.6 kW (a SUN600G3 at peak)
    0x0057: (6000 >> 16) & 0xffff,
  });
  const { reading, batt_kw } = D.decode([regs], { family: 'micro' });
  assert.strictEqual(reading.pv_power_kw, 0.6);
  assert.strictEqual('load_kw' in reading, false);
  assert.strictEqual('power_kw' in reading, false);
  assert.strictEqual('soc_pct' in reading, false);
  assert.strictEqual(batt_kw, undefined);
});

test('micro read plan is one block at 0x0056 and still supports the 0x0028 limit write', () => {
  const [r] = D.planReads({ family: 'micro' });
  assert.strictEqual(r.start, 0x0056);
  assert.strictEqual(r.count, 0x0002);
  assert.deepStrictEqual(D.readCmd('h:8899', r.start, r.count), ['-t', 'h:8899', '-xmb', '00560002']);
  // active-power-limit write path is unchanged for micro
  assert.deepStrictEqual(D.powerLimitCmd('h:8899', 50).args, ['-t', 'h:8899', '-xmbw', '0028000102' + '0032']);
});

// --- hybrid_3p HV decawatt-scaling lever (power_scale, VERIFY-on-device) ------
// Default scale is 1 W (ha-solarman). An HV firmware that reports decawatts is
// handled by config `power_scale: 10` - no map/code edit. It scales every power
// field (pv/grid/load/batt) but never SoC.

test('power_scale multiplies all power fields but leaves SoC untouched', () => {
  const b = block(0x024c, 0x58, {
    0x024c: 77, // SoC 77 %
    0x024e: 300, // batt raw 300
    0x0271: 1500, // grid raw 1500
    0x028d: 900, // load raw 900
    0x02a0: 2000, // PV1 raw 2000
    0x02a1: 500, // PV2 raw 500 -> raw sum 2500
  });
  const scaled = D.decode([b], { family: 'hybrid_3p', power_scale: 10 });
  // raw W x10 /1000 -> kW
  assert.strictEqual(scaled.reading.pv_power_kw, 25, '2500 raw x10 = 25 kW');
  assert.strictEqual(scaled.reading.power_kw, 15, '1500 raw x10 = 15 kW');
  assert.strictEqual(scaled.reading.load_kw, 9, '900 raw x10 = 9 kW');
  assert.strictEqual(scaled.batt_kw, 3, '300 raw x10 = 3 kW');
  assert.strictEqual(scaled.reading.soc_pct, 77, 'SoC is a percent, never power-scaled');
  // default (scale 1) is the #49-verified behavior
  const plain = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(plain.reading.pv_power_kw, 2.5);
  assert.strictEqual(plain.reading.power_kw, 1.5);
});
