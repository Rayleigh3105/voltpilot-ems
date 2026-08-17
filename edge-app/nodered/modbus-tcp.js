'use strict';

/**
 * modbus-tcp - the canonical, unit-tested reference for the GENERIC inverter
 * read path (brand=generic_modbus, communication=modbus_tcp): plain Modbus TCP
 * (fn 0x03, read holding registers) + a small register PROFILE that maps the
 * read block onto the flat edge/telemetry reading.
 *
 * It is the modbus_tcp twin of deye/solarman-v5.js: this module owns ONLY the
 * wire protocol + the profile decode and is dependency-free (Node `Buffer`
 * only), so it is fully testable offline. The socket lives in the flow's
 * "Modbus-TCP lesen" function node, which carries a COPY of the codec + profile
 * (a Node-RED flow is self-contained JSON and cannot `require` a repo file at
 * runtime). Keep the two in sync; this file is the source of truth + the test
 * target (see modbus-tcp.test.js).
 *
 * Modbus TCP frame (MBAP header + PDU), all big-endian:
 *   request : <txid u16> 0000 <len u16> <unit> 03 <startHi startLo> <cntHi cntLo>
 *   response: <txid u16> 0000 <len u16> <unit> 03 <byteCount> <data...>
 *   exception response: function | 0x80, one exception-code byte.
 *
 * PROFILES: the register model of the block a profile reads. Today one profile,
 * `sunspec`, matching the compact SunSpec-style block the edge/sim inverter
 * (edge/sim/sunspec-sim.js) and the retired "SunSpec Wechselrichter (Vorlage)"
 * tab used - FC3 holding registers 0..8:
 *
 *   Addr | Name                | Enc.
 *   -----+---------------------+--------------------------
 *    0   | grid_power          | int16, 0.01 kW, +import
 *    1   | pv_power            | int16, 0.01 kW, >=0
 *    2   | load_power          | int16, 0.01 kW, >=0
 *    3   | battery_power       | int16, 0.01 kW, +charge  (calibration only)
 *    4   | soc                 | uint16, 0.1 %
 *    5   | wmax_lim_pct        | uint16, 0.01 % (sf -2)
 *    6   | grid_conn_nameplate | uint16, 0.01 kW
 *
 * grid_limit_kw (the observed §14a envelope) is derived as
 *   wmax_lim_pct/100 * grid_conn_nameplate.
 *
 * A real SunSpec-conformant inverter uses the standard SunSpec model discovery
 * at base 40000; adding that is a new PROFILE entry (additive, no flow change) -
 * the routing already carries the profile id through.
 */

const FN_READ_HOLDING = 0x03;
const FN_READ_INPUT = 0x04;

// --- numeric helpers ---------------------------------------------------------

const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

// --- generic value decode (MB-M1: vp.modbus.read) ---------------------------

/**
 * registerCount - how many 16-bit register words a data type occupies (1 or
 * 2), or null for an unknown type. The register count of a generic read is
 * DERIVED from the data type - there is deliberately no free quantity field.
 */
function registerCount(dataType) {
  if (dataType === 'u16' || dataType === 's16') return 1;
  if (dataType === 'u32' || dataType === 's32' || dataType === 'float32') return 2;
  return null;
}

/**
 * decodeValue - decode register words into a number per data type + word
 * order. 16-bit types read regs[0]; 32-bit types combine two words - word
 * order 'big' = high word first (AB CD), 'little' = low word first (CD AB);
 * the byte order WITHIN a register is always big-endian per Modbus. Returns a
 * finite number or null (missing registers, unknown type, non-finite float) -
 * never NaN/Infinity.
 */
