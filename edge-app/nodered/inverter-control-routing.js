'use strict';

/**
 * inverter-control-routing - the WRITE-side twin of inverter-routing.js: it
 * turns the retained `edge/inverter/config` selection + the guard-clamped
 * `edge/setpoint` command into a pure WRITE PLAN the Node-RED control adapter
 * executes (report data/vp-inverter-control-arch §4). Adding a control family =
 * one branch here, no core change - exactly like the read side.
 *
 * SAFETY (report §6, captain decision 3 - NON-NEGOTIABLE):
 *   - `controlRoute` is a PURE function: it computes a plan, it never does I/O.
 *     The executor (a Node-RED function node carrying a synced copy) performs the
 *     writes/readbacks. This makes the whole design unit-testable offline and
 *     pinned by flows-sync.test.js, just like route().
 *   - `setpoint.control_enabled` is the CORE's kill-switch (VP_CONTROL_ENABLED,
 *     default TRUE since vp-batctl-generic-r4) AND its per-model certification
 *     verdict (control_enabled = ControlEnabled AND certified), folded into one
 *     boolean the core publishes on edge/setpoint. On-by-default is safe ONLY
 *     because the certification allowlist is the per-device gate: an UNCERTIFIED
 *     family (every Deye/Fronius family) makes control_enabled false and `writes`
 *     EMPTY - the readbacks still run so the UI shows the inverter's ACTUAL state,
 *     but nothing is written. VP_CONTROL_ENABLED=false is the global stop.
 *   - A second, independent gate lives HERE: only families in
 *     CERTIFIED_CONTROL_FAMILIES may ever emit executable writes. An uncertified
 *     family (every Deye family until its model is bench-verified) returns
 *     writes:[] REGARDLESS of control_enabled, so a triangulated-but-unproven
 *     register address can never be written live. Its intended mapping is
 *     surfaced as `planned` (display/tests only, never executed) so the bench
 *     session has something concrete to verify.
 *   - Signs are configuration, never code: `connection.invert_control_sign`
 *     flips the battery-power write direction if the bench shows it inverted.
 *   - FIRST-LIGHT CALIBRATION is the ONE deliberate certification bypass: when
 *     the core sets `setpoint.calibration === true` (only during an armed, bounded,
 *     TTL-limited, single-shot calibration test - see internal/calibration + the
 *     agent), an UNCERTIFIED family may execute its EXISTING mapped WriteOps so the
 *     operator can prove sign + scale on the real inverter BEFORE certifying it.
 *     This bypass touches ONLY the certification gate: `control_enabled` (the core
 *     kill-switch) is STILL required, the value the core sends is STILL guard-clamped
 *     and magnitude-capped upstream, and the WriteOps are the SAME register mapping -
 *     nothing here is widened or reimplemented. Calibration writes carry dwell_s=0
 *     (a handful of writes in a bounded manual test, never the EEPROM-wear-sensitive
 *     optimizer cadence) so the controller-owned auto-revert is never blocked.
 *
 * The register maps stay in their owning modules (modbus-tcp.js for the SunSpec
 * profile, deye/deye-decode.js for the Deye families). This file only decides
 * WHICH control adapter runs and builds its WriteOp/ReadOp list.
 *
 * The flow's "Steuerung / Schreibplan" function node carries a synced COPY of
 * controlRoute (a Node-RED flow is self-contained JSON and cannot `require` a
 * repo file at runtime). This module is the source of truth + the test target
 * (inverter-control-routing.test.js); flows-sync.test.js pins the two together.
 */

const deyeDecode = require('./deye/deye-decode');
const sunspec = require('./sunspec/model-discovery');

const COMM_SOLARMAN = 'solarman_v5';
const COMM_MODBUS = 'modbus_tcp';
const COMM_FRONIUS = 'fronius_solar_api';

// Control tiers - the battery-control PRIMITIVE, decoupled from the read transport
// (design data/vp-battery-control-deepdive/report.md §1). Mirrors the Go
// inverter.ControlTier* constants; the core stamps `control_tier` onto the
// published selection and controlRoute DISPATCHES on it. Higher tier = more
// real-time + higher risk. The tier only selects which adapter runs; a live write
// is still gated by control_enabled + the certification allowlist.
const CONTROL_TIER = { READ_ONLY: 0, SUNSPEC: 1, VENDOR_EMS: 2, TOU: 3 };

// The Modbus-TCP control endpoint a Fronius device exposes for SunSpec control.
// It is a SEPARATE surface from the Solar-API HTTP READ endpoint (port 80): the
// installer ticks "Allow Control" in Communication -> Modbus, and SunSpec control
// then lives on TCP 502 of the SAME inverter IP (report §1.3). So the Fronius
// control adapter reads the shared `connection.ip` plus OPTIONAL control-specific
// `control_port` (default 502) + `control_unit_id` (default 1) - additive fields
// the read path ignores (parseConfig is forward-compatible). No product/UX change
// ships now: Fronius is UNCERTIFIED (planned-only), so these are documented
// bench/certification-time settings, defaulted so nothing breaks.
const DEFAULT_FRONIUS_CONTROL_PORT = 502;

// SunSpec / generic-Modbus control registers (the sim + the "Wechselrichter
// (automatisch)" generic path). Mirrors edge/sim/sunspec-sim.js writable regs.
const SUNSPEC_REG = { SETPOINT: 40, ENABLE: 41, PVLIMIT: 42 };
const NO_PV_LIMIT = 0xffff; // pv_limit sentinel: inverter free-runs (no cap)

// The per-family control CERTIFICATION allowlist (report §6.7). Only families
// listed here may emit EXECUTABLE writes; everything else is read-only until its
// register map is proven on the bench per model. generic_modbus/SunSpec is
// certified because it is proven end-to-end against edge/sim (report §4.4a).
// Deye families are DELIBERATELY absent - their ToU control addresses are
// triangulated (DEYE.md) and MUST be bench-verified before any live write.
const CERTIFIED_CONTROL_FAMILIES = new Set(['sunspec']);

