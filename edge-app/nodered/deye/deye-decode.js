'use strict';

/**
 * deye-decode - the canonical, unit-tested reference for the Deye Node-RED
 * template ("Deye (Vorlage)" tab in flows.json).
 *
 * It owns four things the flow's function nodes also implement inline:
 *   1. FAMILIES        - the per-family Modbus register map + scaling.
 *   2. parseOk()       - the `+ok=0103...` Modbus-read response parser.
 *   3. decode()        - raw register blocks -> the flat edge/telemetry reading.
 *   4. helpers         - read-plan, read-command and power-limit-write builders,
 *                        plus the SoC-probe hybrid family auto-detect.
 *
 * The `edge-app/nodered/flows.json` function nodes carry a COPY of this logic
 * (a Node-RED flow must be self-contained JSON - it cannot `require` a repo
 * file at runtime). This module is the source of truth and the test target;
 * keep the two in sync (see deye-decode.test.js).
 *
 * Tool: `deye` (github.com/s10l/deye-logger-at-cmd), a Go CLI that speaks the
 * Deye WiFi logger's AT-command Modbus tunnel:
 *   read : deye -t <ip>:<port> -xmb  <REGHEX4><COUNTHEX4>   (Modbus fn 0x03)
 *   write: deye -t <ip>:<port> -xmbw <REGHEX4><COUNTHEX4><VALLENHEX2><VALUEHEX>
 * A read answers `+ok=0103<byteCountHEX><dataHEX><crc16HEX>`.
 *
 * 32-bit values are LOW-WORD-FIRST: value = (reg[addr+1] << 16) + reg[addr].
 *
 * The register maps are taken from StephanJoubert/home_assistant_solarman's
 * Deye definition library (the community reference for reading Deye over a
 * Solarman logger). The five ha-solarman Deye definitions collapse to FOUR
 * distinct maps, one per family here:
 *
 *   ha-solarman definition        | family      | Deye models (examples)
 *   ------------------------------|-------------|--------------------------------
 *   deye_string.yaml              | string      | SUN-*-G03/G04 string grid-tie
 *   deye_2mppt / deye_4mppt.yaml  | micro       | SUN600..2000G3 micro-inverters
 *   deye_hybrid.yaml (low map)    | hybrid_1p   | SUN-*-SG03LP1 1-phase hybrid
 *   deye_sg04lp3.yaml (high map)  | hybrid_3p   | SUN-*-SG04LP3 (LV) / SG01HP3 (HV)
 *
 * See the model->family table in DEYE.md.
 *
 * IMPORTANT: the ADDRESSES are authoritative from ha-solarman, but all raw
 * SIGNS are firmware-dependent and MUST be verified on the actual device (see
 * the sign-calibration procedure in DEYE.md). The per-inverter
 * `invert_grid_sign` / `invert_batt_sign` flags exist precisely because raw
 * grid/battery signs differ between firmwares.
 *
 * HV/LV POWER SCALE (hybrid_3p) - auto-detected, mirroring ha-solarman. In
 * davidrapan/ha-solarman `deye_p3.yaml` the PV Power and Battery Power sensors
 * carry a dual `scale: [1, 10]` (LV=1 W, HV=10 W/decawatt) - and ha-solarman
 * AUTO-DETECTS which one from the "Device" identity register 0x0000
 * (const.py AUTODETECTION_DEYE: LV codes -> mod 0 -> scale 1; HV codes -> mod 1
 * -> scale 10). Grid Power and Load Consumption Power carry NO scale attribute
 * (always plain watts) and are 32-bit low+high word (rule 4). We mirror all of
 * this: `decode()` reads 0x0000, maps it to the LV/HV scale, applies it ONLY to
 * PV + battery (never grid/load/SoC). The optional `power_scale` config field is
 * now a MANUAL OVERRIDE / fallback: an explicit 1 or 10 wins over auto-detect,
 * and 1 is the fallback when 0x0000 is unreadable (never fabricate a class).
 */

