'use strict';

/**
 * solarman-v5 - the canonical, unit-tested reference for the ROBUST Deye
 * transport: Modbus-RTU framed in the Solarman V5 logger protocol over
 * **TCP port 8899**.
 *
 * It replaces the flaky AT-command CLI transport (`deye-logger-at-cmd`,
 * UDP 48899) which many Deye/Solarman WiFi dongles answer unreliably behind
 * NAT (reply from a different source port / as broadcast -> conntrack drops
 * it). The Solarman V5 protocol is a single, ordered TCP connection - the
 * standard, reliable way the wider ecosystem (Home Assistant / pysolarmanv5)
 * reads these loggers.
 *
 * This module owns ONLY the wire protocol (framing + checksums + modbus
 * codec). It is dependency-free (Node `Buffer` only) and has NO socket code,
 * so it is fully testable offline. The socket lives in the Node-RED flow's
 * "Solarman-V5 lesen" function node, which carries a COPY of these functions
 * (a Node-RED flow is self-contained JSON and cannot `require` a repo file at
 * runtime) plus the `net` connect/read/reconnect logic. Keep the two in sync;
 * this file is the source of truth and the test target (see solarman-v5.test.js).
 *
 * The register maps + scaling stay in `deye-decode.js` - only the TRANSPORT
 * is new. A V5 read yields a `{ start, regs }` block (via `registerBlock`)
 * that plugs straight into `deye-decode.decode(blocks, config)`.
 *
 * Reference: pysolarmanv5 (github.com/jmccrohan/pysolarmanv5) and
 * StephanJoubert/home_assistant_solarman.
 *
 *   Request  frame: A5 <len LE> 4510 <seq LE> <loggerSerial LE32>
 *                   02 0000 00000000 00000000 00000000 <modbus-RTU> <cksum> 15
 *   Response frame: A5 <len LE> 1510 <seq LE> <loggerSerial LE32>
 *                   <frametype> <status> <3x u32 LE> <modbus-RTU> <cksum> 15
 *
 * The embedded Modbus-RTU frame is big-endian (per Modbus); everything in the
 * V5 wrapper is little-endian. The V5 checksum is a byte-sum (mod 256) over
 * every byte EXCEPT the start (0xA5), the checksum byte itself, and the end
 * (0x15). The Modbus frame carries its own CRC16 (poly 0xA001, appended
 * little-endian).
 */

const V5_START = 0xa5;
const V5_END = 0x15;
const V5_CONTROL_REQUEST = 0x4510; // little-endian on the wire: 10 45
const V5_CONTROL_RESPONSE = 0x1510; // little-endian on the wire: 10 15
const V5_FRAME_TYPE = 0x02; // "solar inverter" request/response frame type

// Byte offset of the embedded Modbus frame within a V5 *response*: the 11-byte
// header + a 14-byte payload preamble (frametype 1 + status 1 + 3x u32 = 14).
// The *request* preamble is 15 bytes (frametype 1 + sensortype 2 + 3x u32),
// so a request's modbus starts at offset 26 - asymmetric on purpose.
const V5_RESPONSE_MODBUS_OFFSET = 25;
const V5_REQUEST_PREAMBLE = 15;

// Byte offset of the response STATUS field (index 12): frametype(11) then status.
const V5_RESPONSE_STATUS_OFFSET = 12;

// V5 response frame-type values (offset 11) with plain-German labels. Per the
// pysolarmanv5 protocol doc: 0x02 = solar inverter (the only one carrying a
// Modbus reply), 0x01 = data logging stick, 0x00 = Solarman cloud. A write reply
// with a frame type other than 0x02 means the logger did NOT return an inverter
// answer - name it instead of blindly slicing an inverter Modbus frame out of it.
const V5_FRAME_TYPES = {
  0x00: 'Solarman-Cloud',
  0x01: 'Datenlogger-Stick',
  0x02: 'Wechselrichter',
};

/** v5FrameTypeLabel - German label for a V5 response frame-type byte. */
function v5FrameTypeLabel(frameType) {
  return V5_FRAME_TYPES[frameType] || 'unbekannt';
}

