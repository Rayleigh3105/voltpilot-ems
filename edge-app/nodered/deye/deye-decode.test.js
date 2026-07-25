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
  const b = block(0x024c, 0x67, {
    0x024c: 66, // SoC 66 %
    0x024e: 500, // battery +500 W (charge) -> 0.5 kW
    0x0271: 4000, // grid import low word 4000 W -> 4 kW (high 0x02B2 = 0)
    0x028d: 3000, // load low word 3000 W -> 3 kW (high 0x0293 = 0)
    0x02a0: 3500, // PV1
    0x02a1: 200, // PV2 -> sum 3.7 kW
  });
  // No device register in the blocks -> scale falls back to 1 (LV/native watts).
  const { reading, batt_kw } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.soc_pct, 66);
  assert.strictEqual(reading.power_kw, 4);
  assert.strictEqual(reading.load_kw, 3);
  assert.strictEqual(reading.pv_power_kw, 3.7);
  assert.strictEqual(batt_kw, 0.5);
});

test('hybrid_3p read plan is [device 0x0000, measurement 0x024C..0x02C4]', () => {
  const reads = D.planReads({ family: 'hybrid_3p' });
  assert.strictEqual(reads.length, 2, 'device-identity block + measurement block');
  assert.deepStrictEqual(reads[0], { start: 0x0000, count: 0x0001 }, 'device register 0x0000');
  const m = reads[1];
  assert.strictEqual(m.start, 0x024c);
  assert.ok(m.count <= 125, 'must not exceed the Modbus fn-0x03 register limit');
  const last = m.start + m.count - 1;
  assert.ok(last >= 0x02a3, 'read block must reach PV4 at 0x02A3');
  assert.ok(last >= 0x02c4, 'read block must reach the External-CT high word at 0x02C4');
  assert.ok(last >= 0x02b2, 'read block must cover the fallback Grid-alias high word at 0x02B2');
  assert.ok(last >= 0x0293, 'read block must reach the 32-bit Load high word at 0x0293');
});

// --- the connection-point grid register (captain's live falsification) -------
// deye_p3.yaml carries THREE grid measurements: "Internal Power" 0x025F/0x02BF
// (inverter-side), "External Power" 0x026B/0x02C4 (the external CT at the
// point of common coupling), and "Grid Power" 0x0271/0x02B2 under the comment
// "The following three (four) registers change according to the built-in and
// external settings" - a CONFIG-DEPENDENT alias. On the captain's SUN-30K
// (2026-07-17) the alias read −23,7 kW (exactly the Deye's own PV = the
// inverter-side value) while the true connection-point export was 54,2 kW
// (whole site incl. ~49 kW AC-coupled Fronius; the Deye's own load register
// −30,5 = 23,7 − 54,2 proves the device itself used the external CT). The
// decode must therefore report the EXTERNAL CT total as power_kw.
test('hybrid_3p grid comes from the External CT (0x026B/0x02C4), not the alias', () => {
  const b = block(0x024c, 0x79, {
    0x024c: 53, // SoC 53 %
    0x024e: 0, // battery register 0 (idle) - the measured house-balance term
    0x026b: (-54200 & 0xffff), // External CT low word ...
    0x02c4: 0xffff, // ... + high word -> s32 −54 200 W = the true site export
    0x0271: (-23700 & 0xffff), // the alias reads the inverter-side −23,7 kW
    0x02b2: 0xffff,
    0x028d: (-30500 & 0xffff), // the Deye's own internally-netted load −30,5 kW
    0x0293: 0xffff,
    0x02a0: 23700, // the Deye's own PV 23,7 kW
  });
  const { reading, batt_kw } = D.decode([b], { family: 'hybrid_3p', power_scale: 1 });
  assert.strictEqual(reading.power_kw, -54.2, 'connection-point export, never the alias −23,7');
  assert.strictEqual(reading.pv_power_kw, 23.7);
  assert.strictEqual(reading.load_kw, -30.5, 'raw load forwarded for the fold to judge');
  assert.strictEqual(batt_kw, 0, 'measured battery register (read, never derived)');
});