// --- core telemetry sign convention ------------------------------------------
// power_kw:   + = grid IMPORT / - = grid EXPORT   (docs/contracts/mqtt-telemetry.schema.json)
// batt_kw:    + = charge       / - = discharge    (matches edge/setpoint; NOT a cloud
//             telemetry field - the cloud derives battery from the power balance, so we
//             read it only as a calibration aid / status text).

// --- hybrid_3p HV/LV scale auto-detect (ha-solarman `mod`) -------------------
// The "Device" identity register 0x0000 (deye_p3.yaml Device sensor) carries a
// device-type code. ha-solarman maps it to `mod` (const.py AUTODETECTION_DEYE):
//   LV codes -> mod 0 -> PV/battery scale [1,10][0] = 1 (native watts)
//   HV codes -> mod 1 -> PV/battery scale [1,10][1] = 10 (decawatt firmware)
// The HV set includes 0x0008/0x0601 = "HV 3-Phase Inverter 20-50kw", the exact
// class the SUN-30K-SG01HP3-EU sits in. An unknown/unreadable code -> no class
// (caller falls back to the manual power_scale, default 1).
const DEVICE_REG = 0x0000;
const DEVICE_TYPES_LV = [0x0005, 0x0500]; // mod 0 -> scale 1
const DEVICE_TYPES_HV = [0x0006, 0x0007, 0x0600, 0x0008, 0x0601]; // mod 1 -> scale 10