// Modbus exception codes -> plain-German meaning (standard Modbus spec, matching
// pysolarmanv5's umodbus error_code_to_exception_map). 0x0B ("gateway target
// failed to respond") is the telling one: the Solarman logger IS a TCP<->RS485
// gateway, so 0x0B / a stub reply means the logger was reached but the inverter
// did not answer the write on the internal bus - exactly the live symptom.
const MODBUS_EXCEPTIONS = {
  0x01: 'unzulaessige Funktion (illegal function)',
  0x02: 'unzulaessige Datenadresse (illegal data address)',
  0x03: 'unzulaessiger Datenwert (illegal data value)',
  0x04: 'Geraetefehler im Wechselrichter (slave device failure)',
  0x05: 'wird bearbeitet (acknowledge)',
  0x06: 'Wechselrichter beschaeftigt (slave device busy)',
  0x07: 'Verarbeitung abgelehnt (negative acknowledge)',
  0x08: 'Speicher-Paritaetsfehler (memory parity error)',
  0x0a: 'Gateway-Pfad nicht verfuegbar (gateway path unavailable)',
  0x0b: 'Wechselrichter hat nicht geantwortet (gateway target failed to respond)',
};

/** modbusExceptionText - plain-German meaning for a Modbus exception code. */
function modbusExceptionText(code) {
  return MODBUS_EXCEPTIONS[code] || 'unbekannte Modbus-Ausnahme';
}

/**
 * hexdump - render a Buffer as space-separated uppercase hex bytes, for the
 * raw-frame diagnostics the write executor logs on a failure. Never throws.
 */
function hexdump(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  const out = new Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i].toString(16).padStart(2, '0').toUpperCase();
  return out.join(' ');
}

/**
 * describeV5Frame - best-effort, NEVER-throwing decode of a (possibly malformed)
 * V5 frame's header for diagnostics: start byte, declared length, control code,
 * sequence, logger serial, frame type (+label), status and a best-effort Modbus
 * slice - plus the full hex. This is what makes ONE field test decisive: the raw
 * bytes and the parsed header are printed even when parsing fails. It reads only
 * what is present (guards every offset), so a truncated or empty buffer is safe.
 */
function describeV5Frame(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || []);
  const info = { length: buf.length, hex: hexdump(buf) };
  if (buf.length >= 1) info.startByte = buf[0];
  if (buf.length >= 3) info.declaredLength = buf.readUInt16LE(1);
  if (buf.length >= 5) info.controlCode = buf.readUInt16LE(3);
  if (buf.length >= 7) info.sequence = buf.readUInt16LE(5);
  if (buf.length >= 11) info.loggerSerial = buf.readUInt32LE(7);
  if (buf.length >= 12) {
    info.frameType = buf[11];
    info.frameTypeLabel = v5FrameTypeLabel(buf[11]);
  }
  if (buf.length >= 13) info.status = buf[V5_RESPONSE_STATUS_OFFSET];
  if (buf.length >= V5_RESPONSE_MODBUS_OFFSET + 2) {
    const mb = buf.slice(V5_RESPONSE_MODBUS_OFFSET, buf.length - 2);
    info.modbusLength = mb.length;
    info.modbusHex = hexdump(mb);
  }
  return info;
}

// --- Modbus RTU --------------------------------------------------------------

/**
 * modbusCrc16 - standard Modbus/RTU CRC16 (init 0xFFFF, poly 0xA001).
 * Returned as a number; on the wire it is appended LOW byte first.
 */
function modbusCrc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0xa001;
      else crc >>>= 1;
    }
  }
  return crc & 0xffff;
}

/**
 * readHoldingRegistersRequest - build a Modbus-RTU "read holding registers"
 * (fn 0x03) frame: [slave, 0x03, startHi, startLo, countHi, countLo, crcLo, crcHi].
 */
