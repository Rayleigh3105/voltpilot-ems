'use strict';

/**
 * sunspec/model-discovery - a REAL SunSpec model-discovery walker + the Model 123
 * (Immediate Controls) curtailment mapping. This is the one-time, reusable
 * capability the Fronius (and any future real-SunSpec brand, e.g. SMA) control
 * path needs, and is deliberately SEPARATE from modbus-tcp.js's compact 9-register
 * `sunspec` PROFILE - that profile is the SIMULATOR's fixed layout, NOT real
 * SunSpec (see modbus-tcp.js header). A genuine SunSpec device publishes a
 * DYNAMIC linked list of typed model blocks whose absolute addresses shift with
 * the composition of the list and with the int+SF vs float model type, so they
 * MUST be discovered live per device/firmware, never hard-coded from a table.
 * (The Fronius manual states verbatim: "Register addresses do not remain
 * constant... Search for the model by making a request, then work with offsets.")
 *
 * PURITY / TESTABILITY: this module owns ONLY the walk logic + the field-offset
 * arithmetic + the curtailment plan. It performs NO socket I/O itself: the caller
 * passes a `readBlock(addr, count) -> number[]` reader (a real Modbus-TCP FC3
 * reader in production; a fixture-backed reader in the offline unit tests). So the
 * whole thing is deterministic and unit-tested with no hardware
 * (model-discovery.test.js).
 *
 * SAFETY (report data/vp-fronius-control-scout-c4 §3.3, captain decision 3):
 *   - "Addresses discovered live, NEVER hard-coded." The FIELD OFFSETS within a
 *     model (WMaxLimPct at +3, WMaxLim_Ena at +7, ...) ARE the fixed SunSpec model
 *     DEFINITION - a stable part of the standard. What is discovered is the model
 *     BASE address (where model 123 sits in this device's dynamic list); the
 *     absolute register = discovered base + the standard offset. This is exactly
 *     the "search for the model, then work with offsets" the manual prescribes,
 *     and is what the report warns is unsafe to shortcut with a third-party
 *     absolute-address table (two community tables disagreed on the same register).
 *   - Fail IDLE-SAFE: if discovery cannot find the SID marker, or Model 123 is
 *     absent (wrong firmware / Modbus not enabled / Allow-Control off / comms
 *     loss), planCurtailment returns NO writes and a clear reason - never a
 *     fabricated address, never a blind write. Same "idle, never fabricate"
 *     discipline the Fronius read adapter uses (fronius/solar-api.js).
 *   - Signs/scaling are firmware-dependent -> every such assumption is marked
 *     "VERIFY on device" and is derived from a live-read scale factor, not baked in.
 *   - This module NEVER performs a control write and NEVER certifies a family. The
 *     Fronius family stays absent from inverter-control-routing.js's
 *     CERTIFIED_CONTROL_FAMILIES, so the plans below are surfaced as `planned`
 *     bench artefacts only, never executed, until a real-hardware bench pass.
 */

// --- SunSpec constants -------------------------------------------------------

// "SunS" identifier, two 16-bit registers, at the well-known base.
const SID = 0x53756e53;
const END_MODEL_ID = 0xffff; // the linked-list terminator

// The well-known base is holding register 40001 (1-based) = wire address 40000
// (0-based). Some devices publish at 50001 or 0; discover() tries the common set.
const DEFAULT_BASE = 40000;
const COMMON_BASES = [40000, 50000, 0];

// Model ids we care about (report §1.3 observed a GEN24's model sequence).
const MODEL = {
  COMMON: 1,
  NAMEPLATE: 120,
  BASIC_SETTINGS: 121,
  EXT_MEASUREMENTS: 122,
  IMMEDIATE_CONTROLS: 123,
  STORAGE: 124,
  MPPT: 160,
};