function decodeValue(regs, dataType, wordOrder) {
  if (!Array.isArray(regs)) return null;
  const words = registerCount(dataType);
  if (words === null || regs.length < words) return null;
  const w0 = regs[0] & 0xffff;
  if (dataType === 'u16') return w0;
  if (dataType === 's16') return s16(w0);
  const w1 = regs[1] & 0xffff;
  const hi = wordOrder === 'little' ? w1 : w0;
  const lo = wordOrder === 'little' ? w0 : w1;
  if (dataType === 'u32') return hi * 0x10000 + lo;
  if (dataType === 's32') {
    const raw = hi * 0x10000 + lo;
    return raw > 0x7fffffff ? raw - 0x100000000 : raw;
  }
  // float32: IEEE-754 over the big-endian byte stream of hi|lo.
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(hi, 0);
  buf.writeUInt16BE(lo, 2);
  const f = buf.readFloatBE(0);
  return isFinite(f) ? f : null;
}

// --- profiles ----------------------------------------------------------------

const PROFILES = {
  // Compact SunSpec-style block used by the sim + generic Modbus inverters that
  // expose this layout. Read FC3 from address 0, 9 registers.
  sunspec: {
    label: 'SunSpec (Standard)',
    read: { fc: FN_READ_HOLDING, addr: 0, count: 9 },
    decode(regs) {
      if (!Array.isArray(regs) || regs.length < 7) return null;
      const gridKw = s16(regs[0]) / 100; // + import / - export
      const pvKw = s16(regs[1]) / 100;
      const loadKw = s16(regs[2]) / 100;
      const socPct = regs[4] / 10;
      const wmaxLimPct = regs[5] / 100; // observed §14a limit in %
      const gridConnKw = regs[6] / 100;
      const gridLimitKw = round3((wmaxLimPct / 100) * gridConnKw);
      const reading = {
        power_kw: round3(gridKw),
        pv_power_kw: round3(pvKw),
        load_kw: round3(loadKw),
        soc_pct: round1(socPct),
        grid_limit_kw: gridLimitKw,
      };
      // battery power (+ charge / - discharge) is returned separately: the flow
      // forwards it as battery_power_kw on the LOCAL bus only (the core's
      // house-load balance with a Netz meter) - the cloud never receives it
      // and keeps deriving battery from the power balance.
      const batt_kw = round3(s16(regs[3]) / 100);
      return { reading, batt_kw };
    },
  },
};

/** profileRead - the { fc, addr, count } a profile reads, or null if unknown. */
function profileRead(profile) {
  const p = PROFILES[profile];
  return p ? { fc: p.read.fc, addr: p.read.addr, count: p.read.count } : null;
}

/** decodeProfile - decode a register array per profile into { reading, batt_kw }. */
function decodeProfile(profile, regs) {
  const p = PROFILES[profile];
  if (!p) return null;
  return p.decode(regs);
}

// --- Modbus TCP wire codec ---------------------------------------------------

/**
 * buildReadRequest - a Modbus-TCP register read frame: fn 0x03 (read holding
 * registers, the default) or fn 0x04 (read input registers) via the ADDITIVE
 * `fc` option - existing callers are byte-identical. `txid` (0..65535) is
 * echoed back by the server; the caller increments it.
 */
function buildReadRequest({ txid = 0, unitId = 1, addr, count, fc = FN_READ_HOLDING }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(txid & 0xffff, 0); // transaction id
  buf.writeUInt16BE(0x0000, 2); // protocol id (Modbus)
  buf.writeUInt16BE(6, 4); // length: unit + fn + 4 bytes
  buf[6] = unitId & 0xff;
  buf[7] = fc & 0xff;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(count & 0xffff, 10);
  return buf;
}

const FN_WRITE_SINGLE = 0x06;

/**
 * buildWriteSingleRequest - a Modbus-TCP "write single register" (fn 0x06)
 * frame. The write side of the generic_modbus / SunSpec CONTROL adapter
 * (report §4.4a): battery_power -> reg 40, control_enable -> reg 41,
 * pv_limit -> reg 42. `value` is masked to 16 bits (two's-complement power word).
 * The server echoes the request; parseWriteSingleResponse validates the echo.
 */