function readHoldingRegistersRequest(slaveId, startReg, count) {
  const body = Buffer.alloc(6);
  body[0] = slaveId & 0xff;
  body[1] = 0x03;
  body.writeUInt16BE(startReg & 0xffff, 2);
  body.writeUInt16BE(count & 0xffff, 4);
  const crc = modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

/**
 * writeSingleRegisterRequest - build a Modbus-RTU "write single register"
 * (fn 0x06) frame: [slave, 0x06, regHi, regLo, valHi, valLo, crcLo, crcHi].
 * The write side of the Deye control adapter (report §4.4b): a live ToU/power
 * register is written one word at a time. The value is masked to 16 bits.
 */
function writeSingleRegisterRequest(slaveId, reg, value) {
  const body = Buffer.alloc(6);
  body[0] = slaveId & 0xff;
  body[1] = 0x06;
  body.writeUInt16BE(reg & 0xffff, 2);
  body.writeUInt16BE(value & 0xffff, 4);
  const crc = modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

/**
 * writeMultipleRegistersRequest - build a Modbus-RTU "write multiple registers"
 * (fn 0x10) frame: [slave, 0x10, startHi, startLo, countHi, countLo, byteCount,
 * data..BE.., crcLo, crcHi]. Used when several contiguous control registers
 * (e.g. a ToU slot's power + target-SoC) must be written atomically. `values`
 * is an array of 16-bit words, written big-endian per Modbus.
 */
function writeMultipleRegistersRequest(slaveId, startReg, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('writeMultipleRegistersRequest: values must be a non-empty array');
  }
  const count = values.length;
  const byteCount = count * 2;
  const body = Buffer.alloc(7 + byteCount);
  body[0] = slaveId & 0xff;
  body[1] = 0x10;
  body.writeUInt16BE(startReg & 0xffff, 2);
  body.writeUInt16BE(count & 0xffff, 4);
  body[6] = byteCount & 0xff;
  for (let i = 0; i < count; i++) body.writeUInt16BE(values[i] & 0xffff, 7 + i * 2);
  const crc = modbusCrc16(body);
  return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
}

/**
 * parseWriteResponse - validate a Modbus-RTU write reply (fn 0x06 echo or
 * fn 0x10 acknowledgement) and return { fn, reg, value } for 0x06 or
 * { fn, startReg, count } for 0x10. Throws on a short frame, a bad CRC, a
 * Modbus exception (fn | 0x80) or an unexpected function code. This is the
 * READBACK-adjacent proof that the logger accepted the write frame; the actual
 * register value is confirmed by a follow-up fn-0x03 read (the readback loop,
 * report §5).
 */
function parseWriteResponse(mb, opts = {}) {
  if (!Buffer.isBuffer(mb)) mb = Buffer.from(mb);
  if (mb.length < 5) throw new Error('Modbus-Schreibantwort zu kurz');
  const body = mb.slice(0, mb.length - 2);
  const crcGot = mb.readUInt16LE(mb.length - 2);
  const crcCalc = modbusCrc16(body);
  if (crcGot !== crcCalc) throw new Error('Modbus-CRC falsch');
  const fn = mb[1];
  if (fn & 0x80) {
    const code = mb[2];
    throw new Error('Modbus-Ausnahme 0x' + code.toString(16).padStart(2, '0') + ': ' + modbusExceptionText(code));
  }
  if (opts.expectFn !== undefined && fn !== opts.expectFn) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  if (fn === 0x06) {
    if (body.length < 6) throw new Error('fn-0x06-Antwort unvollstaendig');
    return { fn, reg: mb.readUInt16BE(2), value: mb.readUInt16BE(4) };
  }
  if (fn === 0x10) {
    if (body.length < 6) throw new Error('fn-0x10-Antwort unvollstaendig');
    return { fn, startReg: mb.readUInt16BE(2), count: mb.readUInt16BE(4) };
  }
  throw new Error('unerwartete Modbus-Schreibfunktion 0x' + fn.toString(16).padStart(2, '0'));
}

/**
 * parseModbusResponse - validate a Modbus-RTU fn-0x03 reply and return its
 * register words (big-endian, index 0 = first requested register).
 * Throws on a short frame, a bad CRC, a Modbus exception (fn | 0x80), an
 * unexpected function code, or a truncated payload.
 */
function parseModbusResponse(mb) {
  if (!Buffer.isBuffer(mb)) mb = Buffer.from(mb);
  if (mb.length < 5) throw new Error('Modbus-Antwort zu kurz');
  const body = mb.slice(0, mb.length - 2);
  const crcGot = mb.readUInt16LE(mb.length - 2);
  const crcCalc = modbusCrc16(body);
  if (crcGot !== crcCalc) throw new Error('Modbus-CRC falsch');
  const fn = mb[1];
  if (fn & 0x80) {
    const code = mb[2];
    throw new Error('Modbus-Ausnahme 0x' + code.toString(16).padStart(2, '0') + ': ' + modbusExceptionText(code));
  }
  if (fn !== 0x03) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  const byteCount = mb[2];
  if (byteCount <= 0 || body.length < 3 + byteCount) {
    throw new Error('Modbus-Nutzlast unvollstaendig');
  }
  const regs = [];
  for (let i = 0; i < byteCount >> 1; i++) regs.push(mb.readUInt16BE(3 + i * 2));
  return regs;
}

// --- Solarman V5 wrapper -----------------------------------------------------

/**
 * v5Checksum - sum of every byte EXCEPT the start (index 0), the checksum byte
 * (index len-2) and the end byte (index len-1), taken mod 256.
 */
function v5Checksum(frame) {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum = (sum + frame[i]) & 0xff;
  return sum & 0xff;
}

/** normLoggerSerial - accept a number or a decimal/hex string; guard u32 range. */
function normLoggerSerial(serial) {
  let n = typeof serial === 'string' ? Number(serial.trim()) : serial;
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
    throw new Error('Logger-Seriennummer ungueltig (positive Ganzzahl erwartet): ' + serial);
  }
  n = n >>> 0 === n ? n : n; // keep as-is; range checked below
  if (n > 0xffffffff) {
    throw new Error('Logger-Seriennummer ausserhalb 32-Bit: ' + serial);
  }
  return n >>> 0;
}

