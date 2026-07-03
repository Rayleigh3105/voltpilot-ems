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
 * IMPORTANT: the ADDRESSES are authoritative from ha-solarman, but a few
 * SCALINGS and all raw SIGNS are firmware-dependent and MUST be verified on the
 * actual device (see the sign-calibration procedure in DEYE.md). The
 * per-inverter `invert_grid_sign` / `invert_batt_sign` flags exist precisely
 * because raw grid/battery signs differ between firmwares, and the optional
 * `power_scale` (default 1) exists for the hybrid_3p HV-decawatt contingency.
 */

// --- core telemetry sign convention ------------------------------------------
// power_kw:   + = grid IMPORT / - = grid EXPORT   (docs/contracts/mqtt-telemetry.schema.json)
// batt_kw:    + = charge       / - = discharge    (matches edge/setpoint; NOT a cloud
//             telemetry field - the cloud derives battery from the power balance, so we
//             read it only as a calibration aid / status text).

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
  // Addresses are authoritative from StephanJoubert/home_assistant_solarman
  // deye_sg04lp3.yaml (SOC 588, batt 590, grid 625 s16, load 653, PV1 672, PV2
  // 673 - all u16 scale 1); PV3/PV4 (674/675) fall inside ha-solarman's
  // 0x02A0..0x02A7 read range and come from the Deye Modbus manual for the HV
  // 3-4 MPPT units. Confirmed device: captain's SUN-*-SG01HP3-EU (inverter
  // serial 2407224048, #49 real-logger read).
  // HV-SCALING (VERIFY-on-device): ha-solarman uses scale 1 (W). If a live read
  // on an HV unit shows PV ~10x low vs the logger status page or power_kw
  // saturating at +/-32.7 kW (int16), that firmware reports DECAWATTS - set
  // `power_scale: 10` in the inverter config (no code edit). Default 1.
  hybrid_3p: {
    label: 'Hybrid 3-phasig (SG04LP3 LV / SG01HP3 HV, high map, bis 4 MPPT)',
    hasBattery: true,
    // 0x024C..0x02A3 (88 regs) - one block, under the 125-reg fn-0x03 limit.
    reads: [{ start: 0x024c, count: 0x0058 }],
    fields: {
      soc: { addr: 0x024c, bits: 16, signed: false, scale: 1, kind: 'pct' }, // reg 588, %
      batt: { addr: 0x024e, bits: 16, signed: true, scale: 1 }, // reg 590, W (calibration only)
      grid: { addr: 0x0271, bits: 16, signed: true, scale: 1 }, // reg 625, W (+ import / - export)
      load: { addr: 0x028d, bits: 16, signed: false, scale: 1 }, // reg 653, W
      // PV1..PV4 power, reg 672/673/674/675 (BM3 uses 3, BM4 uses 4; PV4=0 on LV/BM3).
      pv: { addrs: [0x02a0, 0x02a1, 0x02a2, 0x02a3], bits: 16, signed: false, scale: 1, sum: true },
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
    const lo = readReg(blocks, f.addr);
    const hi = readReg(blocks, f.addr + 1);
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
 * decode - turn the read blocks + inverter config into the flat edge/telemetry
 * reading. Returns { reading, batt_kw } where `reading` carries only the
 * canonical cloud fields (power_kw / pv_power_kw / load_kw / soc_pct) and
 * `batt_kw` is the calibration-only battery power (never published).
 *
 * config = { family, invert_grid_sign?, invert_batt_sign?, power_scale? }.
 * `power_scale` (default 1) multiplies every POWER field (pv/load/grid/batt,
 * never SoC) on top of its per-field base scale - the documented lever for the
 * hybrid_3p HV-decawatt firmware (set 10) without touching the map.
 */
function decode(blocks, config) {
  const fam = FAMILIES[config && config.family];
  if (!fam) return null;
  const f = fam.fields;
  const pscale = Number(config.power_scale) > 0 ? Number(config.power_scale) : 1;
  const toKw = (w) => round3((w * pscale) / 1000);
  const reading = {};
  let batt_kw;

  if (f.pv) {
    const w = fieldValue(blocks, f.pv);
    if (w !== undefined) reading.pv_power_kw = toKw(w);
  }
  if (f.load) {
    const w = fieldValue(blocks, f.load);
    if (w !== undefined) reading.load_kw = toKw(w);
  }
  if (f.grid) {
    let w = fieldValue(blocks, f.grid);
    if (w !== undefined) {
      if (config.invert_grid_sign) w = -w;
      reading.power_kw = toKw(w);
    }
  }
  if (fam.hasBattery && f.soc) {
    const s = fieldValue(blocks, f.soc);
    if (s !== undefined) reading.soc_pct = round1(s);
  }
  if (fam.hasBattery && f.batt) {
    let w = fieldValue(blocks, f.batt);
    if (w !== undefined) {
      if (config.invert_batt_sign) w = -w;
      batt_kw = toKw(w);
    }
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
  parseOk,
  readReg,
  fieldValue,
  decode,
  planReads,
  readCmd,
  powerLimitCmd,
  detectHybridFamily,
  // low-level helpers exported for the tests
  _helpers: { u16, s16, round3, round1, h4 },
};
