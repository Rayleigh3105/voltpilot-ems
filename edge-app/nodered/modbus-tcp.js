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

// --- numeric helpers ---------------------------------------------------------

const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

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
      // battery power is read for status/calibration only - never published
      // (the cloud derives it from the power balance).
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
 * buildReadRequest - a Modbus-TCP "read holding registers" (fn 0x03) frame.
 * `txid` (0..65535) is echoed back by the server; the caller increments it.
 */
function buildReadRequest({ txid = 0, unitId = 1, addr, count }) {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(txid & 0xffff, 0); // transaction id
  buf.writeUInt16BE(0x0000, 2); // protocol id (Modbus)
  buf.writeUInt16BE(6, 4); // length: unit + fn + 4 bytes
  buf[6] = unitId & 0xff;
  buf[7] = FN_READ_HOLDING;
  buf.writeUInt16BE(addr & 0xffff, 8);
  buf.writeUInt16BE(count & 0xffff, 10);
  return buf;
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
 * parseReadResponse - validate a Modbus-TCP fn-0x03 reply and return its
 * register words (big-endian, index 0 = first requested register). Throws on a
 * short frame, a txid/unit mismatch (when the corresponding expect* is given), a
 * Modbus exception (fn | 0x80), an unexpected function code, or a truncated
 * payload.
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
  if (fn !== FN_READ_HOLDING) {
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

module.exports = {
  FN_READ_HOLDING,
  PROFILES,
  profileRead,
  decodeProfile,
  buildReadRequest,
  expectedFrameLength,
  parseReadResponse,
  _helpers: { s16, round3, round1 },
};