// A read that does not cover the external pair (a stale flow still reading the
// pre-standard 0x024C..0x02B2 block) falls back to the alias instead of losing
// the grid channel entirely.
test('hybrid_3p grid falls back to the 0x0271 alias on the old narrower block', () => {
  const b = block(0x024c, 0x67, {
    0x024c: 53,
    0x0271: 4000, // alias import 4 kW; external high word 0x02C4 not in block
  });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.power_kw, 4, 'alias fallback keeps the grid channel alive');
});

// --- SG01HP3 (HV, 3-4 MPPT) - the confirmed captain device -------------------
// SUN-29.9/30/35/40/50K-SG01HP3-EU-BM3/BM4. Synthetic 0x024C block modelling a
// midday PV-surplus moment: 4 MPPTs producing, battery charging, grid EXPORTING.
// Proves all four tracker registers are summed and the grid sign flips to export.
test('hybrid_3p SG01HP3: sums all 4 MPPTs and decodes an export moment', () => {
  const b = block(0x024c, 0x67, {
    0x024c: 88, // SoC 88 %
    0x024e: 6000, // battery +6000 W (charging from PV surplus) -> 6 kW
    0x0271: (-12000 & 0xffff), // grid low word; high word (0x02B2) sign-extends below
    0x02b2: 0xffff, // grid high word -> full s32 -12000 W; with invert_grid_sign -> +12 kW
    0x028d: 9000, // total load low word 9000 W -> 9 kW (high 0x0293 = 0)
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

// --- the captain's live SUN-30K-SG01HP3-EU: raw charge sign is NEGATIVE --------
// The First-Light verdict hole (2026-07-25): while this HV device was CHARGING at
// ~+31 kW (the cockpit's balance-derived battery agreed), the raw battery register
// 0x024E reported a NEGATIVE value, so the decoded battery_power_kw was inverted vs
// the documented + charge / - discharge convention. The calibration verdict trusted
// that inverted measurement and declared "Richtung stimmt". The raw Deye battery
// sign is FIRMWARE-DEPENDENT (DEYE.md: sunsynk inverts vs ha-solarman raw), so the
// fix is the operator-set invert_batt_sign escape hatch - NOT a silent universal
// flip. This pins the boundary: charging -> POSITIVE once invert_batt_sign is set.
test('hybrid_3p SG01HP3 (HV): a charge that reads negative raw decodes to POSITIVE with invert_batt_sign', () => {
  // Device register 0x0008 = "HV 3-Phase Inverter 20-50kw" -> auto scale x10.
  const dev = block(0x0000, 1, { 0x0000: 0x0008 });
  // 0x024E raw = -3100 decawatts: this firmware reports the +31 kW charge as a
  // negative register value (the captain's card showed "BATTERIE JETZT -30 kW"
  // while the cockpit showed the battery CHARGING at 31 kW).
  const b = block(0x024c, 0x79, {
    0x024c: 53, // SoC 53 % (rising - the battery was charging)
    0x024e: (-3100 & 0xffff), // raw charge sign is NEGATIVE on this HV firmware
    0x026b: (-37600 & 0xffff), // External CT: 37,6 kW export (PV surplus)
    0x02c4: 0xffff,
    0x02a0: 78700, // PV low word part; enough to model the surplus (scale x10 below)
  });

  // DEFAULT (invert_batt_sign unset): the bug - a charge decodes NEGATIVE, the
  // exact inverted measurement the verdict wrongly trusted.
  const raw = D.decode([dev, b], { family: 'hybrid_3p' });
  assert.strictEqual(raw.batt_kw, -31, 'HV x10 auto-detected; raw charge sign is negative on this firmware');

  // FIX: with the operator-set read-side flag the charge decodes POSITIVE, matching
  // the documented + charge / - discharge convention and the cockpit.
  const fixed = D.decode([dev, b], { family: 'hybrid_3p', invert_batt_sign: true });
  assert.strictEqual(fixed.batt_kw, 31, 'invert_batt_sign yields charge -> positive (owner\'s real numbers)');
  // Sign flip touches the battery ONLY - SoC/PV/grid are untouched by it.
  assert.strictEqual(fixed.reading.soc_pct, 53);
  assert.strictEqual(raw.reading.soc_pct, fixed.reading.soc_pct);
  assert.strictEqual(raw.reading.power_kw, fixed.reading.power_kw, 'grid untouched by invert_batt_sign');
});

// A BM3 (3-MPPT) unit has no PV4 wired: register 0x02A3 reads 0 and the sum is
// still correct - proves the 4-register sum is safe on 3-MPPT hardware.
test('hybrid_3p BM3: absent PV4 (0x02A3=0) does not corrupt the PV sum', () => {
  const b = block(0x024c, 0x67, {
    0x024c: 50,
    0x02a0: 5000,
    0x02a1: 4000,
    0x02a2: 1000, // 3 trackers -> 10 kW, PV4 absent (0)
  });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.pv_power_kw, 10);
});

// --- "a discharging battery must not raise pv_power_kw" (permanent guard) ----
// Regression fixture for the 2026-07-21 PV incident (data/vp-pv-battery-bug §7
// item 2). The Deye decode is provably clean - PV is the sum of the four MPPT
// DC registers 0x02A0..0x02A3 and the battery lives at 0x024E, disjoint fields -
// but nothing PINNED that, so a future map edit could silently couple them. This
// sweeps the battery register across a full discharge while every other register
// stays put and asserts pv_power_kw is bit-identical throughout.
test('hybrid_3p: sweeping the battery register 0 -> -20 kW never moves pv_power_kw', () => {
  const pv = [];
  const batt = [];
  for (const watts of [0, -2000, -5000, -12000, -20000, 6000]) {
    const b = block(0x024c, 0x79, {
      0x024c: 62, // SoC steady
      0x024e: watts & 0xffff, // the ONLY register that changes
      0x026b: 4000, // External CT grid import (high word 0x02C4 = 0)
      0x028d: 7000, // load low word (high 0x0293 = 0)
      0x02a0: 3000,
      0x02a1: 900,
      0x02a2: 100, // MPPT sum = 4.0 kW, constant
    });
    const { reading, batt_kw } = D.decode([b], { family: 'hybrid_3p', power_scale: 1 });
    pv.push(reading.pv_power_kw);
    batt.push(batt_kw);
  }
  assert.deepStrictEqual(pv, [4, 4, 4, 4, 4, 4], 'PV is the MPPT sum, immune to the battery');
  assert.deepStrictEqual(batt, [0, -2, -5, -12, -20, 6], 'the measured battery tracks the register');
});

// --- SoC plausibility gate: drop degraded/unanswered reads, never fabricate --
// Regression for the "SoC time series spikes 0/100" bug on the Deye 12k LV: a
// Solarman logger that cannot reach the inverter still returns a well-framed,
// CRC-valid response - typically an all-zero register block (night-time empty
// answer) or an out-of-range value on a misaligned frame. Decoding those as
// soc_pct=0 / soc_pct>100 injected the spikes. A battery family with an
// implausible SoC must now DROP the whole reading (return null): no sample,
// never a 0.

test('hybrid_3p: an all-zero (unanswered) frame is dropped, not published as soc 0', () => {
  const b = block(0x024c, 0x67, {}); // every register 0 - the classic empty answer
  assert.strictEqual(D.decode([b], { family: 'hybrid_3p' }), null, 'all-zero read -> no sample');
});

test('hybrid_1p: an all-zero (unanswered) frame is dropped, not published as soc 0', () => {
  const b = block(0x00a9, 0x16, {});
  assert.strictEqual(D.decode([b], { family: 'hybrid_1p' }), null, 'all-zero read -> no sample');
});

test('hybrid_3p: an out-of-range SoC (garbage/misaligned frame) is dropped', () => {
  // SoC register reads 1250 (a temperature/voltage-like value) with otherwise
  // plausible power fields - a misaligned/garbage frame. Must drop, not clip.
  const b = block(0x024c, 0x67, { 0x024c: 1250, 0x028d: 3000, 0x02a0: 2000 });
  assert.strictEqual(D.decode([b], { family: 'hybrid_3p' }), null, 'soc>100 -> no sample');
});

test('hybrid_3p: an exact-0 SoC with real power fields is still dropped (0 = empty-answer signature)', () => {
  const b = block(0x024c, 0x67, { 0x024c: 0, 0x028d: 3000, 0x02a0: 4000 });
  assert.strictEqual(D.decode([b], { family: 'hybrid_3p' }), null);
});

test('hybrid_3p: a plausible LOW SoC (above the BMS floor) is kept', () => {
  const b = block(0x024c, 0x67, { 0x024c: 8, 0x028d: 2000 }); // 8 % - real, above 0
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.soc_pct, 8, 'a genuine low SoC survives the gate');
  assert.strictEqual(reading.load_kw, 2);
});

test('hybrid_3p: a full-battery 100 % SoC is kept (inclusive upper bound)', () => {
  const b = block(0x024c, 0x67, { 0x024c: 100, 0x028d: 500 });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.soc_pct, 100);
});

test('string/micro: a 0-generation (night) reading is NOT dropped - no battery, no SoC gate', () => {
  const s = block(0x0050, 0x0002, {}); // string AC output 0
  assert.deepStrictEqual(D.decode([s], { family: 'string' }).reading, { pv_power_kw: 0 });
  const m = block(0x0056, 0x0002, {}); // micro AC output 0
  assert.deepStrictEqual(D.decode([m], { family: 'micro' }).reading, { pv_power_kw: 0 });
});

test('socPlausible accepts (0,100] and rejects 0, negatives, >100 and non-numbers', () => {
  assert.strictEqual(D.socPlausible(57), true);
  assert.strictEqual(D.socPlausible(0.5), true);
  assert.strictEqual(D.socPlausible(100), true);
  assert.strictEqual(D.socPlausible(0), false);
  assert.strictEqual(D.socPlausible(-1), false);
  assert.strictEqual(D.socPlausible(101), false);
  assert.strictEqual(D.socPlausible(undefined), false);
  assert.strictEqual(D.socPlausible(NaN), false);
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

// --- hybrid_3p HV/LV scale AUTO-DETECT (device register 0x0000) ---------------
// Per davidrapan/ha-solarman deye_p3.yaml, PV Power and Battery Power carry a
// dual scale [1, 10] (LV=1 W, HV=10 W/decawatt); Grid and Load carry NO scale
// (always plain watts). ha-solarman auto-detects LV vs HV from the "Device"
// register 0x0000 (const.py AUTODETECTION_DEYE: LV codes -> mod 0 -> scale 1;
// HV codes -> mod 1 -> scale 10). We mirror this exactly.

// A device-identity block { start: 0x0000, regs: [code] }.
function deviceBlock(code) {
  return { start: 0x0000, regs: [code & 0xffff] };
}

// A measurement block with a known set of fields, used to prove the per-field
// scaling regardless of the class.
function measBlock() {
  return block(0x024c, 0x67, {
    0x024c: 77, // SoC 77 %
    0x024e: 300, // battery raw 300 W
    0x0271: 1500, // grid low word raw 1500 W (high 0)
    0x028d: 900, // load low word raw 900 W (high 0)
    0x02a0: 2000, // PV1 raw 2000
    0x02a1: 500, // PV2 raw 500 -> raw sum 2500 W
  });
}

test('auto-detect LV device (0x0005): PV/battery scale 1, grid/load always 1', () => {
  const r = D.decode([deviceBlock(0x0005), measBlock()], { family: 'hybrid_3p' });
  assert.strictEqual(r.reading.pv_power_kw, 2.5, 'LV -> PV x1');
  assert.strictEqual(r.batt_kw, 0.3, 'LV -> battery x1');
  assert.strictEqual(r.reading.power_kw, 1.5, 'grid always watts');
  assert.strictEqual(r.reading.load_kw, 0.9, 'load always watts');
  assert.strictEqual(r.reading.soc_pct, 77, 'SoC never scaled');
});

test('auto-detect HV device (0x0006): PV/battery scale 10, grid/load STAY 1 (the asymmetry fix)', () => {
  const r = D.decode([deviceBlock(0x0006), measBlock()], { family: 'hybrid_3p' });
  assert.strictEqual(r.reading.pv_power_kw, 25, 'HV -> PV x10 (2500 raw)');
  assert.strictEqual(r.batt_kw, 3, 'HV -> battery x10 (300 raw)');
  assert.strictEqual(r.reading.power_kw, 1.5, 'grid NOT scaled by class (always watts)');
  assert.strictEqual(r.reading.load_kw, 0.9, 'load NOT scaled by class (always watts)');
  assert.strictEqual(r.reading.soc_pct, 77, 'SoC never scaled');
});

test('auto-detect HV 20-50kw band (0x0008 and 0x0601, the SUN-30K class): scale 10', () => {
  for (const code of [0x0008, 0x0601, 0x0007, 0x0600]) {
    const r = D.decode([deviceBlock(code), measBlock()], { family: 'hybrid_3p' });
    assert.strictEqual(r.reading.pv_power_kw, 25, `HV code 0x${code.toString(16)} -> PV x10`);
    assert.strictEqual(r.batt_kw, 3, `HV code 0x${code.toString(16)} -> battery x10`);
  }
});

test('auto-detect: LV alias 0x0500 -> scale 1', () => {
  const r = D.decode([deviceBlock(0x0500), measBlock()], { family: 'hybrid_3p' });
  assert.strictEqual(r.reading.pv_power_kw, 2.5);
  assert.strictEqual(r.batt_kw, 0.3);
});

test('scaleClass maps the device-type codes exactly like ha-solarman', () => {
  const fam = D.FAMILIES.hybrid_3p;
  for (const c of D.DEVICE_TYPES_LV) assert.strictEqual(D.scaleClass([deviceBlock(c)], fam), 1, `LV 0x${c.toString(16)}`);
  for (const c of D.DEVICE_TYPES_HV) assert.strictEqual(D.scaleClass([deviceBlock(c)], fam), 10, `HV 0x${c.toString(16)}`);
  assert.strictEqual(D.scaleClass([deviceBlock(0x0000)], fam), undefined, 'unknown code -> undefined');
  assert.strictEqual(D.scaleClass([measBlock()], fam), undefined, 'no device register -> undefined');
});

// --- power_scale: manual override / fallback ---------------------------------
// power_scale is no longer a uniform multiplier: it OVERRIDES the auto-detected
// PV/battery class (1 or 10) and never touches grid/load. It also serves as the
// fallback when 0x0000 cannot be read.

test('manual power_scale 10 OVERRIDES an LV auto-detect (operator wins)', () => {
  const r = D.decode([deviceBlock(0x0005), measBlock()], { family: 'hybrid_3p', power_scale: 10 });
  assert.strictEqual(r.reading.pv_power_kw, 25, 'override forces PV x10 despite LV device');
  assert.strictEqual(r.batt_kw, 3);
  assert.strictEqual(r.reading.power_kw, 1.5, 'grid still watts under override');
  assert.strictEqual(r.reading.load_kw, 0.9, 'load still watts under override');
});

test('manual power_scale 1 OVERRIDES an HV auto-detect (operator wins)', () => {
  const r = D.decode([deviceBlock(0x0008), measBlock()], { family: 'hybrid_3p', power_scale: 1 });
  assert.strictEqual(r.reading.pv_power_kw, 2.5, 'override forces PV x1 despite HV device');
  assert.strictEqual(r.batt_kw, 0.3);
});

test('fallback: device register unreadable AND no override -> scale 1 (never fabricate a class)', () => {
  // Only the measurement block present (0x0000 absent), power_scale omitted/0/auto.
  for (const cfg of [{ family: 'hybrid_3p' }, { family: 'hybrid_3p', power_scale: 0 }]) {
    const r = D.decode([measBlock()], cfg);
    assert.strictEqual(r.reading.pv_power_kw, 2.5, 'fallback PV x1');
    assert.strictEqual(r.batt_kw, 0.3, 'fallback battery x1');
    assert.strictEqual(r.reading.power_kw, 1.5);
  }
});

test('fallback: unknown device code with no override -> scale 1', () => {
  const r = D.decode([deviceBlock(0x1234), measBlock()], { family: 'hybrid_3p' });
  assert.strictEqual(r.reading.pv_power_kw, 2.5);
  assert.strictEqual(r.batt_kw, 0.3);
});

// --- 32-bit Grid / Load reconstruction (low + high word) ---------------------
// ha-solarman: Grid Power = 0x0271(low)+0x02B2(high), Load = 0x028D(low)+0x0293
// (high), both signed 32-bit. The old single-16-bit read wrapped a >|32.7 kW|
// excursion on a 30-50 kW unit; the 32-bit read must decode it correctly.

function s32(v) {
  return { lo: v & 0xffff, hi: (v >>> 16) & 0xffff };
}

test('32-bit grid/load: values WITHIN int16 range (positive + negative) decode correctly', () => {
  // grid +5000 W (import), load 4000 W - both fit in one 16-bit word.
  const g = s32(5000);
  const l = s32(4000);
  const b = block(0x024c, 0x67, {
    0x024c: 60,
    0x0271: g.lo, 0x02b2: g.hi,
    0x028d: l.lo, 0x0293: l.hi,
  });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.power_kw, 5);
  assert.strictEqual(reading.load_kw, 4);
});

test('32-bit grid: a >32.7 kW import does NOT wrap (the overflow fix)', () => {
  // 45000 W = 45 kW, well past the int16 ceiling of 32767. Low-16-bit alone would
  // read 45000 & 0xffff = -20536 (wrap); the 32-bit read must give +45 kW.
  const g = s32(45000);
  const b = block(0x024c, 0x67, { 0x024c: 40, 0x0271: g.lo, 0x02b2: g.hi });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.power_kw, 45, 'no int16 wrap on a 45 kW import');
});

test('32-bit grid: a large export (< -32.7 kW) decodes as a signed negative', () => {
  // -40000 W export on a 50 kW unit.
  const g = s32(-40000 >>> 0);
  const b = block(0x024c, 0x67, { 0x024c: 55, 0x0271: g.lo, 0x02b2: g.hi });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.power_kw, -40, 'signed 32-bit export, no wrap');
});

test('32-bit load: a >32.7 kW house load decodes without wrap', () => {
  const l = s32(38000);
  const b = block(0x024c, 0x67, { 0x024c: 70, 0x028d: l.lo, 0x0293: l.hi });
  const { reading } = D.decode([b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.load_kw, 38);
});

test('32-bit grid + HV scale compose: grid stays watts even at HV, big value still fine', () => {
  // HV device (scale 10 for PV/batt), a 45 kW grid import: grid must NOT be x10.
  const g = s32(45000);
  const b = block(0x024c, 0x67, { 0x024c: 50, 0x0271: g.lo, 0x02b2: g.hi, 0x02a0: 2000 });
  const { reading } = D.decode([deviceBlock(0x0008), b], { family: 'hybrid_3p' });
  assert.strictEqual(reading.power_kw, 45, 'grid is watts regardless of HV class');
  assert.strictEqual(reading.pv_power_kw, 20, 'PV still x10 (2000 raw -> 20 kW)');
});