const FAMILIES = {
  // Deye grid-tie STRING inverter, NO battery, NO house-load/grid meter
  // (ha-solarman deye_string.yaml; SUN-*-G03/G04 string models, 1-2 MPPT).
  // A string inverter only knows its OWN AC output - it has no grid-import/
  // export or house-load register (those are hybrid features). ha-solarman's
  // headline power for it is "Total Output AC Power" at 0x0050/0x0051
  // (32-bit low-word-first, x0.1 -> W); that AC output already sums ALL PV
  // strings post-inverter, so it is MPPT-count-agnostic (1..4 MPPT). We expose
  // it as pv_power_kw (the plant's generation). Per-string DC detail (PVn V/I
  // at 0x006D..) is listed in DEYE.md for operators who want it; the cloud only
  // needs the generation total. The active-power-limit WRITE (0x0028) stays.
  string: {
    label: 'String / netzgekoppelt (ohne Speicher)',
    hasBattery: false,
    // Just the AC-output pair (ha-solarman reads 0x0003..0x0070 for the full
    // sensor set; we only need generation). One small block.
    reads: [{ start: 0x0050, count: 0x0002 }],
    fields: {
      // "Total Output AC Power" = total PV generation across all MPPT strings.
      pv: { addr: 0x0050, bits: 32, signed: false, scale: 0.1 }, // raw x0.1 -> W
    },
  },

  // Deye single-phase hybrid, "low" holding-register map
  // (ha-solarman deye_hybrid.yaml; SUN-5/6/8/10/12K-SG03LP1). Verified against
  // the definition: SOC 184, load 178, grid 169 (s16), batt 190 (s16),
  // PV1 186 + PV2 187 (u16, summed). All scale 1 -> W / %.
  hybrid_1p: {
    label: 'Hybrid 1-phasig (SG03LP1, low map)',
    hasBattery: true,
    reads: [{ start: 0x00a9, count: 0x0016 }], // 0x00A9..0x00BE
    fields: {
      grid: { addr: 0x00a9, bits: 16, signed: true, scale: 1 }, // reg 169, W (signed)
      load: { addr: 0x00b2, bits: 16, signed: false, scale: 1 }, // reg 178, W
      soc: { addr: 0x00b8, bits: 16, signed: false, scale: 1, kind: 'pct' }, // reg 184, %
      pv: { addrs: [0x00ba, 0x00bb], bits: 16, signed: false, scale: 1, sum: true }, // reg 186+187, W
      batt: { addr: 0x00be, bits: 16, signed: true, scale: 1 }, // reg 190, W (calibration only)
    },
  },

  // Deye three-phase hybrid, "high" holding-register map. Covers the LV line
  // (SUN-5..12K-SG04LP3, 2 MPPT) AND the HV line
  // (SUN-29.9/30/35/40/50K-SG01HP3-EU-BM3/BM4, 3-4 MPPT). They share this modbus
  // map (there is no separate SG01HP3 definition in ha-solarman); the only
  // per-model difference is the MPPT count, so PV sums ALL FOUR tracker power
  // registers (an absent PV3/PV4 reads 0 and is harmless).
  // Addresses are authoritative from davidrapan/ha-solarman deye_p3.yaml (SG0*LP3
  // LV + SG0*HP3 HV): SOC 0x024C, Battery Power 0x024E (scale [1,10]), PV Power =
  // sum of 0x02A0..0x02A3 (scale [1,10]); Load Consumption Power =
  // 0x028D(low)+0x0293(high), signed 32-bit (rule 4), always plain watts.
  //
  // GRID = the EXTERNAL CT total 0x026B(low)+0x02C4(high) ("Grid external - The
  // power", deye_p3.yaml "External Power") - the clamp at the point of common
  // coupling, i.e. the site's true grid exchange. The previously-used "Grid
  // Power" 0x0271(low)+0x02B2(high) sits under deye_p3.yaml's comment "The
  // following three (four) registers change according to the built-in and
  // external settings": it is a CONFIG-DEPENDENT alias that can resolve to the
  // inverter-side (internal CT 0x025F) measurement instead of the connection
  // point. Proven live on the captain's SUN-30K-SG01HP3 (2026-07-17): the alias
  // read −23,7 kW = exactly the Deye's own PV while the device's own load
  // register showed −30,5 = 23,7 − 54,2, i.e. the Deye internally used the
  // external CT's −54,2 kW - the true site export (whole site incl. ~49 kW
  // AC-coupled Fronius). The alias is kept as a FALLBACK for reads that do not
  // cover the external high word (e.g. a stale flow still reading the old
  // narrower block). Device-identity register 0x0000 selects the LV/HV scale
  // for PV + battery (see DEVICE_TYPES_* above); grid/load are always plain
  // watts. Signs (invert_grid_sign/invert_batt_sign) stay VERIFY-on-device -
  // and so does the external CT itself (an install without the external CT
  // clamps would read 0 here; verify import/export at a known state).
  hybrid_3p: {
    label: 'Hybrid 3-phasig (SG04LP3 LV / SG01HP3 HV, high map, bis 4 MPPT)',
    hasBattery: true,
    // Two blocks: the device-identity register 0x0000 (LV/HV scale class) and
    // the measurement block 0x024C..0x02C4 (121 regs, still under the 125-reg
    // fn-0x03 limit) - wide enough to include the External-CT high word at
    // 0x02C4 (and the alias high word 0x02B2 for the fallback).
    reads: [
      { start: DEVICE_REG, count: 0x0001 },
      { start: 0x024c, count: 0x0079 },
    ],
    // The register whose device-type code drives the LV/HV PV+battery scale.
    scaleReg: DEVICE_REG,
    fields: {
      soc: { addr: 0x024c, bits: 16, signed: false, scale: 1, kind: 'pct' }, // %
      // PV + battery carry the ha-solarman [1,10] LV/HV scale -> hvScale flag.
      batt: { addr: 0x024e, bits: 16, signed: true, hvScale: true }, // W (house-balance battery term + calibration)
      // Grid: External CT total = the connection point (+ import / - export).
      grid: { addrs: [0x026b, 0x02c4], bits: 32, signed: true },
      // Fallback grid: the config-dependent "Grid Power" alias (see above).
      gridFallback: { addrs: [0x0271, 0x02b2], bits: 32, signed: true },
      load: { addrs: [0x028d, 0x0293], bits: 32, signed: true }, // house load (inverter's own view)
      // PV1..PV4 power (BM3 uses 3, BM4 uses 4; PV4=0 on LV/BM3).
      pv: { addrs: [0x02a0, 0x02a1, 0x02a2, 0x02a3], bits: 16, signed: false, sum: true, hvScale: true },
    },
  },

  // Deye / Bosswerk MICRO-inverter (ha-solarman deye_2mppt.yaml = SUN600..1600G3,
  // 2 MPPT; deye_4mppt.yaml = SUN2000G3, 4 MPPT). Both surface generation as a
  // single "Total AC Output Power (Active)" register at 0x0056/0x0057 (32-bit
  // low-word-first, x0.1 -> W) - post-inverter, so it sums all MPPTs and is
  // MPPT-count-agnostic. No battery, no grid meter, no SoC. We expose it as
  // pv_power_kw. The active-power-limit WRITE (0x0028) stays the control lever.
  micro: {
    label: 'Mikrowechselrichter (SUN*G3, Erzeugung + Leistungsbegrenzung)',
    hasBattery: false,
    reads: [{ start: 0x0056, count: 0x0002 }],
    fields: {
      pv: { addr: 0x0056, bits: 32, signed: false, scale: 0.1 }, // AC output, raw x0.1 -> W
    },
  },
};

