'use strict';

/**
 * kostal-decode - the canonical, unit-tested read path for the KOSTAL
 * PLENTICORE battery inverter family (brand=kostal, communication=
 * kostal_modbus): plain Modbus TCP on the vendor's own server (TCP port 1502,
 * Unit-ID 71) + the fixed register map of the official interface description
 * ("PIKO IQ/PLENTICORE - KOSTAL Interface description MODBUS (TCP) & SunSpec
 * with control information", Rev. 2.9, 2026-07-17). Scout report:
 * firstmate data/vp-kostal-plenticore-s5/report.md.
 *
 * SCOPE: the PLENTICORE BI (battery-only, no MPPTs - the DC side IS the
 * battery). It publishes battery power + SoC + (via an attached KOSTAL Smart
 * Energy Meter) the grid power; deliberately NO pv_power_kw and NO load_kw -
 * PV comes from the site's other inverters (Erzeuger sources) and the house
 * load from the core's balance (Haus = Erzeugung - Einspeisung - Batterie).
 * The hybrid PLENTICORE plus is NOT offered through this family yet: its PV
 * DC-string registers are not decoded here, and a battery-only read of a
 * PV-carrying hybrid would silently understate the house balance.
 *
 * Facts of the wire protocol that are load-bearing (all from the official
 * doc, corroborated by OpenEMS io.openems.edge.kostal + evcc):
 *   - TCP 1502, Unit-ID 71 (both changeable on the device; register 4 holds
 *     the unit id).
 *   - Register 5 = "MODBUS Byte Order" for two-word values: 0x00 =
 *     little-endian (CDAB, word-swapped - the FACTORY DEFAULT), 0x01 =
 *     big-endian (ABCD). Bytes inside a register are always big-endian per
 *     Modbus. This module auto-detects from register 5 each cycle (an
 *     explicit byte_order overrides).
 *   - Battery sign convention (doc note 1 + register 200's own label):
 *     NEGATIVE = charge, POSITIVE = discharge - the OPPOSITE of VoltPilot's
 *     battery_power_kw (+ charge / - discharge), so the decode NEGATES;
 *     invert_batt_sign is the operator escape hatch on top (VERIFY on the
 *     real device, First-Light discipline).
 *   - Grid power (register 252, "Total active power (powermeter)") is signed
 *     per the CONFIGURED sensor position: position 2 (grid connection point,
 *     the KSEM default for BI systems) = + Bezug / - Einspeisung, which IS
 *     VoltPilot's power_kw convention; position 1 (home consumption) reads
 *     differently -> invert_grid_sign / calibration decide. The value is
 *     only published while a sensor is actually installed (register 1082
 *     "Installed sensor type" != 0xFF) - never a fabricated 0 without one.
 *
 * Read/monitoring only: NOTHING here controls the inverter. The control path
 * (external battery management, registers 1024..1044) is a separate, gated
 * increment - see the scout report Part 3.
 *
 * The flow's "KOSTAL PLENTICORE lesen" function node EMBEDS this module
 * verbatim (a Node-RED flow is self-contained JSON and cannot `require` a
 * repo file at runtime; build-flows.js embeds, flows-sync.test.js pins).
 * Dependency-free (Node `Buffer` only), fully testable offline.
 */

// --- register map (decimal addresses; official doc §3.2/§3.4) ---------------

const REG = {
  BYTE_ORDER: 5, // U16: 0 little (CDAB, factory default) / 1 big (ABCD)
  INVERTER_STATE: 56, // U32: 0 Off .. 6 FeedIn, 7 Throttled, 10 Standby ...
  POWERMETER_TOTAL_W: 252, // Float: sign per sensor position (see header)
  BATTERY_SOC_PCT: 514, // U16: battery actual SoC in %
  INVERTER_MAX_POWER_W: 531, // U16: nameplate check (BI 10/26 -> 10000)
  BATTERY_POWER_W: 582, // S16: actual battery power, + discharge / - charge
  BATTERY_TYPE: 588, // U16: 0x0004 BYD, 0x0040 LG, 0x0200 Pylontech ...
  BATTERY_WORK_CAPACITY_WH: 1068, // Float
  BMS_MAX_CHARGE_W: 1076, // Float: charge limit read out from the battery
  BMS_MAX_DISCHARGE_W: 1078, // Float: discharge limit read out from the battery
  BATTERY_MGMT_MODE: 1080, // U8: 0 none / 1 external digital I/O / 2 external MODBUS
  SENSOR_TYPE: 1082, // U8: 0x03 KSEM ... 0xFF no sensor
};