/**
 * buildV5Request - wrap a Modbus-RTU frame in a Solarman V5 request frame.
 * `sequence` (0..65535) is echoed back by the logger; the caller increments it.
 */
function buildV5Request({ loggerSerial, sequence = 0, modbusFrame }) {
  if (!Buffer.isBuffer(modbusFrame)) throw new Error('modbusFrame muss ein Buffer sein');
  const serial = normLoggerSerial(loggerSerial);
  const length = V5_REQUEST_PREAMBLE + modbusFrame.length;

  const header = Buffer.alloc(11);
  header[0] = V5_START;
  header.writeUInt16LE(length, 1);
  header.writeUInt16LE(V5_CONTROL_REQUEST, 3);
  header.writeUInt16LE(sequence & 0xffff, 5);
  header.writeUInt32LE(serial, 7);

  const preamble = Buffer.alloc(V5_REQUEST_PREAMBLE); // zero-filled
  preamble[0] = V5_FRAME_TYPE; // + sensortype(2) + 3x u32 all zero

  // Assemble with a placeholder checksum, then stamp it.
  const frame = Buffer.concat([header, preamble, modbusFrame, Buffer.from([0x00, V5_END])]);
  frame[frame.length - 2] = v5Checksum(frame);
  return frame;
}

/**
 * expectedFrameLength - total byte length a V5 frame claims via its length
 * field (header 11 + payload `length` + checksum/end 2). Returns null until at
 * least the 3 header bytes carrying the length are present. The socket reader
 * uses this to know when a complete frame has arrived across TCP segments.
 */
function expectedFrameLength(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 3) return null;
  if (buf[0] !== V5_START) throw new Error('ungueltiges Startbyte 0x' + buf[0].toString(16));
  return 11 + buf.readUInt16LE(1) + 2;
}

/**
 * parseV5Response - validate the V5 wrapper and return the embedded Modbus
 * frame plus header fields. Throws on a bad start/end byte, a frame shorter
 * than its length field, a wrong V5 checksum, or (when the corresponding
 * `expect*` option is given) a serial / sequence / control-code mismatch.
 */