const s16raw = (kw) => Math.round(kw * 100) & 0xffff; // int16, 0.01 kW two's complement
const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v);
}

// inferTierFromCommunication reproduces the exact pre-tier dispatch: Deye -> ToU,
// generic/Fronius SunSpec -> SunSpec, everything else -> read-only. Used only when
// the selection carries no explicit control_tier (an older core, or a hand-built
// selection), so a config without the field behaves byte-identically.
function inferTierFromCommunication(communication) {
  switch (communication) {
    case COMM_SOLARMAN: return CONTROL_TIER.TOU;
    case COMM_MODBUS: return CONTROL_TIER.SUNSPEC;
    case COMM_FRONIUS: return CONTROL_TIER.SUNSPEC;
    default: return CONTROL_TIER.READ_ONLY;
  }
}

// resolveControlTier prefers the tier the selection declares (control_tier, stamped
// by the core from the catalog), falling back to communication-inference when it is
// absent/invalid. This is the ONE place that decides the control primitive.
function resolveControlTier(selection) {
  const t = selection && selection.control_tier;
  if (typeof t === 'number' && isFinite(t) && t >= 0 && t <= 3) return Math.floor(t);
  return inferTierFromCommunication(selection ? selection.communication : '');
}

/**
 * controlRoute - map a parsed Selection + a setpoint command onto a WRITE PLAN.
 *
 *   selection: the parsed edge/inverter/config (inverter-routing.parseConfig
 *              output), or null when nothing is selected yet.
 *   setpoint:  { battery_setpoint_kw, pv_limit_kw?: number|null, source,
 *                slot_start?, control_enabled?: boolean,
 *                grid_charge_allowed?: boolean } - the core's guard-clamped
 *              command; control_enabled is the core kill-switch + cert verdict.
 *   opts:      { ratedKw?: number } - the model nameplate (Deye pv-limit %).
 *
 * Returns:
 *   { adapter, family, target, connection, certified, controlEnabled,
 *     writes: [WriteOp], readbacks: [ReadOp], planned?: [WriteOp], reason? }
 *
 * WriteOp = { role, fc, addr, value, encode, dwell_s, min_change }
 * ReadOp  = { role, fc:3, addr, expect, tolerance }
 */
function controlRoute(selection, setpoint, opts = {}) {
  const idle = (reason) => ({
    adapter: 'idle', family: '', certified: false, controlEnabled: false,
    writes: [], readbacks: [], reason,
  });

  if (!selection) return idle('keine Auswahl');
  const conn = selection.connection || {};
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return idle('keine IP-Adresse');
  if (!setpoint || !isFiniteNum(setpoint.battery_setpoint_kw)) {
    return idle('kein gueltiger Sollwert');
  }

  const controlEnabled = setpoint.control_enabled === true;
  // First-Light calibration bypass (see the SAFETY header): the core sets this ONLY
  // during a bounded, armed, TTL-limited test, and it bypasses ONLY the certification
  // gate - never control_enabled, never the guard clamp, never the magnitude cap.
  const calibration = setpoint.calibration === true;
  const family = typeof selection.family === 'string' ? selection.family.trim() : '';
  const certified = CERTIFIED_CONTROL_FAMILIES.has(family);
  const kw = setpoint.battery_setpoint_kw;
  const pvLimitKw = isFiniteNum(setpoint.pv_limit_kw) && setpoint.pv_limit_kw >= 0
    ? setpoint.pv_limit_kw : null;

  // Dispatch on the CONTROL TIER (the battery-control primitive), not the read
  // communication (report §1/§7.3). The tier decouples control from the transport
  // so a Tier-2 vendor can be added as catalog data; within a tier the register
  // SURFACE is still selected by communication/family (Tier 1 has two surfaces: the
  // generic/sim SunSpec and Fronius SunSpec). Every catalogued brand keeps its exact
  // prior adapter, so behaviour is byte-identical to the communication-only dispatch
  // (proven by the routing tests + flows-sync.test.js).
  const tier = resolveControlTier(selection);
  const comm = selection.communication;
  if (tier === CONTROL_TIER.TOU && comm === COMM_SOLARMAN) {
    return deyeControl({ selection, conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts });
  }
  if (tier === CONTROL_TIER.VENDOR_EMS) {
    return vendorEmsControl({ conn, ip, family, certified, controlEnabled });
  }
  if (tier === CONTROL_TIER.SUNSPEC) {
    if (comm === COMM_MODBUS) {
      return sunspecControl({ selection, conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw });
    }
    if (comm === COMM_FRONIUS) {
      return froniusControl({ conn, ip, family, certified, controlEnabled, kw, pvLimitKw, setpoint, opts });
    }
  }
  return idle('unbekannte Kommunikationsmethode');
}

// --- Tier-2 vendor external-EMS adapter (Sungrow/SolarEdge) - EXTENSION POINT -----
//
// The forced-watts RAM-setpoint path (report §3): mode -> command -> power, re-
// issued on a heartbeat. NOT built here - the Tier-2 vendor executors are Phase E.
// This stub makes the tier DISPATCH real + honest: a brand catalogued as
// control_tier=2 lands here instead of being misread as a Tier-1 SunSpec device
// just because its read transport happens to be modbus_tcp. It NEVER emits a live
// write (no catalogued brand is Tier 2 yet). When a Sungrow/SolarEdge adapter is
// built, replace this body with the vendor `{ems_mode_reg, cmd_reg, power_reg, ...}`
// WriteOps (behind the same controlEnabled + certification gate).
function vendorEmsControl({ conn, ip, family, controlEnabled }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
  return {
    adapter: 'vendor_ems', family,
    target: ip + ':' + port,
    connection: { ip, port },
    certified: false, // no Tier-2 vendor is bench-certified yet
    controlEnabled,
    writes: [],
    readbacks: [],
    planned: [],
    reason: 'Tier-2 Wechselrichtersteuerung (externes EMS) noch nicht implementiert',
  };
}