// "No sensor installed" marker of register 1082.
const SENSOR_NONE = 0xff;

// Battery management modes (register 1080). MODE_EXTERNAL_MODBUS is the value
// the future control adapter gates on (the activation probe).
const MGMT_MODE_NONE = 0x00;
const MGMT_MODE_EXTERNAL_IO = 0x01;
const MGMT_MODE_EXTERNAL_MODBUS = 0x02;

const DEFAULT_PORT = 1502;
const DEFAULT_UNIT_ID = 71;

// --- families ----------------------------------------------------------------
//
// One register family covers the PLENTICORE BI line (G1/G2 speak the same map).
// Mirrors the deye-decode.FAMILIES shape so inverter-routing can gate on the
// known set.
const FAMILIES = {
  kostal_plenticore: {
    label: 'KOSTAL PLENTICORE BI',
    hasBattery: true,
  },
};

/**
 * planReads - the FC3 read blocks one poll cycle fetches. Fixed per family
 * (unlike SunSpec there is no discovery walk - the map is the official doc).
 * Every block is well under the 125-register FC3 maximum; each is read in its
 * own request so a single refused block degrades to absent channels instead
 * of killing the whole reading.
 */
function planReads(cfg) {
  const family = cfg && cfg.family;
  if (!FAMILIES[family]) return [];
  return [
    { start: REG.BYTE_ORDER, count: 1 }, // byte-order auto-detect
    { start: REG.INVERTER_STATE, count: 2 }, // status (meta only)
    { start: REG.POWERMETER_TOTAL_W, count: 2 }, // grid power (via KSEM)
    { start: REG.BATTERY_SOC_PCT, count: 75 }, // 514..588: SoC, max power, battery power, battery type
    { start: REG.BATTERY_WORK_CAPACITY_WH, count: 16 }, // 1068..1083: capacity, BMS limits, mgmt mode, sensor
  ];
}

// --- numeric helpers ---------------------------------------------------------

const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

// The socPlausible discipline (deye-decode/guards.SocPlausible): a SoC outside
// (0, 100] is a comms artefact, never a fact - drop the channel, don't publish.
function socPlausible(p) {
  return typeof p === 'number' && isFinite(p) && p > 0 && p <= 100;
}

/**
 * resolveByteOrder - the effective two-word order: an explicit configuration
 * ('little'/'big') wins; 'auto'/absent reads register 5 (0 -> little, 1 ->
 * big); an unreadable register 5 falls back to 'little' (the factory
 * default) - a wrong guess shows up as absurd floats, never silently as a
 * plausible-but-wrong value (floats decode to NaN/huge and are dropped by the
 * finite checks below).
 */
function resolveByteOrder(configured, reg5) {
  if (configured === 'little' || configured === 'big') return configured;
  if (reg5 === 1) return 'big';
  return 'little';
}

// regAt - the raw u16 at absolute address `addr` out of the block list
// ([{start, regs}]), or null when no block covers it (failed/absent read).
function regAt(blocks, addr) {
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (!b || !Array.isArray(b.regs)) continue;
    const start = Number(b.start);
    if (!Number.isInteger(start)) continue;
    const i = addr - start;
    if (i >= 0 && i < b.regs.length) {
      const v = b.regs[i];
      return typeof v === 'number' && isFinite(v) ? v & 0xffff : null;
    }
  }
  return null;
}

// two words at addr (+addr+1) resolved per word order into { hi, lo }.
function words2(blocks, addr, wordOrder) {
  const w0 = regAt(blocks, addr);
  const w1 = regAt(blocks, addr + 1);
  if (w0 === null || w1 === null) return null;
  return wordOrder === 'big' ? { hi: w0, lo: w1 } : { hi: w1, lo: w0 };
}

