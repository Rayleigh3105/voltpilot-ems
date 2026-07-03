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