// The controller-owned staleness window (report §5.5/§7.5): an edge/setpoint whose
// core timestamp is older than this is treated as the core having gone silent, so
// the executor hands control BACK rather than latching the last command. Mirrors
// the Go plan.StaleAfter (20 min). A native inverter revert timer, where it exists,
// is a bonus - we never depend on one (Fronius storage has none).
const SETPOINT_STALE_MS = 20 * 60 * 1000;

/**
 * controlRelease - the CONTROLLER-OWNED FAILSAFE write plan (report §2.5/§7.5).
 * Returns the NEUTRAL write plan the executor issues when it must hand control
 * BACK: edge/setpoint stale (>20 min = core silent), connection loss, or
 * control_enabled -> false after we held control. It commands NO power, so sign
 * and scale never matter; per-tier neutral:
 *   Tier 1 SunSpec (sim/generic): control_enable = 0 (+ setpoint 0, cap cleared)
 *   Tier 1 Fronius SunSpec:       StorCtl_Mod = 0 + WMaxLim_Ena = 0 (discovered)
 *   Tier 3 Deye:                  Time-of-Use disabled (revert to self-consumption)
 *   Tier 2 vendor EMS:            mode -> self-consumption (extension point)
 *
 * Gated EXACTLY like controlRoute: only a CERTIFIED family emits executable release
 * writes; an uncertified family (Deye, Fronius) is planned-only, dormant until its
 * bench pass. So in production only the certified SunSpec path actually releases;
 * the Deye/Fronius release is proven by unit tests, never a live write. The ONE
 * exception mirrors controlRoute: `opts.calibration === true` (a First-Light test's
 * controller-owned auto-revert) lets the uncertified family emit the neutral release
 * so the bounded calibration write is HANDED BACK, never latched - the same
 * certification-only bypass, with dwell_s=0 so the revert is not blocked.
 *
 *   selection: the parsed edge/inverter/config (or null)
 *   opts:      { sunspec?: discovery, calibration?: boolean } - live SunSpec model
 *              discovery for Fronius + the calibration-revert bypass.
 * Returns { adapter, family, tier, certified, mode:'release', target, connection,
 *           writes:[WriteOp], readbacks:[ReadOp], planned:[WriteOp], reason? }.
 */
function controlRelease(selection, opts = {}) {
  const calibration = opts.calibration === true;
  const idle = (reason) => ({
    adapter: 'idle', family: '', tier: CONTROL_TIER.READ_ONLY, certified: false,
    mode: 'release', writes: [], readbacks: [], planned: [], reason,
  });
  if (!selection) return idle('keine Auswahl');
  const conn = selection.connection || {};
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return idle('keine IP-Adresse');
  const family = typeof selection.family === 'string' ? selection.family.trim() : '';
  const certified = CERTIFIED_CONTROL_FAMILIES.has(family);
  // releaseAllowed = the family is certified OR this is a calibration-test revert.
  const releaseAllowed = certified || calibration;
  const tier = resolveControlTier(selection);
  const comm = selection.communication;

  if (tier === CONTROL_TIER.TOU && comm === COMM_SOLARMAN) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
    const serial = conn.serial;
    const slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;
    const reg = deyeFamilyControlReg(family);
    // Neutral TOU slot: DISABLE the Time-of-Use scheduler so the inverter reverts to
    // its own self-consumption logic. EEPROM -> write-on-change (dwell_s), and never
    // emitted for an uncertified family EXCEPT a calibration-test revert (dwell_s=0
    // so it is not blocked). String/micro (no ToU) has nothing to release.
    const planned = reg ? [{
      role: 'tou_enable', fc: 6, addr: reg.touEnable, value: 0,
      encode: { kind: 'tou_mask', all_week: false, release: true },
      dwell_s: calibration ? 0 : 900, min_change: 0, bench_pending: true,
    }] : [];
    const readbacks = reg ? [{ role: 'tou_enable', fc: 3, addr: reg.touEnable, expect: 0, tolerance: 0 }] : [];
    return {
      adapter: 'solarman_v5', family, tier, certified, calibration, mode: 'release',
      target: ip + ':' + port, connection: { ip, port, serial, mb_slave_id: slaveId },
      writes: releaseAllowed ? planned : [], readbacks: releaseAllowed ? readbacks : [],
      planned, reason: releaseAllowed ? undefined : 'Steuerung für dieses Modell noch nicht freigegeben',
    };
  }

  if (tier === CONTROL_TIER.VENDOR_EMS) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    return {
      adapter: 'vendor_ems', family, tier, certified: false, mode: 'release',
      target: ip + ':' + port, connection: { ip, port },
      writes: [], readbacks: [], planned: [],
      reason: 'Tier-2 Wechselrichtersteuerung (externes EMS) noch nicht implementiert',
    };
  }

  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_MODBUS) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
    // Hand back to self-consumption: control_enable OFF, setpoint cleared, cap cleared.
    const planned = [
      { role: 'control_enable', fc: 6, addr: SUNSPEC_REG.ENABLE, value: 0, encode: { kind: 'flag' }, dwell_s: 0, min_change: 0 },
      { role: 'battery_power', fc: 6, addr: SUNSPEC_REG.SETPOINT, value: 0, encode: { kind: 'kw_x100_s16', scale: 100, kw: 0 }, dwell_s: 0, min_change: 0 },
      { role: 'pv_limit', fc: 6, addr: SUNSPEC_REG.PVLIMIT, value: NO_PV_LIMIT, encode: { kind: 'pv_limit_x100_u16', scale: 100, sentinel: NO_PV_LIMIT, kw: null }, dwell_s: 0, min_change: 0 },
    ];
    const readbacks = [
      { role: 'control_enable', fc: 3, addr: SUNSPEC_REG.ENABLE, expect: 0, tolerance: 0 },
      { role: 'battery_power', fc: 3, addr: SUNSPEC_REG.SETPOINT, expect: 0, tolerance: 1 },
      { role: 'pv_limit', fc: 3, addr: SUNSPEC_REG.PVLIMIT, expect: NO_PV_LIMIT, tolerance: 1 },
    ];
    return {
      adapter: 'modbus_tcp', family, tier, certified, calibration, mode: 'release', profile: family,
      target: ip + ':' + port, connection: { ip, port, unit_id: unitId },
      writes: releaseAllowed ? planned : [], readbacks: releaseAllowed ? readbacks : [],
      planned, reason: releaseAllowed ? undefined : 'Modell noch nicht freigegeben',
    };
  }

  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_FRONIUS) {
    // Fronius storage has NO native revert timer (report §2.5) - exactly why the
    // controller must own this. Release = idle storage (StorCtl_Mod=0) + disabled
    // curtailment (WMaxLim_Ena=0), both at DISCOVERED addresses (reuse planStorage(0)
    // / planCurtailment(null)). Uncertified -> planned-only, no fabricated address.
    const port = Number(conn.control_port) > 0 ? Number(conn.control_port) : DEFAULT_FRONIUS_CONTROL_PORT;
    const unitId = Number(conn.control_unit_id) > 0 ? Number(conn.control_unit_id) : 1;
    const discovery = opts.sunspec || null;
    const curtail = sunspec.planCurtailment({ discovery, pvLimitKw: null });
    const storage = sunspec.planStorage({ discovery, batterySetpointKw: 0 });
    const planned = [
      ...(curtail.ok ? curtail.writes.map((w) => ({ ...w, bench_pending: true })) : []),
      ...(storage.ok ? storage.writes.map((w) => ({ ...w, bench_pending: true })) : []),
    ];
    return {
      adapter: 'fronius_sunspec', family, tier, certified, mode: 'release',
      target: ip + ':' + port, connection: { ip, port, unit_id: unitId },
      writes: [], readbacks: [], planned,
      reason: planned.length > 0 ? 'Fronius SunSpec: Steuerung nicht freigegeben'
        : 'Fronius SunSpec: ' + curtail.reason + ' (Steuerung nicht freigegeben)',
    };
  }

  return idle('unbekannte Kommunikationsmethode');
}