// Inverter measurement models. int+SF (101/102/103) vs float (111/112/113): the
// two families have DIFFERENT measurement-register layouts (report §1.3), which
// matters for the READ side. It does NOT change Model 123 (Immediate Controls) -
// there is one definition of 123 - but discovery surfaces which type is present
// so the read side (and a bench operator) can pick the right measurement map.
const INVERTER_INT_SF = { 101: 'single', 102: 'split', 103: 'three' };
const INVERTER_FLOAT = { 111: 'single', 112: 'split', 113: 'three' };

// Fixed field offsets WITHIN each model's BODY (after the 2-word id+len header),
// straight from the canonical SunSpec model definitions (pysunspec2 model_12x).
// These are the STANDARD, not a guessed absolute table - the base is discovered.
const M123 = {
  WMaxLimPct: 3, // uint16, scaled by WMaxLimPct_SF -> % of nameplate
  WMaxLimPct_WinTms: 4, // uint16, ramp window (s)
  WMaxLimPct_RvrtTms: 5, // uint16, REVERT timeout (s) - the vendor dead-man's switch
  WMaxLim_Ena: 7, // enum16, 0 = disabled / 1 = enabled
  WMaxLimPct_SF: 21, // sunssf (signed) - the WMaxLimPct scale factor
  LENGTH: 24,
};
const M120 = {
  WRtg: 1, // uint16, nameplate active-power rating
  WRtg_SF: 2, // sunssf (signed)
};
// Model 124 (Storage) offsets - REFERENCE ONLY for increment 2 (battery
// charge/discharge control). Discovery locates model 124 if present; this
// increment writes NOTHING here (report "OUT of scope").
const M124 = {
  WChaMax: 0, // uint16, nameplate max charge rate (100% ref for InWRte/OutWRte)
  StorCtl_Mod: 3, // bitfield16
  MinRsvPct: 5, // uint16, minimum reserve SoC
  ChaState: 6, // uint16, current SoC (read)
  OutWRte: 10, // int16, discharge rate (% of WChaMax)
  InWRte: 11, // int16, charge rate (% of WChaMax)
  InOutWRte_RvrtTms: 13, // uint16, revert timeout (s)
  ChaGriSet: 15, // enum16, grid-charge gate
  LENGTH: 24,
};

const WMAX_LIM_ENA = { DISABLED: 0, ENABLED: 1 };

// Default revert timeout for the curtailment write (report §1.3 / §3.3): the
// inverter auto-reverts if no fresh Modbus message arrives within RvrtTms, so a
// crashed/partitioned client can never leave a stale limit latched. The core
// re-publishes the setpoint every ~10 s (SetpointIntervalSeconds), so 60 s is a
// comfortable margin while still failing safe quickly. Range per manual: 0..28800.
// VERIFY the actual reached/behaviour on the bench.
const DEFAULT_RVRT_TMS = 60;

// The scale factor a device typically publishes for WMaxLimPct (register holds
// pct * 100). Used ONLY as a fallback when discovery could not read the live SF;
// the real value comes from the device. VERIFY on device.
const DEFAULT_WMAX_LIM_PCT_SF = -2;

// --- helpers -----------------------------------------------------------------

function readWords(readBlock, addr, count) {
  let r;
  try {
    r = readBlock(addr, count);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(r) || r.length < count) return null;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const v = r[i];
    if (typeof v !== 'number' || !isFinite(v)) return null;
    out[i] = v & 0xffff;
  }
  return out;
}

const u32 = (hi, lo) => ((hi & 0xffff) * 0x10000 + (lo & 0xffff)) >>> 0;
const s16 = (v) => {
  v &= 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
};

// --- the walk ----------------------------------------------------------------

const MAX_MODELS = 256; // runaway guard (a real device has ~10)
const MAX_SPAN = 8192; // registers; a plausible upper bound for the whole list

/**
 * discoverAt - walk the SunSpec model linked list starting at a SPECIFIC base.
 * Returns a discovery result (see discover() for the shape). ok:false with a
 * reason when the SID marker is absent/unreadable at this base.
 */
