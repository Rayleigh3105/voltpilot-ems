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
      // Battery Voltage (ha-solarman deye_hybrid.yaml "Battery Voltage",
      // reg 183, scale 0.01 -> V). It sits ONE address below the SoC, exactly
      // like the high map's 0x024B below 0x024C, and is ALREADY inside the
      // 0x00A9..0x00BE block - no read widening for this family. Only used by
      // the soc_from_voltage estimate; never published as a channel.
      battVolt: { addr: 0x00b7, bits: 16, signed: false, scale: 0.01 }, // reg 183, V
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
    // ⚠ The measurement block starts at 0x024B, not 0x024C: the Battery Voltage
    // register the soc_from_voltage estimate needs sits ONE address BELOW the
    // SoC. Widening down by one keeps every existing field at its address and
    // lands at 122 registers - still under the 125-register fn-0x03 limit.
    reads: [
      { start: DEVICE_REG, count: 0x0001 },
      { start: 0x024b, count: 0x007a },
    ],
    // The register whose device-type code drives the LV/HV PV+battery scale.
    scaleReg: DEVICE_REG,
    fields: {
      soc: { addr: 0x024c, bits: 16, signed: false, scale: 1, kind: 'pct' }, // %
      // Battery Voltage (ha-solarman deye_p3.yaml "Battery Voltage", 0x024B).
      // It carries the SAME dual `scale: [0.01, 0.1]` as PV/battery power, so
      // it rides the hvScale flag: LV -> 0.01 V/LSB, HV -> 0.1 V/LSB. The dual
      // scale is a physical necessity, not a quirk - at 0.01 V/LSB a 16-bit
      // register tops out at 655,35 V, which an HV pack (600-800 V) overflows.
      // Cross-check on the live SG02HP3-EU-AM3 (Muehlfeldweg 2, DEYE.md §"HV
      // neue Generation"): raw 6360 x 0.01 x 10 = 636,0 V, the value that
      // device reported. Only used by the soc_from_voltage estimate below;
      // never published as a channel.
      battVolt: { addr: 0x024b, bits: 16, signed: false, scale: 0.01, hvScale: true }, // V
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

// --- WHY the SoC failed: three cases, and only ONE of them is over-ridable ----
// Live case Muehlfeldweg 2 (21.08.2026, scout `vp-am3-registerkarte-v2`): a Deye
// hybrid with a SELF-BUILT battery whose BMS is not coupled to the inverter. The
// inverter measures the battery at its own terminals (voltage/current/power/
// temperature all read fine) but the SoC register - the ONLY BMS-fed value -
// reads a permanent, perfectly stable 0. The gate above then dropped EVERY
// sample, so the plant could not even be added, let alone deliver telemetry.
//
// The July rule is NOT loosened; it is made PRECISE about which evidence it
// saw, so a caller can tell the three apart:
//
//   'no_answer'    - the whole measurement block is zeros. That is the logger's
//                    documented empty-answer signature (it could not reach the
//                    inverter, typically at night) and stays a HARD drop, opt-in
//                    or not: it is the case the July fix was built for.
//   'missing'      - the block is demonstrably ALIVE (some other register moved)
//                    and only the SoC is an exact 0 -> the BMS reports nothing.
//                    This is the ONLY case `allow_missing_soc` may keep, and it
//                    keeps it WITHOUT soc_pct - never a fabricated 0, so the
//                    SoC axis-spike symptom stays structurally impossible.
//   'out_of_range' - a value outside (0,100]. Evidence that the FRAME is wrong,
//                    not that a BMS is missing; turning a frame-alignment bug
//                    into published pv/load/grid numbers is exactly what the
//                    July rule prevents. Hard drop, opt-in or not.
const SOC_DROP_NO_ANSWER = 'no_answer';
const SOC_DROP_MISSING = 'missing';
const SOC_DROP_OUT_OF_RANGE = 'out_of_range';

// --- SoC ESTIMATED from the battery voltage (the ONLY way out of `missing`) --
// Live case Muehlfeldweg 2 (see the three-rules block above): the pack is fine,
// the inverter measures its voltage/current/power/temperature - only the BMS
// link is absent, so `allow_missing_soc` keeps the reading but the customer has
// NO state of charge at all, and neither has anything SoC-dependent.
//
// The operator may therefore state the pack's two ends (`soc_from_voltage:
// {v_empty, v_full}`, from the battery's own datasheet) and we LINEARLY
// interpolate the measured terminal voltage between them. Four rules make this
// honest rather than a fabrication:
//
//   1. It applies ONLY to the `missing` rule. `no_answer` (the logger's empty
//      answer) and `out_of_range` (a broken frame) stay HARD drops with or
//      without the option - the July-2026 rule is untouched. Estimating from a
//      voltage register of a frame we already decided we cannot trust would be
//      exactly the fabrication the gate exists to prevent.
//   2. A REAL BMS SoC (> 0) is NEVER overwritten. The estimate exists only
//      where the device reports nothing.
//   3. It is CLAMPED to [1, 100] - deliberately NOT [0, 100]. An exact 0 is the
//      empty-answer signature both plausibility gates key on (JS socPlausible
//      here, its Go twin guards.SocPlausible at the core's telemetry ingest), so
//      an estimated 0 would be DROPPED at the next choke point and the customer
//      would be back to no SoC at all - with the added confusion of a value the
//      decoder believed it had published. 1 % is the honest floor: "as empty as
//      this estimate can say".
//   4. An UNREADABLE or zero voltage estimates NOTHING (the reading is then
//      kept without soc_pct, exactly as with the bare opt-in). A pack whose
//      voltage register reads 0 has not been measured; guessing from it would
//      be the fabrication rule 1 rejects.
//
// ⚠ It is an ESTIMATE, and a coarse one: a LiFePO4 cell holds ~3,2-3,35 V over
// most of its usable range, so between roughly 20 % and 90 % the curve is
// nearly flat and the interpolation is a rough indication, not a measurement.
// Under load the terminal voltage additionally sags (discharge) or rises
// (charge) by the pack's internal resistance times the current, which shifts
// the estimate further. That is why the ESTIMATE is never treated as a BMS
// truth: the connection test keeps reporting `missing`, so the plant keeps its
// `reading_override` stamp and stays refused for battery control (the api's
// ControlCertificationService) - guards.Clamp is never armed on a guess.
const SOC_ESTIMATE_MIN_PCT = 1; // clamped floor: 0 IS the empty-answer signature
const SOC_ESTIMATE_MAX_PCT = 100;

/**
 * socFromVoltageConfig - the validated {v_empty, v_full} pair, or null.
 *
 * Defensive by design: a decoder must never throw on a malformed config, and a
 * nonsensical pair must produce NO estimate rather than a nonsense percentage.
 * The authoritative validation (with a German message) lives cloud-side in
 * ComponentService and on the box in inverter.Normalize; this is the last line.
 */
function socFromVoltageConfig(config) {
  const raw = config && config.soc_from_voltage;
  if (!raw || typeof raw !== 'object') return null;
  const empty = Number(raw.v_empty);
  const full = Number(raw.v_full);
  if (!isFinite(empty) || !isFinite(full)) return null;
  if (!(empty > 0) || !(full > empty)) return null;
  return { v_empty: empty, v_full: full };
}

/**
 * estimateSocFromVoltage - the linear interpolation, rounded to 0,1 % and
 * clamped to [1, 100] (see rule 3 above). Returns undefined when the voltage is
 * unusable - never a fabricated value.
 */
function estimateSocFromVoltage(volts, cfg) {
  if (!cfg) return undefined;
  if (typeof volts !== 'number' || !isFinite(volts) || volts <= 0) return undefined;
  const pct = ((volts - cfg.v_empty) / (cfg.v_full - cfg.v_empty)) * 100;
  if (!isFinite(pct)) return undefined;
  return Math.max(SOC_ESTIMATE_MIN_PCT, Math.min(SOC_ESTIMATE_MAX_PCT, round1(pct)));
}

/**
 * blockAlive - does this read show any life at all, or is it the logger's
 * all-zero empty answer? Judged over the family's OWN measurement fields (never
 * over the device-identity register, which a logger can answer from cache while
 * the measurement block is dead). A genuinely idle plant whose every channel is
 * exactly 0 is conservatively treated as no answer: dropping that one sample
 * gaps the chart, which is this house's rule when it does not know.
 */
function blockAlive(blocks, fam) {
  const f = fam.fields;
  for (const key of Object.keys(f)) {
    // 'soc' is the channel under judgement. 'battVolt' is DELIBERATELY not a
    // witness either: it exists only for the soc_from_voltage estimate, and
    // letting it decide aliveness would move the no_answer/missing boundary for
    // every plant (a night read whose power channels are all exactly 0 but
    // whose pack still holds voltage would flip from "no answer" to "BMS
    // missing"). This judgement stays exactly what it was: did the plant's
    // POWER channels move?
    if (key === 'soc' || key === 'battVolt') continue;
    const spec = f[key];
    const addrs = spec.addrs
      ? spec.addrs.slice()
      : spec.bits === 32 ? [spec.addr, spec.addr + 1] : [spec.addr];
    for (const a of addrs) {
      const v = readReg(blocks, a);
      if (v !== undefined && (v & 0xffff) !== 0) return true;
    }
  }
  return false;
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
  const out = decodeVerbose(blocks, config);
  if (!out) return null;
  if (!out.drop) return { reading: out.reading, batt_kw: out.batt_kw };
  // The July rule, unchanged by default: an implausible SoC means the whole
  // read is untrustworthy. Only the narrow opt-in above, and only on the
  // exact-0 "BMS reports nothing" signature, keeps the other channels.
  const optIn = !!(config && config.allow_missing_soc);
  if (optIn && out.drop.rule === SOC_DROP_MISSING) {
    // ...and if the operator stated the pack's two ends, the reading carries an
    // ESTIMATED soc_pct instead of no SoC at all. `soc_source` marks it on the
    // LOCAL bus so a technician reading `edge/telemetry` sees at once that this
    // number is interpolated - the Go core ignores unknown fields, and the
    // FROZEN cloud telemetry contract (additionalProperties:false) has no room
    // for it, so the durable provenance for every cloud surface is the stored
    // `connection.soc_from_voltage` itself, not a per-sample flag.
    const est = out.drop.estimate;
    if (est) {
      return {
        reading: { ...out.reading, soc_pct: est.soc_pct, soc_source: 'voltage' },
        batt_kw: out.batt_kw,
      };
    }
    return { reading: out.reading, batt_kw: out.batt_kw };
  }
  return null;
}

/**
 * decodeVerbose - decode() that SAYS what it dropped instead of only returning
 * null. Same register maps, same scaling, same gate; the difference is that the
 * caller can show the customer WHICH channel violated WHICH rule and with what
 * value - the connection test used to answer a permanent-0 SoC with a bare
 * "unplausibel" and no numbers at all, which is a riddle, not a diagnosis.
 *
 * Returns { reading, batt_kw, drop? } where `reading` NEVER carries the dropped
 * channel and `drop` = { channel, rule, raw, value } names it (rule = which of
 * the three cases above, raw = the 16-bit register word, value = the decoded
 * percentage). null only when the family itself is unknown.
 */
function decodeVerbose(blocks, config) {
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
  // The same [1,10] LV/HV resolution WITHOUT the watt->kW division: the battery
  // VOLTAGE carries the identical dual scale (deye_p3.yaml `scale: [0.01, 0.1]`)
  // but is already a physical unit. Dividing it by 1000 would silently turn
  // 636 V into 0,636 and the estimate would read 1 % on a full pack.
  const scaled = (spec) => {
    const v = fieldValue(blocks, spec);
    if (v === undefined) return undefined;
    return v * (spec.hvScale ? hvScale : 1);
  };

  const reading = {};
  let batt_kw;

  // Battery-family SoC plausibility gate FIRST: an unreadable or out-of-band SoC
  // marks a degraded/unanswered logger read (see socPlausible above). It is
  // never DECODED into the reading - what happens to the rest of the sample is
  // decide() 's call, from the `drop` this records.
  let socPct;
  let drop;
  if (fam.hasBattery && f.soc) {
    const s = fieldValue(blocks, f.soc);
    if (socPlausible(s)) {
      socPct = round1(s);
    } else {
      const value = typeof s === 'number' && isFinite(s) ? round1(s) : undefined;
      let rule = SOC_DROP_OUT_OF_RANGE;
      if (value === 0) {
        rule = blockAlive(blocks, fam) ? SOC_DROP_MISSING : SOC_DROP_NO_ANSWER;
      }
      drop = { channel: 'soc_pct', rule, raw: readReg(blocks, f.soc.addr), value };
      // The way OUT of `missing` - and ONLY out of `missing`: a voltage-based
      // estimate, computed here so the CONNECTION TEST can show it (the finding
      // says what is wrong AND what we could do about it, inseparably). It rides
      // NEXT TO the drop, never inside `reading` - that invariant ("the dropped
      // channel is NEVER in the reading") is what lets every consumer trust the
      // reading verbatim.
      if (rule === SOC_DROP_MISSING && f.battVolt) {
        const vcfg = socFromVoltageConfig(config);
        const volts = vcfg ? scaled(f.battVolt) : undefined;
        const est = estimateSocFromVoltage(volts, vcfg);
        if (est !== undefined) {
          drop.estimate = { soc_pct: est, voltage_v: round1(volts) };
        }
      }
    }
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
  return drop ? { reading, batt_kw, drop } : { reading, batt_kw };
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
  decodeVerbose,
  blockAlive,
  socFromVoltageConfig,
  estimateSocFromVoltage,
  SOC_ESTIMATE_MIN_PCT,
  SOC_ESTIMATE_MAX_PCT,
  SOC_DROP_NO_ANSWER,
  SOC_DROP_MISSING,
  SOC_DROP_OUT_OF_RANGE,
  // low-level helpers exported for the tests
  _helpers: { u16, s16, round3, round1, h4 },
};
