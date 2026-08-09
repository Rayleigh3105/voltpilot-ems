'use strict';

/**
 * sunspec/model-discovery - a REAL SunSpec model-discovery walker + the Model 123
 * (Immediate Controls) curtailment mapping AND the Model 124 (Storage) battery
 * charge/discharge mapping (increment 2). This is the one-time, reusable
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
  WMaxLimPct_WinTms: 4, // uint16, randomised-start window (s), 0..300
  WMaxLimPct_RvrtTms: 5, // uint16, how long the mode stays ACTIVE (s) - see below
  WMaxLimPct_RmpTms: 6, // uint16, ramp time (s)
  WMaxLim_Ena: 7, // enum16, 0 = disabled / 1 = enabled
  WMaxLimPct_SF: 21, // sunssf (signed) - the WMaxLimPct scale factor
  LENGTH: 24,
};

// Offsets 3..7 are CONTIGUOUS and are exactly the five registers the Fronius
// Modbus manual names as one command: "All 5 registers (WMaxLimPct,
// WMaxLimPct_WinTms, WMaxLimPct_RvrtTms, WMaxLimPct_RmpTms, WMaxLim_Ena) can be
// written with one command" (function code 0x10). Victron's production Fronius
// limiter writes the same block in one writeMultipleHoldingRegisters call at
// model-123 HEADER + 5 (= body + 3 = WMaxLimPct), which is byte-for-byte the
// span below. See CURTAIL_WRITE_FC / planCurtailment for why that matters.
const M123_LIMIT_BLOCK = {
  first: M123.WMaxLimPct,
  count: 5,
  roles: ['pv_limit_pct', 'pv_limit_window_tms', 'pv_limit_revert_tms', 'pv_limit_ramp_tms', 'pv_limit_enable'],
};
const M120 = {
  WRtg: 1, // uint16, nameplate active-power rating
  WRtg_SF: 2, // sunssf (signed)
};
// Model 124 (Storage / Basic Storage Control) field offsets - the fixed SunSpec
// model definition (pysunspec2 model_124). Increment 2 (battery charge/discharge
// control) writes these via planStorage() below; the ABSOLUTE addresses are the
// discovered model-124 body base + these standard offsets, never a hard-coded
// table (the report found two community tables disagreeing on the same register).
const M124 = {
  WChaMax: 0, // uint16, nameplate max charge rate (100% ref for InWRte/OutWRte)
  StorCtl_Mod: 3, // bitfield16 (bit0 = charge-rate limit active, bit1 = discharge)
  MinRsvPct: 5, // uint16, minimum reserve SoC (% of WChaMax capacity), * MinRsvPct_SF
  ChaState: 6, // uint16, current SoC (read only, cross-check)
  OutWRte: 10, // int16, discharge rate (% of WChaMax), * InOutWRte_SF
  InWRte: 11, // int16, charge rate (% of WChaMax), * InOutWRte_SF
  InOutWRte_RvrtTms: 13, // uint16, revert timeout (s) - the storage dead-man's switch
  ChaGriSet: 15, // enum16, grid-charge gate (0 = PV only / 1 = grid permitted)
  WChaMax_SF: 16, // sunssf (signed) - the WChaMax scale factor
  MinRsvPct_SF: 19, // sunssf (signed) - the MinRsvPct scale factor
  InOutWRte_SF: 23, // sunssf (signed) - the InWRte/OutWRte scale factor
  LENGTH: 24,
};

const WMAX_LIM_ENA = { DISABLED: 0, ENABLED: 1 };

// StorCtl_Mod is a bitmask: bit0 activates charge-rate limiting (InWRte), bit1
// activates discharge-rate limiting (OutWRte). VoltPilot drives ONE direction per
// slot, so exactly one bit is set for a charge/discharge command, and NONE (0 =
// release, self-consumption) for an idle setpoint. VERIFY the bit semantics + that
// setting the bit FORCES (not merely limits) the rate on the bench.
const STORCTL_MOD = { NONE: 0, CHARGE: 0x01, DISCHARGE: 0x02 };

// ChaGriSet grid-charge gate: PV = charge from PV only (grid charging OFF, the
// EEG-safe default), GRID = grid charging permitted. VERIFY the exact enum on the
// bench (community-documented, the report flags it "confirm on bench"). Never set
// GRID unless the site explicitly permits grid charging (site.netzladen_erlaubt).
const CHA_GRI_SET = { PV: 0, GRID: 1 };

// Default revert timeout for the storage rate registers (report §1.3/§3.3): the
// inverter auto-reverts to self-consumption if no fresh Modbus message arrives
// within InOutWRte_RvrtTms, so a crashed/partitioned client can never leave the
// battery pinned to a stale charge/discharge rate. Same 60 s margin as curtailment
// (the core re-publishes the setpoint every ~10 s). Range per manual 0..28800.
const DEFAULT_STORAGE_RVRT_TMS = 60;

// Fallback scale factors used ONLY when discovery could not read the live SF; the
// real values come from the device. A device typically holds a percentage * 100
// (SF = -2). VERIFY on device.
const DEFAULT_INOUT_WRTE_SF = -2; // InWRte / OutWRte
const DEFAULT_MIN_RSV_PCT_SF = -2; // MinRsvPct

// Default revert timeout for the curtailment write. The Fronius manual defines
// WMaxLimPct_RvrtTms as "the duration the operating mode remains active",
// range 0..28800 s, and "the timer restarts with each new Modbus message" - so
// it IS the vendor dead-man's switch: stop refreshing and the INVERTER ITSELF
// lifts the limit. The core re-publishes the setpoint every ~10 s
// (SetpointIntervalSeconds) and curtail.js re-applies every 20 s, so 60 s is a
// comfortable margin while still failing safe quickly.
//
// ⚠ 0 IS NOT "no timeout", it is "stays active until MANUALLY deactivated" -
// the latch. That is not theory: at Pilsting the previous controller left
// WMaxLimPct=0 / Ena=1 / RvrtTms=12000 behind, and when it stopped writing BOTH
// inverters stayed pinned at ~0.135 kW (0.5 % of 27 kW) for the rest of that
// 3.3-hour window. Never write 0 here, and never raise this above the test TTL.
const DEFAULT_RVRT_TMS = 60;

// WinTms (randomised start window) + RmpTms (ramp time): 0 = act immediately,
// which is what a closed-loop controller wants - any delay would make the plant
// chase its own actuator. They are written EXPLICITLY as part of the block
// (Victron writes 0 for both) so a foreign controller's leftover values can
// never delay OUR limit; leaving them out is what makes a "partial" command.
const DEFAULT_WIN_TMS = 0;
const DEFAULT_RMP_TMS = 0;

// The Modbus function code the curtailment block is written with.
// 16 (0x10, write-multiple) is the DEFAULT and the only form documented by
// Fronius for this register set; 6 (0x06, write-single) is the legacy
// per-register form kept ONLY as a per-connection flip-back, mirroring the Deye
// `control_write_fc` precedent (AGENTS.md "Deye control writes go out as FC16").
const CURTAIL_WRITE_FC = { BLOCK: 16, SINGLE: 6 };

/**
 * resolveCurtailWriteFc - which write form to use for THIS connection.
 * 0/absent/garbage -> auto -> FC16 (documented + proven); an explicit 6 flips
 * back to the legacy single-register writes.
 */