function buildWriteSingleRequest({ txid = 0, unitId = 1, addr, value }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(txid & 0xffff, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.writeUInt16BE(6, 4);
  buf[6] = unitId & 0xff;
  buf[7] = FN_WRITE_SINGLE;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(value & 0xffff, 10);
  return buf;
}

/**
 * parseWriteSingleResponse - validate a Modbus-TCP fn-0x06 echo reply and
 * return { addr, value }. Throws on a short frame, a txid/unit mismatch, a
 * Modbus exception (fn | 0x80) or an unexpected function code. The register's
 * effective value is confirmed by the fn-0x03 readback loop, not this echo.
 */
function parseWriteSingleResponse(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 12) throw new Error('Modbus-Schreibantwort zu kurz');
  const txid = buf.readUInt16BE(0);
  const proto = buf.readUInt16BE(2);
  const unit = buf[6];
  const fn = buf[7];
  if (proto !== 0) throw new Error('unerwartete Protokoll-ID ' + proto);
  if (opts.expectTxid !== undefined && (opts.expectTxid & 0xffff) !== txid) {
    throw new Error('Transaktions-ID weicht ab: ' + txid);
  }
  if (opts.expectUnit !== undefined && (opts.expectUnit & 0xff) !== unit) {
    throw new Error('Unit-ID weicht ab: ' + unit);
  }
  if (fn & 0x80) {
    throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16).padStart(2, '0'));
  }
  if (fn !== FN_WRITE_SINGLE) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  return { addr: buf.readUInt16BE(8), value: buf.readUInt16BE(10) };
}

/**
 * expectedFrameLength - total byte length a Modbus-TCP frame claims via its
 * MBAP length field (6-byte MBAP prefix + `length`). Returns null until the 6
 * header bytes carrying the length are present. The socket reader uses this to
 * know when a complete frame has arrived across TCP segments.
 */
function expectedFrameLength(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 6) return null;
  return 6 + buf.readUInt16BE(4);
}

/**
 * parseReadResponse - validate a Modbus-TCP register-read reply (fn 0x03 by
 * default; `opts.expectFn` accepts fn 0x04) and return its register words
 * (big-endian, index 0 = first requested register). Throws on a short frame,
 * a txid/unit mismatch (when the corresponding expect* is given), a Modbus
 * exception (fn | 0x80), an unexpected function code, or a truncated payload.
 */
function parseReadResponse(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 9) throw new Error('Modbus-TCP-Antwort zu kurz');
  const txid = buf.readUInt16BE(0);
  const proto = buf.readUInt16BE(2);
  const length = buf.readUInt16BE(4);
  const unit = buf[6];
  const fn = buf[7];
  if (proto !== 0) throw new Error('unerwartete Protokoll-ID ' + proto);
  if (opts.expectTxid !== undefined && (opts.expectTxid & 0xffff) !== txid) {
    throw new Error('Transaktions-ID weicht ab: ' + txid);
  }
  if (opts.expectUnit !== undefined && (opts.expectUnit & 0xff) !== unit) {
    throw new Error('Unit-ID weicht ab: ' + unit);
  }
  if (buf.length < 6 + length) throw new Error('Frame kuerzer als Laengenfeld');
  if (fn & 0x80) {
    throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16).padStart(2, '0'));
  }
  const expectFn = opts.expectFn === undefined ? FN_READ_HOLDING : opts.expectFn;
  if (fn !== expectFn) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  const byteCount = buf[8];
  if (byteCount <= 0 || buf.length < 9 + byteCount) {
    throw new Error('Modbus-Nutzlast unvollstaendig');
  }
  const regs = [];
  for (let i = 0; i < byteCount >> 1; i++) regs.push(buf.readUInt16BE(9 + i * 2));
  return regs;
}

const FN_WRITE_COIL = 0x05;
const FN_READ_COILS = 0x01;

/**
 * buildWriteCoilRequest - a Modbus-TCP "write single coil" (fn 0x05) frame.
 * Relay boards are very often coil-driven, and a coil is the ONE Modbus object
 * whose wire form is not the value itself: 0xFF00 means ON, 0x0000 means OFF.
 * Writing a plain 1 into that field is the classic mistake - the device sees an
 * undefined value and, depending on firmware, either refuses or does nothing.
 * `on` is therefore a BOOLEAN here, never a number the caller could get wrong.
 */