// The active-power-limit control register (string + micro), a 0..100 percent.
const POWER_LIMIT_REG = 0x0028;

// --- small numeric helpers ---------------------------------------------------

const u16 = (v) => v & 0xffff;
const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};
const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;
const h4 = (n) => (n & 0xffff).toString(16).padStart(4, '0').toUpperCase();

// --- SoC plausibility gate (drop-don't-fabricate) ----------------------------
// A battery State-of-Charge is physically a 0..100 % reading, and a real BMS
// never reports an exact 0 (it cuts off well above empty). A Solarman logger
// that could NOT actually reach the inverter still answers with a well-framed,
// CRC-valid response - typically an all-zero register block (the classic
// night-time "empty answer") or, on a misaligned frame, a wildly out-of-range
// value. Decoding those verbatim published soc_pct = 0 (spikes to the axis
// floor) or soc_pct > 100 (clipped to the axis ceiling by the portal chart) and
// corrupted the SoC time series while the true stepped curve was still faintly
// underneath. So for a battery family an implausible SoC means the whole read is
// untrustworthy: the decoder drops it (returns null) and NO sample is published
// - never a fabricated 0 - and the chart simply shows a gap until the next good
// read. Non-battery families (string/micro) have no SoC and are unaffected: a
// genuine 0 kW at night is a real, kept reading.
const SOC_PCT_MIN = 0; // exclusive: an exact 0 is the empty-answer signature, not a real SoC
const SOC_PCT_MAX = 100; // inclusive: a percentage
function socPlausible(pct) {
  return typeof pct === 'number' && isFinite(pct) && pct > SOC_PCT_MIN && pct <= SOC_PCT_MAX;
}

/**
 * parseOk - extract the register array from a `deye -xmb` response string.
 * Returns an array of unsigned 16-bit register words (index 0 = first register
 * of the requested block), or null when the response is missing/truncated.
 */
function parseOk(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = stdout.match(/\+ok=0103([0-9a-fA-F]{2})([0-9a-fA-F]+)/);
  if (!m) return null;
  const byteCount = parseInt(m[1], 16);
  const hex = m[2];
  if (!Number.isFinite(byteCount) || byteCount <= 0) return null;
  if (hex.length < byteCount * 2) return null; // truncated payload
  const dataHex = hex.slice(0, byteCount * 2); // drop trailing CRC16
  const regs = [];
  for (let j = 0; j * 4 < dataHex.length; j++) {
    regs.push(parseInt(dataHex.substr(j * 4, 4), 16));
  }
  return regs;
}

/**
 * readReg - look up an absolute register address across the read blocks.
 * `blocks` is an array of { start, regs } (one per completed read).
 */
function readReg(blocks, addr) {
  for (const b of blocks) {
    const off = addr - b.start;
    if (off >= 0 && off < b.regs.length) return b.regs[off];
  }
  return undefined;
}

