'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mb = require('./modbus-tcp');

// Build a Modbus-TCP fn-0x03 response frame from register words, for round-trip
// tests (mirrors what a server/the sim would send).
function buildResponse({ txid = 0, unit = 1, regs }) {
  const byteCount = regs.length * 2;
  const buf = Buffer.alloc(9 + byteCount);
  buf.writeUInt16BE(txid & 0xffff, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(3 + byteCount, 4); // unit + fn + byteCount + data
  buf[6] = unit & 0xff;
  buf[7] = mb.FN_READ_HOLDING;
  buf[8] = byteCount;
  for (let i = 0; i < regs.length; i++) buf.writeUInt16BE(regs[i] & 0xffff, 9 + i * 2);
  return buf;
}

test('buildReadRequest encodes a fn-0x03 MBAP+PDU frame', () => {
  const req = mb.buildReadRequest({ txid: 0x1234, unitId: 1, addr: 0, count: 9 });
  assert.strictEqual(req.length, 12);
  assert.strictEqual(req.readUInt16BE(0), 0x1234); // txid
  assert.strictEqual(req.readUInt16BE(2), 0); // proto
  assert.strictEqual(req.readUInt16BE(4), 6); // length
  assert.strictEqual(req[6], 1); // unit
  assert.strictEqual(req[7], 0x03); // fn
  assert.strictEqual(req.readUInt16BE(8), 0); // addr
  assert.strictEqual(req.readUInt16BE(10), 9); // count
});

test('parseReadResponse round-trips register words', () => {
  const regs = [10, 20, 30, 40, 555, 10000, 5000];
  const frame = buildResponse({ txid: 7, unit: 1, regs });
  const got = mb.parseReadResponse(frame, { expectTxid: 7, expectUnit: 1 });
  assert.deepStrictEqual(got, regs);
});

test('expectedFrameLength follows the MBAP length field for segment reassembly', () => {
  const frame = buildResponse({ regs: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  assert.strictEqual(mb.expectedFrameLength(frame.slice(0, 3)), null); // header incomplete
  assert.strictEqual(mb.expectedFrameLength(frame), frame.length);
});

test('parseReadResponse rejects a Modbus exception', () => {
  const buf = Buffer.alloc(9);
  buf.writeUInt16BE(1, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(3, 4);
  buf[6] = 1;
  buf[7] = 0x03 | 0x80; // exception
  buf[8] = 0x02; // illegal data address
  assert.throws(() => mb.parseReadResponse(buf), /Ausnahme 0x02/);
});

test('parseReadResponse rejects a txid mismatch', () => {
  const frame = buildResponse({ txid: 5, regs: [1, 2, 3, 4, 5, 6, 7] });
  assert.throws(() => mb.parseReadResponse(frame, { expectTxid: 6 }), /Transaktions-ID/);
});

test('parseReadResponse rejects a truncated payload', () => {
  const frame = buildResponse({ regs: [1, 2, 3, 4, 5, 6, 7] });
  assert.throws(() => mb.parseReadResponse(frame.slice(0, frame.length - 4)), /Laengenfeld|unvollstaendig/);
});

test('profileRead returns the sunspec block and null for unknown', () => {
  assert.deepStrictEqual(mb.profileRead('sunspec'), { fc: 0x03, addr: 0, count: 9 });
  assert.strictEqual(mb.profileRead('nope'), null);
});

test('sunspec profile decodes the compact block like the sim source', () => {
  // grid +2.50 kW (import), pv 12.00 kW, load 8.00 kW, batt +5.00 kW,
  // soc 55.0 %, wmax 70.00 %, grid-conn 50.00 kW -> grid_limit 35.000 kW.
  const regs = [250, 1200, 800, 500, 550, 7000, 5000, 0, 0];
  const out = mb.decodeProfile('sunspec', regs);
  assert.deepStrictEqual(out.reading, {
    power_kw: 2.5,
    pv_power_kw: 12,
    load_kw: 8,
    soc_pct: 55,
    grid_limit_kw: 35,
  });
  assert.strictEqual(out.batt_kw, 5);
});

test('sunspec profile handles negative (export) grid via two-complement', () => {
  const regs = [65536 - 300, 1500, 400, 65536 - 200, 800, 10000, 5000];
  const out = mb.decodeProfile('sunspec', regs);
  assert.strictEqual(out.reading.power_kw, -3); // export
  assert.strictEqual(out.batt_kw, -2); // discharge
  assert.strictEqual(out.reading.grid_limit_kw, 50); // 100% * 50 kW
});

test('decodeProfile returns null for an unknown profile or short block', () => {
  assert.strictEqual(mb.decodeProfile('nope', [1, 2, 3, 4, 5, 6, 7]), null);
  assert.strictEqual(mb.decodeProfile('sunspec', [1, 2, 3]), null);
});

// --- fn-0x06 write single register (the SunSpec control adapter write side) ---

// Build a fn-0x06 echo response (server echoes the request).
function buildWriteEcho({ txid = 0, unit = 1, addr, value }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(txid & 0xffff, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(6, 4);
  buf[6] = unit & 0xff;
  buf[7] = mb.FN_WRITE_SINGLE;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(value & 0xffff, 10);
  return buf;
}

test('buildWriteSingleRequest encodes a fn-0x06 MBAP+PDU frame', () => {
  const req = mb.buildWriteSingleRequest({ txid: 0x0009, unitId: 1, addr: 40, value: (-2500) & 0xffff });
  assert.strictEqual(req.length, 12);
  assert.strictEqual(req.readUInt16BE(0), 0x0009);
  assert.strictEqual(req.readUInt16BE(4), 6);
  assert.strictEqual(req[7], 0x06);
  assert.strictEqual(req.readUInt16BE(8), 40);
  assert.strictEqual(req.readUInt16BE(10), (-2500) & 0xffff); // int16 0.01 kW two's complement
});

test('parseWriteSingleResponse round-trips the echoed addr/value', () => {
  const echo = buildWriteEcho({ txid: 9, unit: 1, addr: 42, value: 0xffff });
  const got = mb.parseWriteSingleResponse(echo, { expectTxid: 9, expectUnit: 1 });
  assert.deepStrictEqual(got, { addr: 42, value: 0xffff });
});

test('parseWriteSingleResponse rejects a Modbus exception and a txid mismatch', () => {
  const exc = Buffer.alloc(12);
  exc.writeUInt16BE(1, 0); exc.writeUInt16BE(6, 4); exc[6] = 1; exc[7] = 0x86; exc[8] = 0x02;
  assert.throws(() => mb.parseWriteSingleResponse(exc), /Ausnahme 0x02/);
  const echo = buildWriteEcho({ txid: 9, addr: 40, value: 1 });
  assert.throws(() => mb.parseWriteSingleResponse(echo, { expectTxid: 8 }), /Transaktions-ID/);
});

// --- MB-M1: FC4 reads + the generic decodeValue ------------------------------

test('buildReadRequest encodes fn 0x04 (input registers) via the fc option', () => {
  const req = mb.buildReadRequest({ txid: 5, unitId: 3, addr: 100, count: 2, fc: mb.FN_READ_INPUT });
  assert.strictEqual(req[7], 0x04);
  assert.strictEqual(req.readUInt16BE(8), 100);
  assert.strictEqual(req.readUInt16BE(10), 2);
  // Default stays fn 0x03 - existing callers byte-identical.
  assert.strictEqual(mb.buildReadRequest({ addr: 0, count: 1 })[7], 0x03);
});

test('parseReadResponse accepts fn 0x04 via expectFn and refuses the mismatch', () => {
  const regs = [0x0102, 0x0304];
  const frame = buildResponse({ txid: 11, unit: 1, regs });
  frame[7] = mb.FN_READ_INPUT;
  assert.deepStrictEqual(
    mb.parseReadResponse(frame, { expectTxid: 11, expectFn: mb.FN_READ_INPUT }), regs);
  // An FC4 reply where FC3 was expected (the default) is refused - a
  // misbehaving gateway must not slip a wrong-function frame through.
  assert.throws(() => mb.parseReadResponse(frame, { expectTxid: 11 }), /Funktion 0x04/);
});

test('registerCount derives the word count from the data type', () => {
  assert.strictEqual(mb.registerCount('u16'), 1);
  assert.strictEqual(mb.registerCount('s16'), 1);
  assert.strictEqual(mb.registerCount('u32'), 2);
  assert.strictEqual(mb.registerCount('s32'), 2);
  assert.strictEqual(mb.registerCount('float32'), 2);
  assert.strictEqual(mb.registerCount('float64'), null);
});

test('decodeValue decodes 16-bit types', () => {
  assert.strictEqual(mb.decodeValue([0x1234], 'u16', 'big'), 0x1234);
  assert.strictEqual(mb.decodeValue([0xffff], 'u16', 'big'), 65535);
  assert.strictEqual(mb.decodeValue([0xffff], 's16', 'big'), -1);
  assert.strictEqual(mb.decodeValue([0x8000], 's16', 'big'), -32768);
  // Word order is irrelevant for a single register.
  assert.strictEqual(mb.decodeValue([0xfff6], 's16', 'little'), -10);
});

test('decodeValue decodes 32-bit integers with both word orders', () => {
  // 0x00012345 = 74565: big = [0x0001, 0x2345], little = [0x2345, 0x0001].
  assert.strictEqual(mb.decodeValue([0x0001, 0x2345], 'u32', 'big'), 74565);
  assert.strictEqual(mb.decodeValue([0x2345, 0x0001], 'u32', 'little'), 74565);
  // s32 two's complement: 0xFFFFFFFE = -2.
  assert.strictEqual(mb.decodeValue([0xffff, 0xfffe], 's32', 'big'), -2);
  assert.strictEqual(mb.decodeValue([0xfffe, 0xffff], 's32', 'little'), -2);
  // u32 keeps the full unsigned range.
  assert.strictEqual(mb.decodeValue([0xffff, 0xffff], 'u32', 'big'), 4294967295);
});

test('decodeValue decodes IEEE-754 float32 with both word orders', () => {
  // 230.25f = 0x43 66 40 00 -> words big [0x4366, 0x4000].
  assert.strictEqual(mb.decodeValue([0x4366, 0x4000], 'float32', 'big'), 230.25);
  assert.strictEqual(mb.decodeValue([0x4000, 0x4366], 'float32', 'little'), 230.25);
  // -12.5f = 0xC1 48 00 00.
  assert.strictEqual(mb.decodeValue([0xc148, 0x0000], 'float32', 'big'), -12.5);
  // A real 0 is a value, never dropped.
  assert.strictEqual(mb.decodeValue([0x0000, 0x0000], 'float32', 'big'), 0);
});

test('decodeValue returns null instead of NaN/Infinity or on bad input', () => {
  // 0x7F800000 = +Infinity, 0x7FC00000 = NaN - a garbage register block must
  // yield NO value (absent-not-zero discipline), never a non-finite number.
  assert.strictEqual(mb.decodeValue([0x7f80, 0x0000], 'float32', 'big'), null);
  assert.strictEqual(mb.decodeValue([0x7fc0, 0x0000], 'float32', 'big'), null);
  assert.strictEqual(mb.decodeValue([0x1234], 'u32', 'big'), null, 'short block');
  assert.strictEqual(mb.decodeValue([1, 2], 'float64', 'big'), null, 'unknown type');
  assert.strictEqual(mb.decodeValue('regs', 'u16', 'big'), null, 'not an array');
});