function resolveCurtailWriteFc(v) {
  return Number(v) === CURTAIL_WRITE_FC.SINGLE ? CURTAIL_WRITE_FC.SINGLE : CURTAIL_WRITE_FC.BLOCK;
}

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
  const storage = resolveStorage(byId[MODEL.STORAGE]);

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
    wChaMaxKw: null,
    inOutWRteSf: null,
    minRsvPctSf: null,
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
  // Storage scalars for the kW<->% conversion of the InWRte/OutWRte rate registers
  // (report §3.2: "read WChaMax once ... and convert"). Best-effort - a failed read
  // leaves the value null and planStorage then reports the honest idle-safe reason.
  if (storage.present) {
    const w = readWords(readBlock, storage.wChaMaxAddr, 1);
    const wsf = readWords(readBlock, storage.wChaMaxSfAddr, 1);
    if (w && wsf) result.wChaMaxKw = (w[0] * Math.pow(10, s16(wsf[0]))) / 1000;
    const io = readWords(readBlock, storage.inOutWRteSfAddr, 1);
    if (io) result.inOutWRteSf = s16(io[0]);
    const mr = readWords(readBlock, storage.minRsvPctSfAddr, 1);
    if (mr) result.minRsvPctSf = s16(mr[0]);
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
    wMaxLimPctRmpTmsAddr: m.bodyAddr + M123.WMaxLimPct_RmpTms,
    wMaxLimEnaAddr: m.bodyAddr + M123.WMaxLim_Ena,
    wMaxLimPctSfAddr: m.bodyAddr + M123.WMaxLimPct_SF,
    // The contiguous 5-register span the limit is written with in ONE FC16
    // transaction (= wMaxLimPctAddr .. wMaxLimEnaAddr).
    limitBlockAddr: m.bodyAddr + M123_LIMIT_BLOCK.first,
    limitBlockCount: M123_LIMIT_BLOCK.count,
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

/** resolveStorage - Model 124 field addresses (absolute = bodyAddr + offset). */
function resolveStorage(m) {
  if (!m) return { present: false };
  return {
    present: true,
    id: MODEL.STORAGE,
    bodyAddr: m.bodyAddr,
    wChaMaxAddr: m.bodyAddr + M124.WChaMax,
    wChaMaxSfAddr: m.bodyAddr + M124.WChaMax_SF,
    storCtlModAddr: m.bodyAddr + M124.StorCtl_Mod,
    minRsvPctAddr: m.bodyAddr + M124.MinRsvPct,
    minRsvPctSfAddr: m.bodyAddr + M124.MinRsvPct_SF,
    chaStateAddr: m.bodyAddr + M124.ChaState,
    outWRteAddr: m.bodyAddr + M124.OutWRte,
    inWRteAddr: m.bodyAddr + M124.InWRte,
    inOutWRteRvrtTmsAddr: m.bodyAddr + M124.InOutWRte_RvrtTms,
    inOutWRteSfAddr: m.bodyAddr + M124.InOutWRte_SF,
    chaGriSetAddr: m.bodyAddr + M124.ChaGriSet,
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

  const winTms = DEFAULT_WIN_TMS;
  const rmpTms = DEFAULT_RMP_TMS;
  const writeFc = resolveCurtailWriteFc(args.writeFc);

  // The five registers of the block, in ADDRESS order (= the wire order of the
  // FC16 payload). `parts` is the ONE description of what is being written: the
  // block's `values` are derived from it, and the display/signature enumerate it
  // - so there is never a second, drifting copy of the same command.
  const parts = [
    {
      role: 'pv_limit_pct', addr: c.wMaxLimPctAddr, value: pctRaw,
      encode: { kind: 'wmax_lim_pct', pct, sf, rated_kw: nameplateKw, kw: curtail ? args.pvLimitKw : null },
    },
    { role: 'pv_limit_window_tms', addr: c.wMaxLimPctWinTmsAddr, value: winTms, encode: { kind: 'seconds' } },
    { role: 'pv_limit_revert_tms', addr: c.wMaxLimPctRvrtTmsAddr, value: rvrt, encode: { kind: 'seconds' } },
    { role: 'pv_limit_ramp_tms', addr: c.wMaxLimPctRmpTmsAddr, value: rmpTms, encode: { kind: 'seconds' } },
    {
      role: 'pv_limit_enable', addr: c.wMaxLimEnaAddr, value: ena,
      encode: { kind: 'enum', enabled: WMAX_LIM_ENA.ENABLED, disabled: WMAX_LIM_ENA.DISABLED, curtailing: curtail },
    },
  ];

  // THE WRITE FORM IS THE FIX (live Pilsting 2026-08-09, two supervised tests).
  // Three separate FC6 writes were ACCEPTED - the WMaxLimPct readback confirmed
  // our value for the full 120 s - and the inverter kept producing above the
  // cap, while the RvrtTms write never took at all (commanded 60, read 12000 =
  // the previous controller's value, forever). That is a device applying the
  // parameter SET transactionally: a lone register write lands in the register
  // but never becomes an active command.
  //
  // So the limit goes out as ONE FC16 transaction over the contiguous span,
  // exactly as Fronius documents ("All 5 registers ... can be written with one
  // command") and exactly as Victron's production Fronius limiter does
  // (dbus-fronius sunspec_updater.cpp: ONE writeMultipleHoldingRegisters of
  // [pct, 0, timeout, 0, 1] at model-123 header + 5). It is the same bug class
  // this repo already fixed for Deye, where FC6 was likewise accepted and
  // silently ignored (AGENTS.md "Deye control writes go out as FC16").
  //
  // Ordering INSIDE the transaction is no longer a safety argument (the device
  // sees the whole set at once), but the address order still puts the value and
  // the dead-man timer ahead of the enable - so even a device that applies the
  // payload register by register can never arm a stale cap.
  const writes = writeFc === CURTAIL_WRITE_FC.BLOCK
    ? [{
      role: 'pv_limit_block',
      fc: CURTAIL_WRITE_FC.BLOCK,
      addr: c.limitBlockAddr,
      values: parts.map((p) => p.value),
      parts,
      // Kept at the block level so every consumer that reads writes[0].encode.sf
      // (the executor's kW back-conversion) keeps working unchanged.
      encode: { kind: 'wmax_lim_pct', pct, sf, rated_kw: nameplateKw, kw: curtail ? args.pvLimitKw : null },
      dwell_s: 0, min_change: 0,
    }]
    // Legacy flip-back: the pre-2026-08-09 per-register form. Proven NOT to
    // take effect on the Pilsting Datamanager - only for a firmware that
    // answers exclusively FC6.
    : parts
      .filter((p) => p.role === 'pv_limit_pct' || p.role === 'pv_limit_revert_tms' || p.role === 'pv_limit_enable')
      .map((p) => ({
        role: p.role, fc: CURTAIL_WRITE_FC.SINGLE, addr: p.addr, value: p.value,
        encode: p.encode, dwell_s: 0, min_change: 0,
      }));

  // Readbacks stay PER REGISTER (fn 0x03) and cover the three registers that
  // carry meaning. The echo of a write never proves anything on this device -
  // only the readback does, and RvrtTms is deliberately among them because a
  // RvrtTms that does not take is the signature of a non-transactional write.
  const readbacks = [
    { role: 'pv_limit_pct', fc: 3, addr: c.wMaxLimPctAddr, expect: pctRaw, tolerance: 1 },
    { role: 'pv_limit_revert_tms', fc: 3, addr: c.wMaxLimPctRvrtTmsAddr, expect: rvrt, tolerance: 2 },
    { role: 'pv_limit_enable', fc: 3, addr: c.wMaxLimEnaAddr, expect: ena, tolerance: 0 },
  ];
  return { ok: true, writes, readbacks, parts, writeFc, pct, pctRaw, ena, winTms, rmpTms, rvrtTms: rvrt };
}

// --- Model 124 (Storage) battery charge/discharge mapping (INCREMENT 2) -------

/**
 * planStorage - map VoltPilot's direct battery-power setpoint (`battery_setpoint_kw`,
 * + = charge / - = discharge) onto a Model 124 Storage write + readback plan using
 * DISCOVERED addresses. This is the higher-risk increment-2 companion to
 * planCurtailment: a wrong sign/scale can affect a real battery's health, so the
 * Fronius family stays ABSENT from CERTIFIED_CONTROL_FAMILIES and this plan is only
 * ever surfaced as `planned`/`bench_pending` (never executed) until a real-hardware
 * bench pass (CONTROL-BENCH.md → Fronius storage).
 *
 *   { discovery, batterySetpointKw, gridChargeAllowed?, socMinPct?, wChaMaxKw?,
 *     inOutWRteSf?, minRsvPctSf?, rvrtTms? }
 *     discovery         - a discover() result (carries the model-124 addresses +
 *                         the live WChaMax kW + the InOutWRte/MinRsvPct scale factors).
 *     batterySetpointKw - the guard-clamped command in kW; + charge / - discharge /
 *                         0 = release (idle, self-consumption). Sign is applied by
 *                         the caller (froniusControl honours invert_control_sign),
 *                         so this value is already in device orientation.
 *     gridChargeAllowed - EEG gate; ChaGriSet = GRID only when true AND charging.
 *     socMinPct         - the operating-floor SoC -> MinRsvPct (a reserve floor,
 *                         NOT a per-cycle target the way Deye's target-SoC hack is;
 *                         InWRte/OutWRte carry direction directly, so no hack here).
 *     wChaMaxKw         - override the discovered battery nameplate max charge rate
 *                         (kW) - the 100% reference for InWRte/OutWRte; for tests /
 *                         when the device didn't publish it.
 *     inOutWRteSf/minRsvPctSf - override the discovered scale factors.
 *     rvrtTms           - override the revert timeout (s); default DEFAULT_STORAGE_RVRT_TMS.
 *
 * Returns { ok, writes:[WriteOp], readbacks:[ReadOp], ratePct, rateRaw, mode,
 * chaGriSet, minRsvRaw } on success, or { ok:false, reason, writes:[], readbacks:[] }
 * when discovery is missing, Model 124 is absent, WChaMax is unknown, or the
 * setpoint is not finite - IDLE-SAFE, never a fabricated address (report §3.3).
 *
 * WriteOp = { role, fc:6, addr, value, encode, dwell_s, min_change }
 * ReadOp  = { role, fc:3, addr, expect, tolerance }
 *
 * Sign/scale are firmware-dependent: InWRte/OutWRte are a % of WChaMax scaled by the
 * DEVICE's InOutWRte_SF (read live, fallback -2); StorCtl_Mod bit semantics and the
 * ChaGriSet enum are community-documented. VERIFY every one of these on the bench
 * BEFORE certifying - a wrong storage write can damage a battery.
 */
function planStorage(args) {
  args = args || {};
  const discovery = args.discovery || null;
  const idle = (reason) => ({ ok: false, reason, writes: [], readbacks: [] });

  if (!discovery || !discovery.ok) return idle('SunSpec-Modelle nicht erkannt');
  const s = discovery.storage;
  if (!s || !s.present) return idle('Modell 124 (Storage) fehlt');

  const battKw = Number(args.batterySetpointKw);
  if (!Number.isFinite(battKw)) return idle('kein gueltiger Batterie-Sollwert');

  const wChaMaxKw = args.wChaMaxKw != null ? Number(args.wChaMaxKw) : Number(discovery.wChaMaxKw);
  if (!(wChaMaxKw > 0)) return idle('Batterie-Nennladeleistung (WChaMax) unbekannt');

  const ioSf = Number.isFinite(args.inOutWRteSf)
    ? args.inOutWRteSf
    : (Number.isFinite(discovery.inOutWRteSf) ? discovery.inOutWRteSf : DEFAULT_INOUT_WRTE_SF);
  const mrSf = Number.isFinite(args.minRsvPctSf)
    ? args.minRsvPctSf
    : (Number.isFinite(discovery.minRsvPctSf) ? discovery.minRsvPctSf : DEFAULT_MIN_RSV_PCT_SF);
  const rvrt = (Number.isFinite(args.rvrtTms) && args.rvrtTms >= 0
    ? Math.round(args.rvrtTms) : DEFAULT_STORAGE_RVRT_TMS) & 0xffff;

  const charging = battKw > 0;
  const discharging = battKw < 0;
  // Rate as % of WChaMax (both InWRte and OutWRte reference WChaMax), clamped
  // [0,100]. The idle channel (the non-active direction) is 0.
  const ratePct = Math.max(0, Math.min(100, (Math.abs(battKw) / wChaMaxKw) * 100));
  // Register value = pct / 10^SF (SF negative -> multiplies up, e.g. SF=-2 -> *100).
  const rateRaw = Math.round(ratePct / Math.pow(10, ioSf)) & 0xffff;
  const inRate = charging ? rateRaw : 0;
  const outRate = discharging ? rateRaw : 0;
  // StorCtl_Mod activates ONLY the active direction's rate limit; idle (0 kW) sets
  // NONE = release control -> the inverter self-consumes.
  const mode = charging ? STORCTL_MOD.CHARGE : (discharging ? STORCTL_MOD.DISCHARGE : STORCTL_MOD.NONE);

  // MinRsvPct floor from the operating-floor SoC (a % of capacity), scaled by SF.
  const socMin = Number.isFinite(args.socMinPct) ? Math.max(0, Math.min(100, args.socMinPct)) : 0;
  const minRsvRaw = Math.round(socMin / Math.pow(10, mrSf)) & 0xffff;

  // Grid-charge EEG gate: GRID only when explicitly permitted AND charging; else PV
  // (grid charging OFF, the EEG-safe default). Default off - an EEG plant must never
  // grid-charge; the optimizer already refuses it, this is the on-device belt-and-braces.
  const gridChargeAllowed = args.gridChargeAllowed === true;
  const chaGriSet = (gridChargeAllowed && charging) ? CHA_GRI_SET.GRID : CHA_GRI_SET.PV;

  // Ordering is safety-relevant: set the RATE values + reserve floor + grid gate +
  // the REVERT timer FIRST, ARM the StorCtl_Mod (the direction-enable bits) LAST, so
  // a mode can never be activated with a stale rate or without its dead-man's timer.
  const writes = [
    {
      role: 'battery_in_rate', fc: 6, addr: s.inWRteAddr, value: inRate,
      encode: { kind: 'wchamax_pct', pct: charging ? ratePct : 0, sf: ioSf, wchamax_kw: wChaMaxKw, kw: charging ? battKw : 0 },
      dwell_s: 0, min_change: 0,
    },
    {
      role: 'battery_out_rate', fc: 6, addr: s.outWRteAddr, value: outRate,
      encode: { kind: 'wchamax_pct', pct: discharging ? ratePct : 0, sf: ioSf, wchamax_kw: wChaMaxKw, kw: discharging ? battKw : 0 },
      dwell_s: 0, min_change: 0,
    },
    {
      role: 'battery_min_reserve', fc: 6, addr: s.minRsvPctAddr, value: minRsvRaw,
      encode: { kind: 'min_rsv_pct', pct: socMin, sf: mrSf },
      dwell_s: 900, min_change: 1, // MinRsvPct is a config (EEPROM) setting - write on change
    },
    {
      role: 'battery_grid_charge', fc: 6, addr: s.chaGriSetAddr, value: chaGriSet,
      encode: { kind: 'cha_gri_set', eeg_gated: true, pv: CHA_GRI_SET.PV, grid: CHA_GRI_SET.GRID, permitted: gridChargeAllowed },
      dwell_s: 900, min_change: 0, // grid-charge gate is a config (EEPROM) setting
    },
    {
      role: 'battery_revert_tms', fc: 6, addr: s.inOutWRteRvrtTmsAddr, value: rvrt,
      encode: { kind: 'seconds' }, dwell_s: 0, min_change: 0,
    },
    {
      role: 'battery_storage_mode', fc: 6, addr: s.storCtlModAddr, value: mode,
      encode: {
        kind: 'storctl_mod', charge: STORCTL_MOD.CHARGE, discharge: STORCTL_MOD.DISCHARGE,
        direction: charging ? 'charge' : (discharging ? 'discharge' : 'idle'),
      },
      dwell_s: 0, min_change: 0,
    },
  ];
  const readbacks = [
    { role: 'battery_in_rate', fc: 3, addr: s.inWRteAddr, expect: inRate, tolerance: 1 },
    { role: 'battery_out_rate', fc: 3, addr: s.outWRteAddr, expect: outRate, tolerance: 1 },
    { role: 'battery_min_reserve', fc: 3, addr: s.minRsvPctAddr, expect: minRsvRaw, tolerance: 1 },
    { role: 'battery_grid_charge', fc: 3, addr: s.chaGriSetAddr, expect: chaGriSet, tolerance: 0 },
    { role: 'battery_revert_tms', fc: 3, addr: s.inOutWRteRvrtTmsAddr, expect: rvrt, tolerance: 2 },
    { role: 'battery_storage_mode', fc: 3, addr: s.storCtlModAddr, expect: mode, tolerance: 0 },
  ];
  return { ok: true, writes, readbacks, ratePct, rateRaw, mode, chaGriSet, minRsvRaw };
}

module.exports = {
  SID,
  END_MODEL_ID,
  DEFAULT_BASE,
  COMMON_BASES,
  MODEL,
  M123,
  M123_LIMIT_BLOCK,
  M120,
  M124,
  WMAX_LIM_ENA,
  CURTAIL_WRITE_FC,
  resolveCurtailWriteFc,
  DEFAULT_WIN_TMS,
  DEFAULT_RMP_TMS,
  STORCTL_MOD,
  CHA_GRI_SET,
  DEFAULT_RVRT_TMS,
  DEFAULT_STORAGE_RVRT_TMS,
  DEFAULT_WMAX_LIM_PCT_SF,
  DEFAULT_INOUT_WRTE_SF,
  DEFAULT_MIN_RSV_PCT_SF,
  discover,
  discoverAt,
  resolveControls,
  resolveNameplate,
  resolveStorage,
  planCurtailment,
  planStorage,
  _helpers: { u32, s16, readWords },
};