/**
 * fieldValue - resolve a field spec against the read blocks into its SCALED
 * physical value (watts for power, percent for SoC). undefined if unreadable.
 */
function fieldValue(blocks, f) {
  let raw;
  if (f.bits === 32) {
    // Low word first. Two consecutive regs (f.addr, f.addr+1) OR an explicit
    // [low, high] pair for non-contiguous 32-bit values (hybrid_3p grid/load).
    const loAddr = f.addrs ? f.addrs[0] : f.addr;
    const hiAddr = f.addrs ? f.addrs[1] : f.addr + 1;
    const lo = readReg(blocks, loAddr);
    const hi = readReg(blocks, hiAddr);
    if (lo === undefined || hi === undefined) return undefined;
    raw = hi * 65536 + lo; // LOW-WORD-FIRST
    if (f.signed && raw > 0x7fffffff) raw -= 0x100000000;
  } else if (f.sum) {
    raw = 0;
    for (const a of f.addrs) {
      const v = readReg(blocks, a);
      if (v === undefined) return undefined;
      raw += f.signed ? s16(v) : u16(v);
    }
  } else {
    const v = readReg(blocks, f.addr);
    if (v === undefined) return undefined;
    raw = f.signed ? s16(v) : u16(v);
  }
  return raw * (f.scale === undefined ? 1 : f.scale);
}

/**
 * scaleClass - the ha-solarman [1,10] LV/HV multiplier for a family's PV +
 * battery power, read from the device-identity register (`fam.scaleReg`, hybrid_3p
 * only). LV device codes -> 1, HV device codes -> 10. Returns undefined when the
 * family has no scale register, the register is unreadable, or the code is
 * unknown - the caller then falls back to the manual override / default.
 */
function scaleClass(blocks, fam) {
  if (!fam || fam.scaleReg === undefined) return undefined;
  const code = readReg(blocks, fam.scaleReg);
  if (code === undefined) return undefined;
  const c = code & 0xffff;
  if (DEVICE_TYPES_HV.indexOf(c) !== -1) return 10;
  if (DEVICE_TYPES_LV.indexOf(c) !== -1) return 1;
  return undefined;
}

/**
 * decode - turn the read blocks + inverter config into the flat edge/telemetry
 * reading. Returns { reading, batt_kw } where `reading` carries only the
 * canonical cloud fields (power_kw / pv_power_kw / load_kw / soc_pct) and
 * `batt_kw` is the calibration-only battery power (never published).
 *
 * config = { family, invert_grid_sign?, invert_batt_sign?, power_scale? }.
 *
 * The hybrid_3p HV/LV scale (applied to PV + battery ONLY, never grid/load/SoC)
 * is resolved with this precedence:
 *   1. an explicit operator override `power_scale` of 1 or 10 wins;
 *   2. else it is AUTO-DETECTED from the device-identity register 0x0000;
 *   3. else (register unreadable / unknown code / no override) it falls back to
 *      1 - never fabricating a class.
 */