/**
 * setpointStale - the executor-owned dead-man's check: true when the setpoint's
 * core timestamp is older than SETPOINT_STALE_MS (the core went silent). A missing
 * / unparseable ts is treated as NOT stale (the core always stamps ts; never release
 * on a parse quirk). `nowMs` defaults to Date.now() (overridable for tests).
 */
function setpointStale(ts, nowMs) {
  if (typeof ts !== 'string' || ts === '') return false;
  const t = Date.parse(ts);
  if (!isFinite(t)) return false;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return now - t > SETPOINT_STALE_MS;
}

/**
 * dualControllerSignal - the GENERIC "only-controller" awareness (evcc's hard rule
 * + report §9 failure #6). While VoltPilot controls, the inverter's OWN smart-control
 * (self-consumption+, native scheduling) MUST be off, or two controllers fight. We
 * cannot force the inverter's setting off, but we SURFACE a possible conflict so it
 * is never SILENTLY fought.
 *
 * The GENERIC detector (active for every adapter that reads back): while actively
 * controlling a certified device, a register we commanded that does NOT hold its
 * value (readback mismatch) is the signal that something else may be steering the
 * inverter. Honest "possible" - it can also be a not-yet-adopted write; the reason
 * tells the operator to make VoltPilot the ONLY controller. This applies to the Deye
 * Tier-3 path AND the SunSpec Tier-1 path unchanged (it keys on the readback facts,
 * not the vendor).
 *
 * VENDOR-SPECIFIC detectors are EXTENSION POINTS that land with their tiers:
 *   - Fronius (Tier 1, Phase D): the manual AND-links `ChaGriSet` with the web-UI
 *     "battery charging from grid" toggle, so a GRID command is silently vetoed by a
 *     UI setting (report §2.7) - read ChaGriSet back + compare. Seam: opts.vendor.
 *   - SolarEdge (Tier 2, Phase E): read StorageControlMode (0xE004); != 4 (Remote
 *     Control) means a UI/second controller left remote mode. Seam: opts.vendor.
 * Neither vendor read is wired yet; the seams keep the generic path untouched when
 * a detector is added.
 *
 *   facts: { family, certified, controlEnabled, registerCount, allMatch, mismatchRoles }
 * Returns { onlyControllerRequired, possibleConflict, detector, reason }.
 */
function dualControllerSignal(facts = {}) {
  const controlling = facts.certified === true
    && facts.controlEnabled === true
    && Number(facts.registerCount) > 0;
  const out = {
    onlyControllerRequired: controlling,
    possibleConflict: false,
    detector: controlling ? 'readback_mismatch' : 'none',
    reason: '',
  };
  if (!controlling) return out;

  // --- vendor-specific extension points (Phase D/E) -- see the docstring. The
  //     detectors read a vendor register (Fronius ChaGriSet, SolarEdge storage
  //     mode) via opts.vendor and set possibleConflict; not wired yet, so we fall
  //     through to the generic detector without touching it.

  // --- generic detector: a commanded register that does not hold its value ---
  if (facts.allMatch !== true) {
    const roles = Array.isArray(facts.mismatchRoles) ? facts.mismatchRoles : [];
    out.possibleConflict = true;
    out.reason = 'Der Wechselrichter hält den geschriebenen Sollwert nicht ('
      + (roles.join(', ') || 'Register weicht ab')
      + '). Möglicher Konflikt: die eigene Smart-Steuerung des Wechselrichters oder ein '
      + 'zweites EMS könnte gegensteuern - VoltPilot muss der einzige Controller sein.';
  }
  return out;
}