function discoverAt(readBlock, base) {
  const sidWords = readWords(readBlock, base, 2);
  if (!sidWords) return { ok: false, base, reason: 'SID nicht lesbar', models: [] };
  if (u32(sidWords[0], sidWords[1]) !== SID) {
    return { ok: false, base, reason: 'kein SunS-Marker', models: [] };
  }

  const models = [];
  let addr = base + 2; // skip the 2-register SID
  let truncated = false;
  for (let i = 0; i < MAX_MODELS; i++) {
    if (addr - base > MAX_SPAN) {
      truncated = true;
      break;
    }
    const hdr = readWords(readBlock, addr, 2);
    if (!hdr) {
      // A header we cannot read = a truncated/malformed list. Stop idle-safe
      // and keep whatever we found so far (Model 123 may already be located).
      truncated = true;
      break;
    }
    const id = hdr[0];
    const len = hdr[1];
    if (id === END_MODEL_ID) {
      return finalize(readBlock, base, models, false);
    }
    if (len > MAX_SPAN) {
      // An implausible length means the stream is corrupt from here on.
      truncated = true;
      break;
    }
    models.push({ id, len, headerAddr: addr, bodyAddr: addr + 2 });
    addr += 2 + len;
  }
  return finalize(readBlock, base, models, truncated);
}

/**
 * discover - try the common SunSpec bases in order and return the first that
 * carries a valid SID. When none match, returns the ok:false result of the
 * preferred (first) base so the caller has a reason. `opts.base` forces a single
 * base; `opts.bases` overrides the candidate list.
 */
function discover(readBlock, opts) {
  opts = opts || {};
  const bases = opts.base != null ? [opts.base] : (Array.isArray(opts.bases) ? opts.bases : COMMON_BASES);
  let firstFail = null;
  for (const base of bases) {
    const r = discoverAt(readBlock, base);
    if (r.ok) return r;
    if (!firstFail) firstFail = r;
  }
  return firstFail || { ok: false, base: DEFAULT_BASE, reason: 'keine Basis', models: [] };
}

// Build the rich result: index models, classify the inverter model, resolve the
// Model 120/123/124 field addresses, and read the scalars (nameplate W + SF)
// needed to plan a curtailment. Field ADDRESSES = discovered body base + the
// fixed standard offset (never a hard-coded absolute).
function finalize(readBlock, base, models, truncated) {
  const byId = {};
  for (const m of models) {
    // First occurrence wins (a well-formed list has each model once).
    if (byId[m.id] === undefined) byId[m.id] = m;
  }

  // Inverter model type (int+SF vs float). Does NOT change Model 123.
  let inverter = null;
  for (const m of models) {
    if (INVERTER_INT_SF[m.id]) {
      inverter = { id: m.id, type: 'int_sf', phases: INVERTER_INT_SF[m.id] };
      break;
    }
    if (INVERTER_FLOAT[m.id]) {
      inverter = { id: m.id, type: 'float', phases: INVERTER_FLOAT[m.id] };
      break;
    }
  }

  const controls = resolveControls(byId[MODEL.IMMEDIATE_CONTROLS]);
  const nameplate = resolveNameplate(byId[MODEL.NAMEPLATE]);
  const storage = byId[MODEL.STORAGE]
    ? { present: true, id: MODEL.STORAGE, bodyAddr: byId[MODEL.STORAGE].bodyAddr }
    : { present: false };

  const result = {
    ok: true,
    base,
    truncated: !!truncated,
    models,
    byId,
    inverter,
    controls,
    nameplate,
    storage,
    nameplateKw: null,
    wMaxLimPctSf: null,
  };

  // Live-read the scalars needed to convert kW <-> % (report §3.2: "read WChaMax /
  // WRtg once ... and convert"). Best-effort: a failed read just leaves the value
  // null, and planCurtailment then reports the honest idle-safe reason.
  if (nameplate.present) {
    const w = readWords(readBlock, nameplate.wRtgAddr, 2);
    if (w) {
      const wRtg = w[0];
      const wRtgSf = s16(w[1]);
      result.nameplateKw = (wRtg * Math.pow(10, wRtgSf)) / 1000;
    }
  }
  if (controls.present) {
    const sf = readWords(readBlock, controls.wMaxLimPctSfAddr, 1);
    if (sf) result.wMaxLimPctSf = s16(sf[0]);
  }
  return result;
}