function buildWriteCoilRequest({ txid = 0, unitId = 1, addr, on }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(txid & 0xffff, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.writeUInt16BE(6, 4);
  buf[6] = unitId & 0xff;
  buf[7] = FN_WRITE_COIL;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(on ? 0xff00 : 0x0000, 10);
  return buf;
}

/**
 * parseWriteCoilResponse - validate a Modbus-TCP fn-0x05 echo and return
 * { addr, on }. Like every write echo it only proves the request was ACCEPTED;
 * whether the relay really moved is settled by the readback, never by the echo.
 */
function parseWriteCoilResponse(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 12) throw new Error('Modbus-Schreibantwort zu kurz');
  const txid = buf.readUInt16BE(0);
  const proto = buf.readUInt16BE(2);
  const unit = buf[6];
  const fn = buf[7];
  if (proto !== 0) throw new Error('unerwartete Protokoll-ID ' + proto);
  if (opts.expectTxid !== undefined && (opts.expectTxid & 0xffff) !== txid) {
    throw new Error('Transaktions-ID weicht ab: ' + txid);
  }
  if (opts.expectUnit !== undefined && (opts.expectUnit & 0xff) !== unit) {
    throw new Error('Unit-ID weicht ab: ' + unit);
  }
  if (fn & 0x80) {
    throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16).padStart(2, '0'));
  }
  if (fn !== FN_WRITE_COIL) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  return { addr: buf.readUInt16BE(8), on: buf.readUInt16BE(10) === 0xff00 };
}

/**
 * buildReadCoilsRequest - a Modbus-TCP "read coils" (fn 0x01) frame. The
 * readback half of a coil write: a coil cannot be read with fn 0x03, so a
 * switch test on a relay needs its own read.
 */
function buildReadCoilsRequest({ txid = 0, unitId = 1, addr, count = 1 }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(txid & 0xffff, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.writeUInt16BE(6, 4);
  buf[6] = unitId & 0xff;
  buf[7] = FN_READ_COILS;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(count & 0xffff, 10);
  return buf;
}

/**
 * parseReadCoilsResponse - the fn-0x01 reply as 0/1 per coil, LSB first inside
 * each byte (the Modbus packing). Returns numbers so a coil readback compares
 * to a written 0/1 without a second convention.
 */
function parseReadCoilsResponse(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 9) throw new Error('Modbus-Antwort zu kurz');
  const txid = buf.readUInt16BE(0);
  const proto = buf.readUInt16BE(2);
  const unit = buf[6];
  const fn = buf[7];
  if (proto !== 0) throw new Error('unerwartete Protokoll-ID ' + proto);
  if (opts.expectTxid !== undefined && (opts.expectTxid & 0xffff) !== txid) {
    throw new Error('Transaktions-ID weicht ab: ' + txid);
  }
  if (opts.expectUnit !== undefined && (opts.expectUnit & 0xff) !== unit) {
    throw new Error('Unit-ID weicht ab: ' + unit);
  }
  if (fn & 0x80) {
    throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16).padStart(2, '0'));
  }
  if (fn !== FN_READ_COILS) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  const byteCount = buf[8];
  if (buf.length < 9 + byteCount) throw new Error('Modbus-Antwort unvollstaendig');
  const bits = [];
  for (let i = 0; i < byteCount * 8; i++) {
    bits.push((buf[9 + (i >> 3)] >> (i & 7)) & 1);
  }
  return bits;
}

const FN_WRITE_MULTIPLE = 0x10;

