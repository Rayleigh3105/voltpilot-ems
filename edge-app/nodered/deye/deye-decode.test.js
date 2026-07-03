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

// --- string family: 32-bit low-word-first + x0.1 PV scaling ------------------

test('string decode: 32-bit low-word-first, PV x0.1, signed grid export', () => {
  const start = 0x0050;
  const count = 0x007d;
  const regs = block(start, count, {
    // PV raw 50000 (x0.1 = 5000 W = 5 kW). low word first.
    0x0050: 50000 & 0xffff,
    0x0051: (50000 >> 16) & 0xffff,
    // load 2000 W -> 2 kW
    0x00c6: 2000,
    0x00c7: 0,
    // grid -1000 W -> -1 kW (export). 32-bit two's complement, low word first.
    0x00cb: (-1000 >>> 0) & 0xffff,
    0x00cc: ((-1000 >>> 0) >> 16) & 0xffff,
  });
  const { reading, batt_kw } = D.decode([regs], { family: 'string' });
  assert.strictEqual(reading.pv_power_kw, 5);
  assert.strictEqual(reading.load_kw, 2);
  assert.strictEqual(reading.power_kw, -1);
  assert.strictEqual('soc_pct' in reading, false, 'string family has no battery -> no soc');
  assert.strictEqual(batt_kw, undefined);
});

test('string reads are a single Modbus block within the 125-register max', () => {
  const [r] = D.planReads({ family: 'string' });
  assert.strictEqual(r.start, 0x0050);
  assert.ok(r.count <= 125, 'must not exceed the Modbus fn-0x03 register limit');
  assert.deepStrictEqual(D.readCmd('1.2.3.4:48899', r.start, r.count), [
    '-t',
    '1.2.3.4:48899',
    '-xmb',
    '0050007D',
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
  const b = block(0x024c, 0x56, {
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

test('hybrid_3p read plan is one block 0x024C..0x02A1', () => {
  const [r] = D.planReads({ family: 'hybrid_3p' });
  assert.strictEqual(r.start, 0x024c);
  assert.strictEqual(r.count, 0x56);
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

test('micro family has no telemetry reads (write-only control path)', () => {
  assert.deepStrictEqual(D.planReads({ family: 'micro' }), []);
  assert.strictEqual(D.decode([], { family: 'micro' }).reading.power_kw, undefined);
});