function f32At(blocks, addr, wordOrder) {
  const w = words2(blocks, addr, wordOrder);
  if (!w) return null;
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(w.hi, 0);
  buf.writeUInt16BE(w.lo, 2);
  const f = buf.readFloatBE(0);
  return isFinite(f) ? f : null;
}

function u32At(blocks, addr, wordOrder) {
  const w = words2(blocks, addr, wordOrder);
  if (!w) return null;
  return w.hi * 0x10000 + w.lo;
}

/**
 * decode - turn the read blocks into the flat edge/telemetry reading.
 *
 *   blocks: [{ start, regs: [u16] }] (a failed block is simply absent)
 *   opts:   { invertGridSign?, invertBattSign?, byteOrder? ('auto'|'little'|'big') }
 *
 * Returns { reading, battKw, meta } or null when not a single channel
 * decoded. `reading` carries ONLY the channels that are genuinely present
 * (absent-not-zero discipline):
 *   - soc_pct   from 514, dropped outside (0, 100]
 *   - power_kw  from 252, ONLY while a sensor is installed (1082 != 0xFF)
 * `battKw` is the measured battery power in VoltPilot convention (+ charge /
 * - discharge; register sign NEGATED - see header), null when unreadable. It
 * is returned separately like the other decoders: the flow forwards it as
 * battery_power_kw on the LOCAL bus only (the core's house balance); the
 * cloud keeps deriving battery from the power balance.
 * `meta` carries diagnostic facts for test-read / the future control gate
 * (inverter state, battery mgmt mode, BMS limits, byte order used).
 */
function decode(blocks, opts) {
  opts = opts || {};
  const wordOrder = resolveByteOrder(opts.byteOrder, regAt(blocks, REG.BYTE_ORDER));

  const reading = {};

  const socRaw = regAt(blocks, REG.BATTERY_SOC_PCT);
  if (socRaw !== null && socPlausible(socRaw)) reading.soc_pct = round1(socRaw);

  const sensorType = regAt(blocks, REG.SENSOR_TYPE);
  const gridW = f32At(blocks, REG.POWERMETER_TOTAL_W, wordOrder);
  if (gridW !== null && sensorType !== null && sensorType !== SENSOR_NONE) {
    const sign = opts.invertGridSign ? -1 : 1;
    reading.power_kw = round3((sign * gridW) / 1000);
  }

  // Battery power: register 582 is S16 watts, + discharge / - charge (doc
  // note 1). VoltPilot's convention is + charge / - discharge, so NEGATE;
  // invert_batt_sign flips on top (firmware oddity escape hatch, verify on
  // device).
  let battKw = null;
  const battRaw = regAt(blocks, REG.BATTERY_POWER_W);
  if (battRaw !== null) {
    const sign = opts.invertBattSign ? -1 : 1;
    battKw = round3((sign * -s16(battRaw)) / 1000);
  }

  const meta = {
    byte_order: wordOrder,
    state: u32At(blocks, REG.INVERTER_STATE, wordOrder),
    inverter_max_power_w: regAt(blocks, REG.INVERTER_MAX_POWER_W),
    battery_type: regAt(blocks, REG.BATTERY_TYPE),
    battery_mgmt_mode: regAt(blocks, REG.BATTERY_MGMT_MODE),
    sensor_type: sensorType,
    bms_max_charge_w: f32At(blocks, REG.BMS_MAX_CHARGE_W, wordOrder),
    bms_max_discharge_w: f32At(blocks, REG.BMS_MAX_DISCHARGE_W, wordOrder),
    battery_work_capacity_wh: f32At(blocks, REG.BATTERY_WORK_CAPACITY_WH, wordOrder),
  };

  if (Object.keys(reading).length === 0 && battKw === null) return null;
  return { reading, battKw, meta };
}

/**
 * makeKostalReader - deps-injected socket reader (the sunspec-live
 * makeSunspecReader pattern): ONE ordered TCP connection per poll, the
 * planReads blocks read sequentially over it, decoded per the options.
 * Resolves { reading, battKw, meta } or null (unreachable / not a single
 * block answered). A single refused block only drops its channels.
 *
 *   deps: { net, connectTimeoutMs?, readTimeoutMs? }
 *   target: { ip, port?, unitId?, invertGridSign?, invertBattSign?, byteOrder? }
 */