/** resolveControls - Model 123 field addresses (absolute = bodyAddr + offset). */
function resolveControls(m) {
  if (!m) return { present: false };
  return {
    present: true,
    id: MODEL.IMMEDIATE_CONTROLS,
    bodyAddr: m.bodyAddr,
    wMaxLimPctAddr: m.bodyAddr + M123.WMaxLimPct,
    wMaxLimPctWinTmsAddr: m.bodyAddr + M123.WMaxLimPct_WinTms,
    wMaxLimPctRvrtTmsAddr: m.bodyAddr + M123.WMaxLimPct_RvrtTms,
    wMaxLimEnaAddr: m.bodyAddr + M123.WMaxLim_Ena,
    wMaxLimPctSfAddr: m.bodyAddr + M123.WMaxLimPct_SF,
  };
}

/** resolveNameplate - Model 120 field addresses (absolute = bodyAddr + offset). */
function resolveNameplate(m) {
  if (!m) return { present: false };
  return {
    present: true,
    id: MODEL.NAMEPLATE,
    bodyAddr: m.bodyAddr,
    wRtgAddr: m.bodyAddr + M120.WRtg,
    wRtgSfAddr: m.bodyAddr + M120.WRtg_SF,
  };
}

// --- Model 123 curtailment mapping -------------------------------------------

/**
 * planCurtailment - map VoltPilot's `pv_limit_kw` curtailment channel onto a
 * Model 123 WMaxLimPct write + readback plan, using DISCOVERED addresses. This is
 * the direct SunSpec analogue of the already-certified simulator `sunspecControl`
 * PVLIMIT write (inverter-control-routing.js) - same WriteOp/ReadOp shape, real
 * discovered addresses instead of the sim's fixed reg 42.
 *
 *   { discovery, pvLimitKw, nameplateKw?, wMaxLimPctSf?, rvrtTms? }
 *     discovery    - a discover() result (carries the model-123 addresses + the
 *                    live nameplate kW + WMaxLimPct scale factor).
 *     pvLimitKw    - the feed-in cap in kW, or null/undefined = NO cap (uncurtailed
 *                    slot). Absent -> DISABLE the limit (WMaxLim_Ena = 0), so a
 *                    stale limit never outlives its schedule.
 *     nameplateKw  - override the discovered nameplate rating (kW), for tests /
 *                    when the device didn't publish it.
 *     wMaxLimPctSf - override the discovered WMaxLimPct scale factor.
 *     rvrtTms      - override the revert timeout (s); default DEFAULT_RVRT_TMS.
 *
 * Returns { ok, writes:[WriteOp], readbacks:[ReadOp], pct, pctRaw, ena } on
 * success, or { ok:false, reason, writes:[], readbacks:[] } when discovery is
 * missing, Model 123 is absent, or the nameplate rating is unknown - IDLE-SAFE,
 * never a fabricated address (report §3.3).
 *
 * WriteOp = { role, fc:6, addr, value, encode, dwell_s, min_change }
 * ReadOp  = { role, fc:3, addr, expect, tolerance }
 *
 * Sign/scale are firmware-dependent: WMaxLimPct is a % of nameplate, the register
 * is scaled by the DEVICE's WMaxLimPct_SF (read live, fallback -2). VERIFY the
 * scale + that the write actually caps feed-in on the bench.
 */