function parseV5Response(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 13) throw new Error('Solarman-V5-Frame zu kurz');
  if (buf[0] !== V5_START) throw new Error('ungueltiges Startbyte 0x' + buf[0].toString(16));

  const length = buf.readUInt16LE(1);
  const total = 11 + length + 2;
  if (buf.length < total) throw new Error('Frame kuerzer als Laengenfeld (' + buf.length + '<' + total + ')');
  const frame = buf.slice(0, total);
  if (frame[frame.length - 1] !== V5_END) throw new Error('ungueltiges Endbyte 0x' + frame[frame.length - 1].toString(16));

  const csum = v5Checksum(frame);
  if (csum !== frame[frame.length - 2]) {
    throw new Error('V5-Pruefsumme falsch (0x' + frame[frame.length - 2].toString(16) + ' != 0x' + csum.toString(16) + ')');
  }

  const controlCode = frame.readUInt16LE(3);
  const sequence = frame.readUInt16LE(5);
  const loggerSerial = frame.readUInt32LE(7);
  const frameType = frame[11];
  const status = frame[V5_RESPONSE_STATUS_OFFSET];

  // fail() builds an Error carrying the parsed V5 header + the full raw frame hex,
  // so the write executor can log the raw request/response bytes on a failure
  // (the ONE field test that settles a real logger). Never on the happy path.
  const fail = (message) => {
    const err = new Error(message);
    err.v5 = {
      controlCode,
      sequence,
      loggerSerial,
      frameType,
      frameTypeLabel: v5FrameTypeLabel(frameType),
      status,
      frameHex: hexdump(frame),
    };
    err.frameHex = err.v5.frameHex;
    return err;
  };

  if (controlCode !== V5_CONTROL_RESPONSE) {
    throw new Error('unerwarteter V5-Controlcode 0x' + controlCode.toString(16) + ' (erwartet 0x1510)');
  }
  if (opts.expectLoggerSerial !== undefined && normLoggerSerial(opts.expectLoggerSerial) !== loggerSerial) {
    throw new Error('Logger-Seriennummer im Frame weicht ab: ' + loggerSerial);
  }
  if (opts.expectSequence !== undefined && (opts.expectSequence & 0xffff) !== sequence) {
    throw new Error('Sequenznummer im Frame weicht ab: ' + sequence);
  }

  // Frame type (offset 11) MUST be 0x02 (solar inverter) to carry a Modbus reply
  // (pysolarmanv5 enforces the same). A write reply of type 0x01/0x00 means the
  // logger answered but NOT with an inverter frame - name it, don't slice garbage.
  if (frameType !== V5_FRAME_TYPE) {
    throw fail(
      'V5-Frametyp 0x' + frameType.toString(16).padStart(2, '0') + ' (' + v5FrameTypeLabel(frameType) +
      ') - kein Wechselrichter-Antwortframe; der Logger meldet keine Antwort vom Wechselrichter (Status 0x' +
      status.toString(16).padStart(2, '0') + ')',
    );
  }

  const modbusFrame = frame.slice(V5_RESPONSE_MODBUS_OFFSET, frame.length - 2);
  if (modbusFrame.length < 5) {
    // The V5 wrapper is VALID (start / control code / serial / sequence / checksum
    // all passed) but the embedded Modbus payload is too short to be an RTU reply.
    // This is NOT a wrong offset - reads use the same offset 25, and a normal FC6
    // echo is 8 bytes and fits. A short/empty payload means the logger framed a
    // response the inverter did NOT (properly) answer. Name the reason so the field
    // test is decisive, instead of a bare "zu kurz".
    if (modbusFrame.length === 0) {
      throw fail(
        'Logger lieferte keine Modbus-Nutzlast (Frametyp 0x' + frameType.toString(16).padStart(2, '0') +
        '/' + v5FrameTypeLabel(frameType) + ', Status 0x' + status.toString(16).padStart(2, '0') +
        ') - der Wechselrichter hat auf die Schreibanfrage nicht geantwortet',
      );
    }
    // A 1..4-byte stub: if it looks like a Modbus exception reply (fn|0x80 + code),
    // decode it with a plain-German meaning (0x0B = gateway target failed to
    // respond = the logger was reached, the inverter was not).
    if (modbusFrame.length >= 3 && (modbusFrame[1] & 0x80)) {
      const code = modbusFrame[2];
      throw fail(
        'Modbus-Ausnahme 0x' + code.toString(16).padStart(2, '0') + ': ' + modbusExceptionText(code) +
        ' (verkuerzte Antwort ' + hexdump(modbusFrame) + ')',
      );
    }
    throw fail(
      'verkuerzte Modbus-Antwort (' + modbusFrame.length + ' Byte: ' + hexdump(modbusFrame) +
      ') - der Wechselrichter hat die Schreibanfrage nicht regulaer beantwortet',
    );
  }
  return { controlCode, sequence, loggerSerial, frameType, status, modbusFrame };
}