function makeKostalReader(deps) {
  const net = deps.net;
  const CONNECT_TIMEOUT_MS = deps.connectTimeoutMs || 8000;
  const READ_TIMEOUT_MS = deps.readTimeoutMs || 8000;

  return function readKostal(target) {
    target = target || {};
    const ip = typeof target.ip === 'string' ? target.ip.trim() : '';
    const port = Number(target.port) > 0 ? Number(target.port) : DEFAULT_PORT;
    const unitId = Number(target.unitId) > 0 ? Number(target.unitId) : DEFAULT_UNIT_ID;
    if (!ip) return Promise.resolve(null);

    const plan = planReads({ family: 'kostal_plenticore' });

    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setNoDelay(true);
      let settled = false;
      let acc = Buffer.alloc(0);
      let pending = null; // the one outstanding request { res, rej, wantTxid }
      let txid = 0;

      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(readTimer);
        try { sock.destroy(); } catch (e) { /* ignore */ }
        resolve(res);
      };

      const connectTimer = setTimeout(() => done(null), CONNECT_TIMEOUT_MS);
      let readTimer = null;
      const armReadTimer = () => {
        clearTimeout(readTimer);
        readTimer = setTimeout(() => done(null), READ_TIMEOUT_MS);
      };

      sock.once('error', () => done(null));

      const readBlock = (addr, count) => new Promise((res, rej) => {
        txid = (txid + 1) & 0xffff;
        const wantTxid = txid;
        const buf = Buffer.alloc(12);
        buf.writeUInt16BE(wantTxid, 0);
        buf.writeUInt16BE(0, 2);
        buf.writeUInt16BE(6, 4);
        buf[6] = unitId & 0xff;
        buf[7] = 0x03;
        buf.writeUInt16BE(addr & 0xffff, 8);
        buf.writeUInt16BE(count & 0xffff, 10);
        pending = { res, rej, wantTxid };
        acc = Buffer.alloc(0);
        armReadTimer();
        sock.write(buf);
      });

      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        if (!pending) return;
        if (acc.length < 6) return;
        const need = 6 + acc.readUInt16BE(4);
        if (acc.length < need) return;
        const frame = acc.slice(0, need);
        acc = acc.slice(need);
        const p = pending;
        pending = null;
        clearTimeout(readTimer);
        try {
          if (frame.readUInt16BE(0) !== p.wantTxid) throw new Error('txid');
          const fn = frame[7];
          if (fn & 0x80) throw new Error('exception 0x' + (frame[8] || 0).toString(16));
          if (fn !== 0x03) throw new Error('fn 0x' + fn.toString(16));
          const bc = frame[8];
          if (bc <= 0 || frame.length < 9 + bc) throw new Error('short payload');
          const regs = [];
          for (let i = 0; i < bc >> 1; i++) regs.push(frame.readUInt16BE(9 + i * 2));
          p.res(regs);
        } catch (e) {
          p.rej(e);
        }
      });

      sock.connect(port, ip, async () => {
        clearTimeout(connectTimer);
        const blocks = [];
        for (const b of plan) {
          try {
            const regs = await readBlock(b.start, b.count);
            blocks.push({ start: b.start, regs });
          } catch (e) {
            // A refused/garbled block degrades to absent channels; the
            // remaining blocks are still read (per-block error isolation).
          }
        }
        if (!blocks.length) return done(null);
        done(decode(blocks, {
          invertGridSign: !!target.invertGridSign,
          invertBattSign: !!target.invertBattSign,
          byteOrder: target.byteOrder,
        }));
      });
    });
  };
}

module.exports = {
  REG,
  FAMILIES,
  DEFAULT_PORT,
  DEFAULT_UNIT_ID,
  SENSOR_NONE,
  MGMT_MODE_NONE,
  MGMT_MODE_EXTERNAL_IO,
  MGMT_MODE_EXTERNAL_MODBUS,
  planReads,
  resolveByteOrder,
  socPlausible,
  decode,
  makeKostalReader,
  _helpers: { s16, round3, round1, regAt, f32At, u32At },
};
