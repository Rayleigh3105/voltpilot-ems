'use strict';

/**
 * Offline tests for the Solarman V5 transport codec. No hardware, no network,
 * no sockets: request frames are built and asserted byte-for-byte, response
 * frames are assembled from known register arrays and parsed back.
 *
 * The checksum / CRC assertions use an INDEPENDENT re-derivation inside the
 * test (not the module's own functions) so a bug in the codec cannot hide
 * behind a test that merely mirrors it.
 *
 * Run: node --test edge-app/nodered/deye/
 */

const { test } = require('node:test');
const assert = require('node:assert');

const S = require('./solarman-v5.js');
const D = require('./deye-decode.js');

// --- independent reference helpers (do NOT call the module under test) -------

// Independent Modbus CRC16 (poly 0xA001, init 0xFFFF) - table-free, written
// separately from the implementation so agreement is meaningful.
function refModbusCrc(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

// Independent V5 checksum: sum of bytes[1 .. len-3], mod 256.
function refV5Checksum(bytes) {
  let sum = 0;
  for (let i = 1; i < bytes.length - 2; i++) sum += bytes[i];
  return sum & 0xff;
}

// Build a well-formed V5 *response* frame carrying a fn-0x03 register reply -
// exactly what a real logging stick returns - so parseV5Response has a genuine
// frame to validate. Uses ref helpers for both checksums.
function makeResponseFrame(regs, { loggerSerial, sequence = 0, slaveId = 1 } = {}) {
  // Modbus RTU reply: [slave, 0x03, byteCount, data..BE.., crcLo, crcHi]
  const byteCount = regs.length * 2;
  const mbBody = [slaveId & 0xff, 0x03, byteCount];
  for (const r of regs) {
    mbBody.push((r >> 8) & 0xff, r & 0xff);
  }
  const mbCrc = refModbusCrc(mbBody);
  const modbus = [...mbBody, mbCrc & 0xff, (mbCrc >> 8) & 0xff];

  // V5 response payload preamble = 14 bytes: frametype(1)+status(1)+3x u32(12).
  const preamble = [0x02, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const length = preamble.length + modbus.length; // response length field
  const header = [0xa5, length & 0xff, (length >> 8) & 0xff, 0x10, 0x15, sequence & 0xff, (sequence >> 8) & 0xff];
  const serial = loggerSerial >>> 0;
  header.push(serial & 0xff, (serial >> 8) & 0xff, (serial >> 16) & 0xff, (serial >> 24) & 0xff);

  const frame = [...header, ...preamble, ...modbus, 0x00, 0x15];
  frame[frame.length - 2] = refV5Checksum(frame);
  return Buffer.from(frame);
}

// --- Modbus CRC agrees with an independent implementation --------------------

test('modbusCrc16 agrees with an independent reference on known inputs', () => {
  const cases = [[0x01, 0x03, 0x00, 0xa9, 0x00, 0x16], [0x01, 0x03, 0x02, 0x00, 0x37], [0xff]];
  for (const c of cases) {
    assert.strictEqual(S.modbusCrc16(Buffer.from(c)), refModbusCrc(c), 'crc for ' + c);
  }
});

test('readHoldingRegistersRequest builds fn-0x03 with a low-byte-first CRC', () => {
  const f = S.readHoldingRegistersRequest(1, 0x00a9, 0x0016);
  // slave, fn, startHi, startLo, cntHi, cntLo
  assert.deepStrictEqual([...f.slice(0, 6)], [0x01, 0x03, 0x00, 0xa9, 0x00, 0x16]);
  const crc = refModbusCrc([...f.slice(0, 6)]);
  assert.strictEqual(f.readUInt16LE(6), crc, 'CRC appended little-endian');
  assert.strictEqual(f.length, 8);
});

// --- V5 request framing: exact bytes -----------------------------------------

test('buildReadRequest produces the exact V5 request byte layout', () => {
  const loggerSerial = 1710000001; // 0x65E3B7C1
  const sequence = 0x0102;
  const frame = S.buildReadRequest({ loggerSerial, sequence, slaveId: 1, startReg: 0x00a9, count: 0x0016 });

  // header
  assert.strictEqual(frame[0], 0xa5, 'start');
  assert.strictEqual(frame[frame.length - 1], 0x15, 'end');
  const modbusLen = 8; // fn-0x03 read request is always 8 bytes
  assert.strictEqual(frame.readUInt16LE(1), 15 + modbusLen, 'length field = 15 + modbus');
  assert.strictEqual(frame.readUInt16LE(3), 0x4510, 'request control code');
  assert.strictEqual(frame.readUInt16LE(5), sequence, 'sequence LE');
  assert.strictEqual(frame.readUInt32LE(7), loggerSerial, 'logger serial LE32');

  // payload preamble: frametype 0x02 then 14 zero bytes
  assert.strictEqual(frame[11], 0x02, 'frame type');
  assert.deepStrictEqual([...frame.slice(12, 26)], new Array(14).fill(0), 'zeroed preamble');

  // embedded modbus request at offset 26
  assert.deepStrictEqual([...frame.slice(26, 32)], [0x01, 0x03, 0x00, 0xa9, 0x00, 0x16], 'modbus fn-0x03');

  // checksum independently re-derived
  assert.strictEqual(frame[frame.length - 2], refV5Checksum([...frame]), 'V5 checksum');

  // full length: 11 header + 15 preamble + 8 modbus + 2 trailer
  assert.strictEqual(frame.length, 11 + 15 + 8 + 2);
});

test('buildV5Request rejects an out-of-range logger serial', () => {
  assert.throws(() => S.buildReadRequest({ loggerSerial: 0x1_0000_0000, startReg: 0, count: 1 }), /32-Bit/);
  assert.throws(() => S.buildReadRequest({ loggerSerial: 'abc', startReg: 0, count: 1 }), /ungueltig/);
});

test('normLoggerSerial accepts decimal strings and numbers', () => {
  assert.strictEqual(S.normLoggerSerial('1710000001'), 1710000001);
  assert.strictEqual(S.normLoggerSerial(4294967295), 0xffffffff);
});

// --- V5 response parsing -----------------------------------------------------

test('parseV5Response unwraps a well-formed response frame', () => {
  const buf = makeResponseFrame([0x0037, 0x0000], { loggerSerial: 1710000001, sequence: 7 });
  const r = S.parseV5Response(buf, { expectLoggerSerial: 1710000001, expectSequence: 7 });
  assert.strictEqual(r.controlCode, 0x1510);
  assert.strictEqual(r.loggerSerial, 1710000001);
  assert.strictEqual(r.sequence, 7);
  assert.strictEqual(r.frameType, 0x02);
  // the modbus payload is [01 03 04 0037 0000 crc]
  assert.deepStrictEqual([...r.modbusFrame.slice(0, 3)], [0x01, 0x03, 0x04]);
});

test('readRegistersFromResponse returns big-endian register words', () => {
  const regs = S.readRegistersFromResponse(makeResponseFrame([0x00a9, 0x1234, 0xffff], { loggerSerial: 42 }));
  assert.deepStrictEqual(regs, [0x00a9, 0x1234, 0xffff]);
});

test('registerBlock yields a deye-decode-compatible block', () => {
  const block = S.registerBlock(0x00a9, makeResponseFrame(new Array(0x16).fill(0), { loggerSerial: 42 }));
  assert.strictEqual(block.start, 0x00a9);
  assert.strictEqual(block.regs.length, 0x16);
});

// --- V5 response error handling ----------------------------------------------

test('parseV5Response rejects a bad start byte', () => {
  const buf = makeResponseFrame([0x0001], { loggerSerial: 1 });
  buf[0] = 0x00;
  assert.throws(() => S.parseV5Response(buf), /Startbyte/);
});

test('parseV5Response rejects a corrupted V5 checksum', () => {
  const buf = makeResponseFrame([0x0001], { loggerSerial: 1 });
  buf[buf.length - 2] ^= 0xff;
  assert.throws(() => S.parseV5Response(buf), /Pruefsumme/);
});

test('parseV5Response rejects a frame shorter than its length field', () => {
  const buf = makeResponseFrame([0x0001, 0x0002, 0x0003], { loggerSerial: 1 });
  assert.throws(() => S.parseV5Response(buf.slice(0, buf.length - 4)), /(zu kurz|kuerzer)/);
});

test('parseV5Response rejects a serial / sequence mismatch when asked to check', () => {
  const buf = makeResponseFrame([0x0001], { loggerSerial: 1710000001, sequence: 5 });
  assert.throws(() => S.parseV5Response(buf, { expectLoggerSerial: 999 }), /Seriennummer/);
  assert.throws(() => S.parseV5Response(buf, { expectSequence: 6 }), /Sequenz/);
});

test('parseModbusResponse surfaces a Modbus exception frame', () => {
  // exception reply: [slave, fn|0x80, excCode, crcLo, crcHi]
  const body = [0x01, 0x83, 0x02];
  const crc = refModbusCrc(body);
  const mb = Buffer.from([...body, crc & 0xff, (crc >> 8) & 0xff]);
  assert.throws(() => S.parseModbusResponse(mb), /Ausnahme 0x02/);
});

test('parseModbusResponse rejects a bad Modbus CRC and a short frame', () => {
  const good = makeResponseFrame([0x0001], { loggerSerial: 1 });
  const mb = S.parseV5Response(good).modbusFrame;
  const corrupt = Buffer.from(mb);
  corrupt[corrupt.length - 1] ^= 0xff;
  assert.throws(() => S.parseModbusResponse(corrupt), /CRC/);
  assert.throws(() => S.parseModbusResponse(Buffer.from([0x01, 0x03])), /zu kurz/);
});

// --- expectedFrameLength (socket reassembly aid) -----------------------------

test('expectedFrameLength reports the full frame size once the header is present', () => {
  const buf = makeResponseFrame([0x0001, 0x0002], { loggerSerial: 1 });
  assert.strictEqual(S.expectedFrameLength(buf), buf.length);
  assert.strictEqual(S.expectedFrameLength(buf.slice(0, 3)), buf.length, 'known from 3 header bytes');
  assert.strictEqual(S.expectedFrameLength(Buffer.from([0xa5, 0x00])), null, 'unknown below 3 bytes');
});

// --- end-to-end: V5 read -> register block -> deye-decode reproduces reading -

test('hybrid_1p: a synthetic V5 read decodes through deye-decode to a reading', () => {
  const start = 0x00a9;
  const count = 0x16;
  const regs = new Array(count).fill(0);
  regs[0x00a9 - start] = 2500; // grid import 2.5 kW
  regs[0x00b2 - start] = 1600; // load 1.6 kW
  regs[0x00b8 - start] = 80; // SoC 80 %
  regs[0x00ba - start] = 2000; // PV1
  regs[0x00bb - start] = 1500; // PV2 -> 3.5 kW
  regs[0x00be - start] = -1200 & 0xffff; // battery discharge

  const frame = makeResponseFrame(regs, { loggerSerial: 1710000001 });
  const block = S.registerBlock(start, frame, { expectLoggerSerial: 1710000001 });
  const { reading, batt_kw } = D.decode([block], { family: 'hybrid_1p' });

  assert.strictEqual(reading.power_kw, 2.5);
  assert.strictEqual(reading.load_kw, 1.6);
  assert.strictEqual(reading.soc_pct, 80);
  assert.strictEqual(reading.pv_power_kw, 3.5);
  assert.strictEqual(batt_kw, -1.2);
});

// Regression for the Deye 12k LV "SoC spikes 0/100" bug, end to end through the
// real V5 transport: a logger that could not reach the inverter returns a
// well-framed, CRC-valid response whose SG04LP3 register block is all zeros (the
// night-time empty answer). The transport accepts the frame (framing is valid);
// the decoder must then DROP it (return null) so no soc_pct=0 sample is
// published. Before the fix this produced a full all-zero reading incl. soc 0.
test('hybrid_3p: a CRC-valid but all-zero (unanswered) V5 read decodes to a dropped sample', () => {
  const start = 0x024c;
  const count = 0x58;
  const regs = new Array(count).fill(0); // SG04LP3 LV block, every register 0
  const frame = makeResponseFrame(regs, { loggerSerial: 2985159064 });
  const block = S.registerBlock(start, frame, { expectLoggerSerial: 2985159064 });
  assert.strictEqual(block.regs.length, count, 'transport still parses the frame');
  assert.strictEqual(D.decode([block], { family: 'hybrid_3p' }), null, 'decode drops the empty read');
});

// A genuine SG04LP3 LV read (the captain's 12k) still decodes normally: SoC 57 %
// with plausible power fields - proving the gate does not reject real data.
test('hybrid_3p SG04LP3 LV: a real 57 % SoC read survives the V5 round trip', () => {
  const start = 0x024c;
  const count = 0x58;
  const regs = new Array(count).fill(0);
  regs[0x024c - start] = 57; // SoC 57 %
  regs[0x028d - start] = 2400; // load 2.4 kW
  regs[0x0271 - start] = 900; // grid import 0.9 kW
  regs[0x024e - start] = -1500 & 0xffff; // battery discharging (night)
  const frame = makeResponseFrame(regs, { loggerSerial: 2985159064 });
  const block = S.registerBlock(start, frame);
  const { reading } = D.decode([block], { family: 'hybrid_3p' });
  assert.strictEqual(reading.soc_pct, 57);
  assert.strictEqual(reading.load_kw, 2.4);
  assert.strictEqual(reading.power_kw, 0.9);
});

test('string family: AC-output 32-bit low-word-first survives the V5 round trip', () => {
  const start = 0x0050;
  const count = 0x02;
  const regs = new Array(count).fill(0);
  regs[0x0050 - start] = 50000 & 0xffff; // AC output low word (raw 50000 x0.1 = 5 kW)
  regs[0x0051 - start] = (50000 >> 16) & 0xffff;

  const frame = makeResponseFrame(regs, { loggerSerial: 42 });
  const block = S.registerBlock(start, frame);
  const { reading } = D.decode([block], { family: 'string' });
  assert.strictEqual(reading.pv_power_kw, 5);
  assert.strictEqual('load_kw' in reading, false, 'string has no house-load meter');
  assert.strictEqual('power_kw' in reading, false, 'string has no grid meter');
});

// --- Write PDUs: FC6 / FC16 round trips ---------------------------------------
//
// These are the write side of the Deye control adapter (report §4.4b, §3.3).
// They are UNIT-tested here; a live write is only ever issued for a bench-
// CERTIFIED model, never from a guessed address (see the safety gate).

// Build a V5 *response* wrapping a raw Modbus reply body (any function code) -
// used to feed the write-ack parsers a genuine framed reply.
function makeV5WithModbusBody(mbBody, { loggerSerial, sequence = 0 } = {}) {
  const mbCrc = refModbusCrc(mbBody);
  const modbus = [...mbBody, mbCrc & 0xff, (mbCrc >> 8) & 0xff];
  const preamble = [0x02, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const length = preamble.length + modbus.length;
  const header = [0xa5, length & 0xff, (length >> 8) & 0xff, 0x10, 0x15, sequence & 0xff, (sequence >> 8) & 0xff];
  const serial = loggerSerial >>> 0;
  header.push(serial & 0xff, (serial >> 8) & 0xff, (serial >> 16) & 0xff, (serial >> 24) & 0xff);
  const frame = [...header, ...preamble, ...modbus, 0x00, 0x15];
  frame[frame.length - 2] = refV5Checksum(frame);
  return Buffer.from(frame);
}

test('writeSingleRegisterRequest builds fn-0x06 with a low-byte-first CRC', () => {
  const f = S.writeSingleRegisterRequest(1, 0x0028, 100);
  assert.deepStrictEqual([...f.slice(0, 6)], [0x01, 0x06, 0x00, 0x28, 0x00, 0x64], 'slave/fn/reg/value BE');
  assert.strictEqual(f.readUInt16LE(6), refModbusCrc([...f.slice(0, 6)]), 'CRC LE');
  assert.strictEqual(f.length, 8);
});

test('writeSingleRegisterRequest masks the value to 16 bits (two-complement power word)', () => {
  const f = S.writeSingleRegisterRequest(1, 0x0f3d, -4000 & 0xffff);
  assert.deepStrictEqual([...f.slice(2, 6)], [0x0f, 0x3d, 0xf0, 0x60], 'reg 0x0F3D, value 0xF060 = -4000');
});

test('writeMultipleRegistersRequest builds fn-0x10 with byte count + BE words', () => {
  const f = S.writeMultipleRegistersRequest(1, 0x0f3d, [4000, 80]);
  // slave, fn, startHi, startLo, cntHi, cntLo, byteCount, w0Hi, w0Lo, w1Hi, w1Lo
  assert.deepStrictEqual([...f.slice(0, 11)], [0x01, 0x10, 0x0f, 0x3d, 0x00, 0x02, 0x04, 0x0f, 0xa0, 0x00, 0x50]);
  assert.strictEqual(f.readUInt16LE(11), refModbusCrc([...f.slice(0, 11)]), 'CRC LE');
});

test('writeMultipleRegistersRequest rejects an empty value list', () => {
  assert.throws(() => S.writeMultipleRegistersRequest(1, 0, []), /non-empty/);
});

test('buildWriteSingleRequest wraps fn-0x06 in an exact V5 request frame', () => {
  const loggerSerial = 2985159064; // real captain logger serial (DEYE.md)
  const sequence = 0x0203;
  const frame = S.buildWriteSingleRequest({ loggerSerial, sequence, slaveId: 1, reg: 0x0028, value: 50 });
  assert.strictEqual(frame[0], 0xa5, 'start');
  assert.strictEqual(frame[frame.length - 1], 0x15, 'end');
  assert.strictEqual(frame.readUInt16LE(3), 0x4510, 'request control code');
  assert.strictEqual(frame.readUInt16LE(5), sequence, 'sequence LE');
  assert.strictEqual(frame.readUInt32LE(7), loggerSerial, 'logger serial LE32');
  // embedded modbus fn-0x06 at offset 26
  assert.deepStrictEqual([...frame.slice(26, 32)], [0x01, 0x06, 0x00, 0x28, 0x00, 0x32], 'fn-0x06 write');
  assert.strictEqual(frame[frame.length - 2], refV5Checksum([...frame]), 'V5 checksum');
  assert.strictEqual(frame.length, 11 + 15 + 8 + 2, 'full frame length');
});

test('parseWriteResponse reads back a fn-0x06 echo', () => {
  const mbBody = [0x01, 0x06, 0x00, 0x28, 0x00, 0x64];
  const crc = refModbusCrc(mbBody);
  const mb = Buffer.from([...mbBody, crc & 0xff, (crc >> 8) & 0xff]);
  const r = S.parseWriteResponse(mb, { expectFn: 0x06 });
  assert.deepStrictEqual(r, { fn: 0x06, reg: 0x0028, value: 100 });
});

test('parseWriteResponse reads back a fn-0x10 acknowledgement', () => {
  const mbBody = [0x01, 0x10, 0x0f, 0x3d, 0x00, 0x02];
  const crc = refModbusCrc(mbBody);
  const mb = Buffer.from([...mbBody, crc & 0xff, (crc >> 8) & 0xff]);
  const r = S.parseWriteResponse(mb, { expectFn: 0x10 });
  assert.deepStrictEqual(r, { fn: 0x10, startReg: 0x0f3d, count: 2 });
});

test('readWriteResultFromResponse unwraps a V5 write ack round trip', () => {
  const loggerSerial = 2985159064;
  const sequence = 7;
  // fn-0x06 echo body
  const echo = makeV5WithModbusBody([0x01, 0x06, 0x00, 0x28, 0x00, 0x32], { loggerSerial, sequence });
  const r = S.readWriteResultFromResponse(echo, { expectLoggerSerial: loggerSerial, expectSequence: sequence, expectFn: 0x06 });
  assert.deepStrictEqual(r, { fn: 0x06, reg: 0x0028, value: 50 });
});

test('parseWriteResponse surfaces a Modbus write exception and a bad CRC', () => {
  const exc = [0x01, 0x86, 0x02]; // illegal data address on a 0x06 write
  const crc = refModbusCrc(exc);
  assert.throws(() => S.parseWriteResponse(Buffer.from([...exc, crc & 0xff, (crc >> 8) & 0xff])), /Ausnahme 0x02/);
  const good = [0x01, 0x06, 0x00, 0x28, 0x00, 0x64];
  assert.throws(() => S.parseWriteResponse(Buffer.from([...good, 0x00, 0x00])), /CRC/);
});

test('parseWriteResponse rejects an unexpected function code when asked', () => {
  const mbBody = [0x01, 0x06, 0x00, 0x28, 0x00, 0x64];
  const crc = refModbusCrc(mbBody);
  const mb = Buffer.from([...mbBody, crc & 0xff, (crc >> 8) & 0xff]);
  assert.throws(() => S.parseWriteResponse(mb, { expectFn: 0x10 }), /unerwartete Modbus-Funktion/);
});