// --- generic_modbus / SunSpec control adapter (CERTIFIED, proven vs sim) ------

function sunspecControl({ selection, conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
  const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
  const invert = conn.invert_control_sign === true;

  const battKw = invert ? -kw : kw;
  const battRaw = s16raw(battKw);
  const pvRaw = pvLimitKw == null ? NO_PV_LIMIT : Math.max(0, Math.round(pvLimitKw * 100)) & 0xffff;

  // The intended writes (always computed so the readback surface + tests see the
  // full mapping); whether they EXECUTE depends on the gate below.
  const planned = [
    {
      role: 'battery_power', fc: 6, addr: SUNSPEC_REG.SETPOINT, value: battRaw,
      encode: { kind: 'kw_x100_s16', scale: 100, kw: battKw }, dwell_s: 0, min_change: 0,
    },
    {
      role: 'control_enable', fc: 6, addr: SUNSPEC_REG.ENABLE, value: 1,
      encode: { kind: 'flag' }, dwell_s: 0, min_change: 0,
    },
    {
      role: 'pv_limit', fc: 6, addr: SUNSPEC_REG.PVLIMIT, value: pvRaw,
      encode: { kind: 'pv_limit_x100_u16', scale: 100, sentinel: NO_PV_LIMIT, kw: pvLimitKw },
      dwell_s: 0, min_change: 0,
    },
  ];

  // Readbacks ALWAYS run (report §5): read every control register back so the UI
  // shows the inverter's actual value, whether or not we wrote this tick.
  const readbacks = [
    { role: 'battery_power', fc: 3, addr: SUNSPEC_REG.SETPOINT, expect: battRaw, tolerance: 1 },
    { role: 'control_enable', fc: 3, addr: SUNSPEC_REG.ENABLE, expect: 1, tolerance: 0 },
    { role: 'pv_limit', fc: 3, addr: SUNSPEC_REG.PVLIMIT, expect: pvRaw, tolerance: 1 },
  ];

  // Certification bypass ONLY for a First-Light calibration write (control_enabled
  // still required). sunspec is already certified, so calibration is a no-op here -
  // the bypass exists for the uncertified Deye path; kept uniform for clarity.
  const writeAllowed = controlEnabled && (certified || calibration);
  const out = {
    adapter: 'modbus_tcp', family, profile: family,
    target: ip + ':' + port,
    connection: { ip, port, unit_id: unitId },
    certified, controlEnabled, calibration: calibration === true,
    writes: writeAllowed ? planned : [],
    readbacks,
    planned,
  };
  if (!writeAllowed) {
    out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Modell noch nicht freigegeben';
  }
  return out;
}

// --- Fronius SunSpec-Modbus control adapter (UNCERTIFIED - planned only) ------
//
// Fronius battery control uses the standards-based SunSpec Modbus surface, NOT
// the Solar-API HTTP read path and NOT the evcc `config/timeofuse` HTTP hack
// (rejected by the design report §3.1 - unversioned, credentialed, broken twice).
//   - Increment 1 = CURTAILMENT: Model 123 `WMaxLimPct`, the direct SunSpec
//     analogue of the already-certified sim `pv_limit` write (sunspecControl above).
//   - Increment 2 = BATTERY CHARGE/DISCHARGE: Model 124 (Storage) `InWRte`/`OutWRte`
//     (% of the discovered `WChaMax`) + `StorCtl_Mod` bits, `MinRsvPct` (soc floor)
//     and the EEG-gated `ChaGriSet` grid-charge gate, with the native
//     `InOutWRte_RvrtTms` dead-man's switch. HIGHER RISK - a wrong sign/scale can
//     affect a real battery's health/warranty (report §3.4).
//
// SAFETY (captain decision 3 - NON-NEGOTIABLE): Fronius is DELIBERATELY absent from
// CERTIFIED_CONTROL_FAMILIES, so this adapter NEVER emits an executable write
// (writes:[]) and NEVER fabricates a readback against an unproven/undiscovered
// register (readbacks:[]) - exactly the Deye discipline. Both increments' intended
// WriteOps are surfaced as `planned` (bench artefact, marked bench_pending) ONLY
// when a live SunSpec model-discovery result is supplied via opts.sunspec; without
// it we cannot know the Model 123/124 bases, so `planned` is empty and the reason
// says discovery is required - never a fabricated address (report §3.3). Battery
// control stays bench_pending PER battery brand until a real-hardware bench pass
// (CONTROL-BENCH.md → Fronius storage), after which the family joins BOTH allowlists.
//
// The adapter name 'fronius_sunspec' is distinct from 'modbus_tcp', so the flow's
// generic-Modbus control executor no-ops on it (like it does for Deye's
// 'solarman_v5') - there is no code path that could execute a Fronius write here.
const FRONIUS_NOT_CERTIFIED_REASON = 'Steuerung für dieses Modell noch nicht freigegeben';

function froniusControl({ conn, ip, family, certified, controlEnabled, kw, pvLimitKw, setpoint, opts }) {
  const port = Number(conn.control_port) > 0 ? Number(conn.control_port) : DEFAULT_FRONIUS_CONTROL_PORT;
  const unitId = Number(conn.control_unit_id) > 0 ? Number(conn.control_unit_id) : 1;
  // Sign is CONFIG, never code: invert_control_sign flips the battery-power write
  // direction if the bench shows it inverted (same as sunspecControl/deyeControl).
  const invert = conn.invert_control_sign === true;
  const battKw = isFiniteNum(kw) ? (invert ? -kw : kw) : 0;
  const sp = setpoint || {};
  const gridChargeAllowed = sp.grid_charge_allowed === true;
  const socMin = isFiniteNum(sp.soc_min_pct) ? sp.soc_min_pct : 5;

  // Both plans need a live SunSpec model-discovery result (Model 123/124 bases +
  // the live nameplate/WChaMax scalars). The flow/core performs the discovery walk
  // I/O and passes it in via opts.sunspec; controlRoute itself stays a pure
  // function. Absent -> plan.ok=false -> no planned addresses (idle-safe), and the
  // adapter output is byte-identical to the flow's Fronius branch (no in-flow
  // discovery), so flows-sync.test.js stays green.
  const discovery = opts.sunspec || null;
  const curtailPlan = sunspec.planCurtailment({
    discovery,
    pvLimitKw,
    nameplateKw: opts.nameplateKw,
    wMaxLimPctSf: opts.wMaxLimPctSf,
    rvrtTms: opts.rvrtTms,
  });
  const storagePlan = sunspec.planStorage({
    discovery,
    batterySetpointKw: battKw,
    gridChargeAllowed,
    socMinPct: socMin,
    wChaMaxKw: opts.wChaMaxKw,
    inOutWRteSf: opts.inOutWRteSf,
    minRsvPctSf: opts.minRsvPctSf,
    rvrtTms: opts.storageRvrtTms,
  });

  const planned = [
    ...(curtailPlan.ok ? curtailPlan.writes.map((w) => ({ ...w, bench_pending: true })) : []),
    ...(storagePlan.ok ? storagePlan.writes.map((w) => ({ ...w, bench_pending: true })) : []),
  ];
  // When nothing planned, the honest reason is the discovery/model failure (curtailment
  // reports it first). This keeps the opts.sunspec-absent output identical to the flow.
  const reason = planned.length > 0
    ? FRONIUS_NOT_CERTIFIED_REASON
    : 'Fronius SunSpec: ' + curtailPlan.reason + ' (Steuerung nicht freigegeben)';

  return {
    adapter: 'fronius_sunspec', family,
    target: ip + ':' + port,
    connection: { ip, port, unit_id: unitId },
    certified, // false until bench-certified
    controlEnabled,
    // Read-only until certified: NEVER an executable write, and no fake readback
    // of a register we have not discovered + proven on the bench.
    writes: [],
    readbacks: [],
    planned,
    reason,
  };
}

// --- deye / hybrid control adapter (UNCERTIFIED - read-only until bench) ------
//
// The battery-power -> live ToU slot translation (report §3.3 strategy A). The
// addresses are now SOURCED from ha-solarman (see DEYE_CONTROL_REG below), no
// longer triangulated, but they are STILL BENCH-PENDING per model/firmware, so
// this adapter NEVER emits executable writes (writes:[]). The `planned` list
// carries the intended ToU mapping for the :8484 display and the unit tests -
// it is the concrete artefact the bench session verifies, not a live command.
//
// SOURCE (facts, not code): davidrapan/ha-solarman (MIT) inverter_definitions -
// deye_p3.yaml (SG04LP3 LV + SG01HP3 HV -> our hybrid_3p; "Tested with
// 25K-SG01HP3 12K-SG04LP3") and deye_hybrid.yaml (SG0*LP1 -> our hybrid_1p).
// ha-solarman controls the SAME Solarman-V5 WiFi logger we use, so it PROVES the
// logger passes control writes and its per-model register profiles are the
// reliable address source. The register ADDRESSES/scales/enums are facts,
// re-expressed here in our own adapter structure with attribution; no ha-solarman
// CODE is copied. Our earlier 0x0F00-region triangulation was WRONG: a read-only
// bench dump of the captain's SG04LP3 showed 0x0F00.. holds LIVE TELEMETRY, not
// the ToU/work-mode config - the real levers live in the 0x008D..0x00B1 (3p) /
// 0x00F3..0x0117 (1p) holding-register block, OUTSIDE the telemetry window
// (data/learnings.md 2026-07-08).

// Deye hybrid ToU / work-mode control registers, PER battery-capable family.
// String/micro (no battery) are handled separately (active-power-limit only).
// Program N (N=1..6) registers are contiguous, so we address them by a base +
// the slot index. VoltPilot commands through ONE live ToU program slot
// (DEYE_CONTROL_SLOT, Program 1) - strategy A.
const DEYE_CONTROL_REG = {
  // hybrid_3p: SUN-*-SG04LP3 (LV) + SUN-*-SG01HP3 (HV). ha-solarman deye_p3.yaml
  // "Work Mode" + "Time of Use" groups. Program Power uses ha-solarman's scale
  // [1, 10] (LV = 1 -> W, HV = 10 -> decawatt), selected on-device by the
  // `power_scale` config (default 1; HV sets 10) exactly like the read map.
  hybrid_3p: {
    energyPattern: 0x008d, // Battery First(0) / Load First(1)
    workMode: 0x008e, // Export First(0) / Zero Export To Load(1) / Zero Export To CT(2)
    maxSellPower: 0x008f, // W (scale [1,10])
    solarSell: 0x0091, // Export Surplus (Solar Sell) switch
    touEnable: 0x0092, // Time of Use enable + weekday mask (bit0=Enabled; 0x00FF="Week")
    progTimeBase: 0x0094, // Program 1..6 Time (HHMM)             0x0094..0x0099
    progPowerBase: 0x009a, // Program 1..6 Power (W, scale [1,10]) 0x009A..0x009F
    progSocBase: 0x00a6, // Program 1..6 target SOC (%)          0x00A6..0x00AB
    progChargeBase: 0x00ac, // Program 1..6 Charging enum          0x00AC..0x00B1
    maxChargeCurrent: 0x006c, // Battery Max Charging Current (A)
    maxDischargeCurrent: 0x006d, // Battery Max Discharging Current (A)
    exportLimit: 0x00e7, // "Grid Max Export power" (feed-in cap, W)
    exportLimitScale: 10, // 0x00E7 fixed scale 10 (register = W / 10)
  },
  // hybrid_1p: SUN-*-SG03LP1 low map. ha-solarman deye_hybrid.yaml "Work Mode"
  // group. No dedicated "Grid Max Export power" register on this family, so the
  // feed-in cap maps to "Export Surplus Power" (Max Sell Power, W, scale 1).
  hybrid_1p: {
    energyPattern: 0x00f3,
    workMode: 0x00f4,
    maxSellPower: 0x00f5,
    solarSell: 0x00f7,
    touEnable: 0x00f8,
    progTimeBase: 0x00fa, // 0x00FA..0x00FF
    progPowerBase: 0x0100, // 0x0100..0x0105
    progSocBase: 0x010c, // 0x010C..0x0111
    progChargeBase: 0x0112, // 0x0112..0x0117
    maxChargeCurrent: 0x00d2,
    maxDischargeCurrent: 0x00d3,
    exportLimit: 0x00f5, // Max Sell Power (W, scale 1)
    exportLimitScale: 1,
  },
};

// ha-solarman enum values (facts from the two Deye definitions).
const DEYE_WORK_MODE = { EXPORT_FIRST: 0, ZERO_EXPORT_TO_LOAD: 1, ZERO_EXPORT_TO_CT: 2 };
// "Time of Use" enable: 0x00FF = "Week" (all 7 weekday bits) with bit0 = Enabled.
const DEYE_TOU_ENABLED_ALL_WEEK = 0x00ff;
// "Program N Charging" enum: Disabled / Grid / Generator / Both.
const DEYE_PROG_CHARGE = { DISABLED: 0, GRID: 1, GENERATOR: 2, BOTH: 3 };
// VoltPilot drives ONE live ToU program slot (Program 1, zero-based index 0).
const DEYE_CONTROL_SLOT = 0;
// Program-1 start time (HHMM). 00:00 makes Program 1 the BASE slot of the day, so the
// slot VoltPilot commands is the governing window at "now" (report §6): the ToU
// scheduler picks the program whose start time is the latest one <= now, and Program 1
// starting at midnight is the base. Without writing this, Program 1's stored time window
// may not bracket "now" and the inverter ignores the commanded slot even though every
// register reads back correctly. HHMM 00:00 = raw 0 in both decimal-HHMM and BCD, so the
// exact time encoding (bench-verified per firmware) does not change the base-slot intent.
const DEYE_PROGRAM_TIME_BASE_HHMM = 0;

function deyeFamilyControlReg(family) {
  return Object.prototype.hasOwnProperty.call(DEYE_CONTROL_REG, family)
    ? DEYE_CONTROL_REG[family] : null;
}

function deyeControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
  const serial = conn.serial;
  const slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;
  const invert = conn.invert_control_sign === true;
  const socMin = isFiniteNum(setpoint.soc_min_pct) ? setpoint.soc_min_pct : 5;
  // power_scale mirrors the read map: LV = 1 (register in W), HV = 10 (decawatt).
  const powerScale = Number(conn.power_scale) > 0 ? Number(conn.power_scale) : 1;

  const reg = deyeFamilyControlReg(family);
  // The un-gated Deye adapter: the SAME two-gate discipline as sunspecControl.
  // `planned` is always the real ToU/power WriteOps (from DEYE_CONTROL_REG); a live
  // write/readback only flows when certified AND control_enabled. Deye stays OUT of
  // CERTIFIED_CONTROL_FAMILIES (bench-pending per firmware), so in production
  // writeAllowed is ALWAYS false -> writes:[]/readbacks:[] (dormant). The gate is
  // now generic: adding hybrid_3p to the allowlist after a bench pass flips control
  // on with no code change. EEPROM discipline rides on each WriteOp (dwell_s >= 900,
  // min_change) - the executor writes on change, the 10 s tick drives readback only.
  // The two-gate discipline PLUS the First-Light calibration bypass: a live write
  // needs control_enabled (the core kill-switch) AND (the family is certified OR
  // this is a bounded calibration test). Calibration bypasses ONLY certification -
  // exactly the mechanism for the first real write to prove sign/scale before the
  // bench pass. In production (no calibration flag) Deye stays writes:[] as before.
  const writeAllowed = controlEnabled && (certified || calibration);
  // Readback tolerance: the power register is decawatt/watt-scaled so allow ±1 raw
  // unit; the enum/flag registers must match exactly.
  const deyeRbTol = (role) => (role === 'battery_power' || role === 'pv_limit' ? 1 : 0);
  const finalize = (planned) => {
    const readbacks = planned.map((w) => ({ role: w.role, fc: 3, addr: w.addr, expect: w.value & 0xffff, tolerance: deyeRbTol(w.role) }));
    // executable writes carry no bench_pending flag (that is a display marker on
    // `planned`); the two objects otherwise match address-for-address. A CALIBRATION
    // write forces dwell_s=0/min_change=0: a bounded manual test does a handful of
    // writes (well inside EEPROM endurance) and the controller-owned auto-revert
    // must NOT be blocked by the 900 s optimizer dwell. The normal (certified,
    // non-calibration) path keeps its EEPROM write-on-change cadence untouched.
    const execWrites = planned.map((w) => {
      const c = { ...w }; delete c.bench_pending;
      if (calibration) { c.dwell_s = 0; c.min_change = 0; }
      return c;
    });
    const out = {
      adapter: 'solarman_v5', family,
      target: ip + ':' + port,
      connection: { ip, port, serial, mb_slave_id: slaveId },
      certified, controlEnabled, calibration: calibration === true,
      writes: writeAllowed ? execWrites : [],
      readbacks: writeAllowed ? readbacks : [],
      planned,
    };
    if (!writeAllowed) {
      out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Steuerung für dieses Modell noch nicht freigegeben';
    }
    return out;
  };

  // String / micro Deye: NO battery, NO ToU. The only lever is the active-power
  // limit (0x0028), which IS the correct register there (unlike on a hybrid).
  if (!reg) {
    const ratedKw = Number(opts.ratedKw) > 0 ? Number(opts.ratedKw) : 0;
    const planned = [];
    if (pvLimitKw != null && ratedKw > 0) {
      planned.push({
        role: 'pv_limit', fc: 6, addr: deyeDecode.POWER_LIMIT_REG,
        value: clampPct((pvLimitKw / ratedKw) * 100),
        encode: { kind: 'active_power_pct', rated_kw: ratedKw, kw: pvLimitKw },
        dwell_s: 900, min_change: 1, bench_pending: true,
      });
    }
    return finalize(planned);
  }

  const battKw = invert ? -kw : kw;
  const charging = battKw > 0;
  // Program Power is the slot's charge/discharge power cap (W / power_scale).
  const powerReg = Math.max(0, Math.round((Math.abs(battKw) * 1000) / powerScale)) & 0xffff;
  // Direction is encoded by the slot's target SoC (strategy A): charge -> full,
  // discharge -> the operating floor. ha-solarman "Program N SOC", %.
  const targetSoc = charging ? 100 : clampPct(socMin);
  // Grid-charge is EEG-gated: the slot's "Program N Charging" is only ever set to
  // Grid when the site explicitly permits grid charging (netzladen_erlaubt) AND
  // the slot is charging. Default = Disabled (an EEG plant must never grid-charge;
  // the optimizer already refuses it - this is the on-device belt-and-braces).
  const gridChargeAllowed = setpoint.grid_charge_allowed === true;
  const chargeEnum = gridChargeAllowed && charging
    ? DEYE_PROG_CHARGE.GRID : DEYE_PROG_CHARGE.DISABLED;

  const slot = DEYE_CONTROL_SLOT;
  const planned = [
    {
      // Export First lets the ToU schedule sell surplus (grid arbitrage); the
      // exact work-mode value is bench-verified per firmware.
      role: 'work_mode', fc: 6, addr: reg.workMode, value: DEYE_WORK_MODE.EXPORT_FIRST,
      encode: { kind: 'work_mode', enum: 'export_first' }, dwell_s: 900, min_change: 0, bench_pending: true,
    },
    {
      // Turn the ToU scheduler on for all weekdays (bit0=Enabled, 0x00FF="Week").
      role: 'tou_enable', fc: 6, addr: reg.touEnable, value: DEYE_TOU_ENABLED_ALL_WEEK,
      encode: { kind: 'tou_mask', all_week: true }, dwell_s: 900, min_change: 0, bench_pending: true,
    },
    {
      // Set Program 1's start time to 00:00 so the commanded slot is the day's BASE
      // window - otherwise a stale program time may leave Program 1 inactive at "now"
      // and the inverter ignores the setpoint even though the registers echo (report §6).
      role: 'program_time', fc: 6, addr: reg.progTimeBase + slot, value: DEYE_PROGRAM_TIME_BASE_HHMM,
      encode: { kind: 'program_time_hhmm', hhmm: DEYE_PROGRAM_TIME_BASE_HHMM }, dwell_s: 900, min_change: 0, bench_pending: true,
    },
    {
      role: 'battery_power', fc: 6, addr: reg.progPowerBase + slot, value: powerReg,
      encode: { kind: 'watt_scaled_u16', scale: powerScale, kw: battKw }, dwell_s: 900, min_change: 50, bench_pending: true,
    },
    {
      role: 'battery_target_soc', fc: 6, addr: reg.progSocBase + slot, value: targetSoc,
      encode: { kind: 'pct', direction: charging ? 'charge' : 'discharge' },
      dwell_s: 900, min_change: 1, bench_pending: true,
    },
    {
      role: 'grid_charge_enable', fc: 6, addr: reg.progChargeBase + slot, value: chargeEnum,
      encode: { kind: 'charge_enum', eeg_gated: true, disabled: DEYE_PROG_CHARGE.DISABLED, grid: DEYE_PROG_CHARGE.GRID },
      dwell_s: 900, min_change: 0, bench_pending: true,
    },
  ];
  // pv_limit -> the family's feed-in cap register, in W / register-scale. Absent
  // (no curtailment) -> no write, matching the schedule contract (absent = no
  // limit), so an uncurtailed tick never touches the export cap.
  if (pvLimitKw != null) {
    const capW = Math.max(0, pvLimitKw * 1000);
    planned.push({
      role: 'pv_limit', fc: 6, addr: reg.exportLimit,
      value: Math.round(capW / reg.exportLimitScale) & 0xffff,
      encode: { kind: 'feed_in_cap_w', scale: reg.exportLimitScale, kw: pvLimitKw },
      dwell_s: 900, min_change: 1, bench_pending: true,
    });
  }

  return finalize(planned);
}

module.exports = {
  COMM_SOLARMAN,
  COMM_MODBUS,
  COMM_FRONIUS,
  CONTROL_TIER,
  DEFAULT_FRONIUS_CONTROL_PORT,
  SUNSPEC_REG,
  NO_PV_LIMIT,
  DEYE_CONTROL_REG,
  DEYE_WORK_MODE,
  DEYE_PROG_CHARGE,
  DEYE_TOU_ENABLED_ALL_WEEK,
  DEYE_CONTROL_SLOT,
  CERTIFIED_CONTROL_FAMILIES,
  SETPOINT_STALE_MS,
  resolveControlTier,
  controlRoute,
  controlRelease,
  setpointStale,
  dualControllerSignal,
};