/**
 * buildWriteMultipleRequest - a Modbus-TCP "write multiple registers" (fn 0x10)
 * frame over a CONTIGUOUS register block. This is the TRANSACTIONAL write form:
 * the whole block reaches the device as ONE request, so a device that applies a
 * parameter SET atomically (rather than register by register) sees a complete,
 * self-consistent command.
 *
 * It is what the Fronius Datamanager needs for the Model-123 power limitation:
 * the Fronius Modbus manual states the five registers "WMaxLimPct,
 * WMaxLimPct_WinTms, WMaxLimPct_RvrtTms, WMaxLimPct_RmpTms, WMaxLim_Ena ... can
 * be written with one command" using function code 0x10, and Victron's
 * production Fronius limiter (victronenergy/dbus-fronius,
 * software/src/sunspec_updater.cpp `SunspecLimiter::writePowerLimit`) writes
 * exactly that block with a single writeMultipleHoldingRegisters call. The
 * SAME class of bug is already documented for Deye in AGENTS.md: FC6 is
 * ACCEPTED and then silently ignored.
 *
 * `values` are masked to 16 bits each; the server answers with an echo of
 * {addr, count} which parseWriteMultipleResponse validates.
 */
function buildWriteMultipleRequest({ txid = 0, unitId = 1, addr, values }) {
  const vals = Array.isArray(values) ? values : [];
  if (vals.length < 1 || vals.length > 123) {
    throw new Error('Modbus-Blockschreibung braucht 1..123 Register');
  }
  const byteCount = vals.length * 2;
  const buf = Buffer.alloc(13 + byteCount);
  buf.writeUInt16BE(txid & 0xffff, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.writeUInt16BE(7 + byteCount, 4); // unit + fn + addr + count + bytecount + payload
  buf[6] = unitId & 0xff;
  buf[7] = FN_WRITE_MULTIPLE;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(vals.length & 0xffff, 10);
  buf[12] = byteCount & 0xff;
  for (let i = 0; i < vals.length; i++) buf.writeUInt16BE(Number(vals[i]) & 0xffff, 13 + i * 2);
  return buf;
}

/**
 * parseWriteMultipleResponse - validate a Modbus-TCP fn-0x10 echo reply and
 * return { addr, count }. Throws on a short frame, a txid/unit mismatch, a
 * Modbus exception (fn | 0x80) or an unexpected function code. Like the fn-0x06
 * echo this only proves the request was ACCEPTED - whether the values took
 * effect is settled by the fn-0x03 readback, never by this echo.
 */
function parseWriteMultipleResponse(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 12) throw new Error('Modbus-Schreibantwort zu kurz');
  const txid = buf.readUInt16BE(0);
  const proto = buf.readUInt16BE(2);
  const unit = buf[6];
  const fn = buf[7];
  if (proto !== 0) throw new Error('unerwartete Protokoll-ID ' + proto);
  if (opts.expectTxid !== undefined && (opts.expectTxid & 0xffff) !== txid) {
    throw new Error('Transaktions-ID weicht ab: ' + txid);
  }
  if (opts.expectUnit !== undefined && (opts.expectUnit & 0xff) !== unit) {
    throw new Error('Unit-ID weicht ab: ' + unit);
  }
  if (fn & 0x80) {
    throw new Error('Modbus-Ausnahme 0x' + (buf[8] || 0).toString(16).padStart(2, '0'));
  }
  if (fn !== FN_WRITE_MULTIPLE) {
    throw new Error('unerwartete Modbus-Funktion 0x' + fn.toString(16).padStart(2, '0'));
  }
  return { addr: buf.readUInt16BE(8), count: buf.readUInt16BE(10) };
}

module.exports = {
  FN_READ_HOLDING,
  FN_READ_INPUT,
  FN_READ_COILS,
  FN_WRITE_COIL,
  buildWriteCoilRequest,
  parseWriteCoilResponse,
  buildReadCoilsRequest,
  parseReadCoilsResponse,
  FN_WRITE_SINGLE,
  FN_WRITE_MULTIPLE,
  PROFILES,
  profileRead,
  decodeProfile,
  registerCount,
  decodeValue,
  buildReadRequest,
  buildWriteSingleRequest,
  parseWriteSingleResponse,
  buildWriteMultipleRequest,
  parseWriteMultipleResponse,
  expectedFrameLength,
  parseReadResponse,
  _helpers: { s16, round3, round1 },
};