function decode(blocks, config) {
  const fam = FAMILIES[config && config.family];
  if (!fam) return null;
  const f = fam.fields;

  // hvScale: the [1,10] LV/HV multiplier for PV + battery power. Manual override
  // (power_scale 1 or 10) wins; else auto-detect from 0x0000; else fall back to 1.
  const manual = Number(config && config.power_scale);
  let hvScale;
  if (manual === 1 || manual === 10) {
    hvScale = manual;
  } else {
    const detected = scaleClass(blocks, fam);
    hvScale = detected !== undefined ? detected : 1;
  }

  // A field's kW: raw (already ×its base scale) → optional sign flip → ×hvScale
  // for [1,10]-scaled fields (PV/battery), ×1 for the always-watt grid/load.
  const toKw = (spec, invert) => {
    let w = fieldValue(blocks, spec);
    if (w === undefined) return undefined;
    if (invert) w = -w;
    return round3((w * (spec.hvScale ? hvScale : 1)) / 1000);
  };

  const reading = {};
  let batt_kw;

  // Battery-family SoC plausibility gate FIRST: an unreadable or out-of-band SoC
  // marks a degraded/unanswered logger read, so drop the entire sample rather
  // than fabricate a 0/garbage value (see socPlausible above).
  let socPct;
  if (fam.hasBattery && f.soc) {
    const s = fieldValue(blocks, f.soc);
    if (!socPlausible(s)) return null;
    socPct = round1(s);
  }

  if (f.pv) {
    const kw = toKw(f.pv, false);
    if (kw !== undefined) reading.pv_power_kw = kw;
  }
  if (f.load) {
    const kw = toKw(f.load, false);
    if (kw !== undefined) reading.load_kw = kw;
  }
  if (f.grid) {
    // Prefer the connection-point register; fall back to the config-dependent
    // alias when the read block does not cover the external pair (see the
    // hybrid_3p map comment).
    let kw = toKw(f.grid, config.invert_grid_sign);
    if (kw === undefined && f.gridFallback) kw = toKw(f.gridFallback, config.invert_grid_sign);
    if (kw !== undefined) reading.power_kw = kw;
  }
  if (socPct !== undefined) reading.soc_pct = socPct;
  if (fam.hasBattery && f.batt) {
    const kw = toKw(f.batt, config.invert_batt_sign);
    if (kw !== undefined) batt_kw = kw;
  }
  return { reading, batt_kw };
}

/** planReads - the { start, count } blocks a family needs per poll. */
function planReads(config) {
  const fam = FAMILIES[config && config.family];
  return fam ? fam.reads.map((r) => ({ start: r.start, count: r.count })) : [];
}

/** readCmd - argv for `deye` to read one block, e.g. ['-t','ip:port','-xmb','00A90016']. */
function readCmd(target, start, count) {
  return ['-t', target, '-xmb', h4(start) + h4(count)];
}

/**
 * powerLimitCmd - argv for the string/micro active-power-limit write to 0x0028.
 * The percent is clamped 0..100 and optionally snapped to the operator's stage
 * granularity (`stages` = allowed percent steps, e.g. [0,25,50,75,100]).
 */
function powerLimitCmd(target, pct, stages) {
  let p = Math.round(Number(pct));
  if (!Number.isFinite(p)) p = 100;
  p = Math.max(0, Math.min(100, p));
  if (Array.isArray(stages) && stages.length) {
    p = stages.reduce((best, s) => (Math.abs(s - p) < Math.abs(best - p) ? s : best), stages[0]);
  }
  // -xmbw <REG 0028><COUNT 0001><VALLEN 02><VALUE 2 bytes>
  const arg = h4(POWER_LIMIT_REG) + '0001' + '02' + h4(p);
  return { pct: p, args: ['-t', target, '-xmbw', arg] };
}

/**
 * detectHybridFamily - identify the hybrid map from two SoC probe responses:
 * the low map at 0x00B8 and the high map at 0x024C. Exactly one returns a sane
 * 0..100 percent on a given inverter. Ambiguous / neither -> null (string and
 * micro have no SoC and are chosen manually).
 */
function detectHybridFamily(lowStdout, highStdout) {
  const sane = (regs) => Array.isArray(regs) && regs.length >= 1 && regs[0] >= 0 && regs[0] <= 100;
  const lowOk = sane(parseOk(lowStdout));
  const highOk = sane(parseOk(highStdout));
  if (lowOk && !highOk) return 'hybrid_1p';
  if (highOk && !lowOk) return 'hybrid_3p';
  return null;
}

module.exports = {
  FAMILIES,
  POWER_LIMIT_REG,
  DEVICE_REG,
  DEVICE_TYPES_LV,
  DEVICE_TYPES_HV,
  parseOk,
  readReg,
  fieldValue,
  scaleClass,
  decode,
  planReads,
  readCmd,
  powerLimitCmd,
  detectHybridFamily,
  socPlausible,
  // low-level helpers exported for the tests
  _helpers: { u16, s16, round3, round1, h4 },
};