/**
 * readRegistersFromResponse - one-shot: unwrap a V5 response frame and decode
 * its Modbus payload into register words. Throws on any framing/CRC/exception.
 */
function readRegistersFromResponse(buf, opts = {}) {
  const v5 = parseV5Response(buf, opts);
  return parseModbusResponse(v5.modbusFrame);
}

/**
 * registerBlock - turn a V5 response for a read that started at `startReg` into
 * the `{ start, regs }` block shape `deye-decode.decode(blocks, config)` reads.
 */
function registerBlock(startReg, buf, opts = {}) {
  return { start: startReg, regs: readRegistersFromResponse(buf, opts) };
}

/**
 * buildReadRequest - convenience: build the full V5 request frame for a Modbus
 * fn-0x03 read of `count` holding registers starting at `startReg`.
 */
function buildReadRequest({ loggerSerial, sequence = 0, slaveId = 1, startReg, count }) {
  const modbusFrame = readHoldingRegistersRequest(slaveId, startReg, count);
  return buildV5Request({ loggerSerial, sequence, modbusFrame });
}

/**
 * buildWriteSingleRequest - convenience: full V5 request frame for a Modbus
 * fn-0x06 write of one holding register. The write side of the Deye control
 * adapter; only ever built for a BENCH-CERTIFIED model (report §6.7), never for
 * a guessed address.
 */
function buildWriteSingleRequest({ loggerSerial, sequence = 0, slaveId = 1, reg, value }) {
  const modbusFrame = writeSingleRegisterRequest(slaveId, reg, value);
  return buildV5Request({ loggerSerial, sequence, modbusFrame });
}

/**
 * buildWriteMultipleRequest - convenience: full V5 request frame for a Modbus
 * fn-0x10 write of contiguous holding registers.
 */
function buildWriteMultipleRequest({ loggerSerial, sequence = 0, slaveId = 1, startReg, values }) {
  const modbusFrame = writeMultipleRegistersRequest(slaveId, startReg, values);
  return buildV5Request({ loggerSerial, sequence, modbusFrame });
}

/**
 * readWriteResultFromResponse - one-shot: unwrap a V5 response frame and parse
 * its embedded Modbus write acknowledgement (fn 0x06 / 0x10). Throws on any
 * framing/CRC/exception. The register VALUE is confirmed by the fn-0x03 readback
 * loop, not by this ack.
 */
function readWriteResultFromResponse(buf, opts = {}) {
  const v5 = parseV5Response(buf, opts);
  return parseWriteResponse(v5.modbusFrame, opts);
}

module.exports = {
  // constants
  V5_START,
  V5_END,
  V5_CONTROL_REQUEST,
  V5_CONTROL_RESPONSE,
  V5_FRAME_TYPE,
  V5_RESPONSE_MODBUS_OFFSET,
  V5_FRAME_TYPES,
  MODBUS_EXCEPTIONS,
  // diagnostics
  v5FrameTypeLabel,
  modbusExceptionText,
  hexdump,
  describeV5Frame,
  // modbus
  modbusCrc16,
  readHoldingRegistersRequest,
  writeSingleRegisterRequest,
  writeMultipleRegistersRequest,
  parseModbusResponse,
  parseWriteResponse,
  // v5
  v5Checksum,
  buildV5Request,
  buildReadRequest,
  buildWriteSingleRequest,
  buildWriteMultipleRequest,
  expectedFrameLength,
  parseV5Response,
  readRegistersFromResponse,
  readWriteResultFromResponse,
  registerBlock,
  normLoggerSerial,
};