function planCurtailment(args) {
  args = args || {};
  const discovery = args.discovery || null;
  const idle = (reason) => ({ ok: false, reason, writes: [], readbacks: [] });

  if (!discovery || !discovery.ok) return idle('SunSpec-Modelle nicht erkannt');
  const c = discovery.controls;
  if (!c || !c.present) return idle('Modell 123 (Immediate Controls) fehlt');

  const nameplateKw = args.nameplateKw != null ? Number(args.nameplateKw) : Number(discovery.nameplateKw);
  if (!(nameplateKw > 0)) return idle('Nennleistung (Nameplate WRtg) unbekannt');

  const sf = Number.isFinite(args.wMaxLimPctSf)
    ? args.wMaxLimPctSf
    : (Number.isFinite(discovery.wMaxLimPctSf) ? discovery.wMaxLimPctSf : DEFAULT_WMAX_LIM_PCT_SF);

  const curtail = typeof args.pvLimitKw === 'number' && isFinite(args.pvLimitKw) && args.pvLimitKw >= 0;
  // % of nameplate. Uncurtailed -> 100 % (and the enable is turned OFF anyway).
  const pct = curtail ? Math.max(0, Math.min(100, (args.pvLimitKw / nameplateKw) * 100)) : 100;
  // Register value = pct / 10^SF (SF is negative, so this multiplies up, e.g.
  // SF=-2 -> pct*100). Rounded to the nearest raw unit, masked to u16.
  const pctRaw = Math.round(pct / Math.pow(10, sf)) & 0xffff;
  const ena = curtail ? WMAX_LIM_ENA.ENABLED : WMAX_LIM_ENA.DISABLED;
  const rvrt = (Number.isFinite(args.rvrtTms) && args.rvrtTms >= 0 ? Math.round(args.rvrtTms) : DEFAULT_RVRT_TMS) & 0xffff;

  // Ordering is safety-relevant: set the LIMIT VALUE + the REVERT TIMER first,
  // ARM the enable LAST, so the cap can never be enabled with a stale value or
  // without its dead-man's timer.
  const writes = [
    {
      role: 'pv_limit_pct', fc: 6, addr: c.wMaxLimPctAddr, value: pctRaw,
      encode: { kind: 'wmax_lim_pct', pct, sf, rated_kw: nameplateKw, kw: curtail ? args.pvLimitKw : null },
      dwell_s: 0, min_change: 0,
    },
    {
      role: 'pv_limit_revert_tms', fc: 6, addr: c.wMaxLimPctRvrtTmsAddr, value: rvrt,
      encode: { kind: 'seconds' }, dwell_s: 0, min_change: 0,
    },
    {
      role: 'pv_limit_enable', fc: 6, addr: c.wMaxLimEnaAddr, value: ena,
      encode: { kind: 'enum', enabled: WMAX_LIM_ENA.ENABLED, disabled: WMAX_LIM_ENA.DISABLED, curtailing: curtail },
      dwell_s: 0, min_change: 0,
    },
  ];
  const readbacks = [
    { role: 'pv_limit_pct', fc: 3, addr: c.wMaxLimPctAddr, expect: pctRaw, tolerance: 1 },
    { role: 'pv_limit_revert_tms', fc: 3, addr: c.wMaxLimPctRvrtTmsAddr, expect: rvrt, tolerance: 2 },
    { role: 'pv_limit_enable', fc: 3, addr: c.wMaxLimEnaAddr, expect: ena, tolerance: 0 },
  ];
  return { ok: true, writes, readbacks, pct, pctRaw, ena };
}

module.exports = {
  SID,
  END_MODEL_ID,
  DEFAULT_BASE,
  COMMON_BASES,
  MODEL,
  M123,
  M120,
  M124,
  WMAX_LIM_ENA,
  DEFAULT_RVRT_TMS,
  DEFAULT_WMAX_LIM_PCT_SF,
  discover,
  discoverAt,
  resolveControls,
  resolveNameplate,
  planCurtailment,
  _helpers: { u32, s16, readWords },
};
