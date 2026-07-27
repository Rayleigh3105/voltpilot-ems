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

// The Modbus WRITE function code for a Deye control register write. FC16
// (write-multiple, 0x10) is the DEFAULT and 0x06 (write-single) the legacy flip-back.
// WHY FC16 by default: many Deye hybrid firmwares behind the Solarman/LSW3 logger
// ACCEPT an FC6 write frame at the transport but the inverter never answers it and
// the register does not change - the live Pilsting symptom (the logger frames a V5
// reply carrying a 2-byte stub where the FC6 echo belongs). The Deye integrations
// that demonstrably write to these inverters over the SAME Solarman-V5 logger use
// FC16 for every register, even a single one: deye-controller
// (githubDante/deye-controller) writes via `write_multiple_holding_registers(addr,
// [value])` exclusively, and ha-solarman (davidrapan/ha-solarman) - the source of our
// register map - writes via pysolarmanv5's FC16 path; the community consensus (DIY
// Solar / ha-solarman issues) is that some Deye firmware only answers 0x10 and an FC6
// write "reports success but makes no actual change". So Deye control writes go out as
// FC16 by default. It stays a per-register write (NOT a contiguous block) so the
// EEPROM write-on-change discipline is unchanged - block-writing this scattered ToU
// map would touch unrelated registers and rewrite unchanged ones (evcc #27458
// documents an adjacent-SoC-register clobber near 0x00A6), and would increase write
// frequency, which is forbidden. `control_write_fc: 6` on the connection flips back.
const DEYE_WRITE_FC_FC16 = 16;
const DEYE_WRITE_FC_FC6 = 6;
function resolveDeyeWriteFc(conn) {
  const v = conn ? conn.control_write_fc : undefined;
  if (v === DEYE_WRITE_FC_FC6 || v === '6') return DEYE_WRITE_FC_FC6;
  return DEYE_WRITE_FC_FC16; // 0 (auto) / 16 / absent / anything else -> FC16
}

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
    // A Deye is Tier 3 (ToU) by catalog, but a firmware carrying the V105.1+ remote
    // block gives it a TRUE Tier-2 setpoint. The PROBED capability (opts.deye, filled
    // by the executor and cached per logger) decides which adapter runs; no capability
    // yet -> the legacy ToU path, so a device that was never probed behaves exactly as
    // before. `remote_mode: 'off'` on the connection is the operator's force-ToU hatch.
    const cap = (opts && opts.deye && typeof opts.deye === 'object') ? opts.deye : null;
    const remoteOff = conn.remote_mode === 'off' || conn.remote_mode === false;
    if (!remoteOff && deyeControlPath(cap) === DEYE_PATH_REMOTE) {
      return deyeRemoteControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap });
    }
    return deyeControl({ selection, conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap });
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
    const writeFc = resolveDeyeWriteFc(conn);
    const reg = deyeFamilyControlReg(family);
    // REMOTE MODE release (report §7): trivial, because the inverter owns a native
    // dead-man's switch. Explicit hand-back = 1100 <- 0 (immediate); the failsafe of
    // LAST RESORT is simply to stop writing - the watchdog (1101) then expires and the
    // inverter leaves remote mode by itself with NOTHING changed. Because the remote
    // path touches no installer setting there is nothing to restore, so this release
    // deliberately ignores a ToU snapshot UNLESS one exists (a prior ToU session that
    // never handed back): then remote is disabled FIRST and the installer's captured
    // registers are restored after it.
    const remoteCap = (opts && opts.deye && typeof opts.deye === 'object') ? opts.deye : null;
    const remoteOff = conn.remote_mode === 'off' || conn.remote_mode === false;
    const remoteActive = !remoteOff && reg && deyeControlPath(remoteCap) === DEYE_PATH_REMOTE;
    if (remoteActive) {
      const snapshot = (opts && opts.snapshot && typeof opts.snapshot === 'object') ? opts.snapshot : null;
      const planned = [{
        role: 'remote_mode', fc: writeFc, addr: DEYE_REMOTE_REG.mode, value: DEYE_REMOTE_MODE.OFF,
        encode: { kind: 'remote_mode', enum: 'off', release: true },
        dwell_s: 0, min_change: 0, always: true, bench_pending: true,
      }];
      if (snapshot) {
        for (const s of deyeSnapshotSpec(reg, DEYE_CONTROL_SLOT)) {
          if (snapshot[s.addr] === undefined) continue;
          planned.push({
            role: s.role, fc: writeFc, addr: s.addr, value: snapshot[s.addr] & 0xffff,
            encode: { kind: 'restore', from: 'snapshot' },
            dwell_s: calibration ? 0 : 900, min_change: 0, always: true, bench_pending: true,
          });
        }
      }
      const rbs = planned.map((w) => ({ role: w.role, fc: 3, addr: w.addr, expect: w.value & 0xffff, tolerance: 0 }));
      return {
        adapter: 'solarman_v5', family, tier, certified, calibration, mode: 'release',
        controlPath: DEYE_PATH_REMOTE,
        target: ip + ':' + port, connection: { ip, port, serial, mb_slave_id: slaveId },
        writes: releaseAllowed ? planned : [], readbacks: releaseAllowed ? rbs : [],
        planned, capabilityProbe: deyeCapabilityProbeSpec(family),
        reason: releaseAllowed ? undefined : 'Steuerung für dieses Modell noch nicht freigegeben',
      };
    }
    // The captured pre-control snapshot (report §8). Deye has NO revert timer, so a
    // release must ACTIVELY hand back: writing only touEnable=0 would leave a changed
    // Energy-Pattern / Solar-Sell / export-limit LATCHED in EEPROM. When a snapshot is
    // present, restore every register we may have changed to its captured installer
    // value; touEnable (activation) is restored LAST so the inverter is never left
    // running our half-restored program. When NO snapshot exists (nothing was ever
    // changed) release stays as before: just DISABLE the Time-of-Use scheduler.
    const snapshot = (opts && opts.snapshot && typeof opts.snapshot === 'object') ? opts.snapshot : null;
    const restoreDwell = calibration ? 0 : 900;
    let planned = [];
    if (reg && snapshot) {
      const spec = deyeSnapshotSpec(reg, DEYE_CONTROL_SLOT);
      for (const s of spec) {
        if (snapshot[s.addr] === undefined) continue; // only restore what we captured
        planned.push({
          role: s.role, fc: writeFc, addr: s.addr, value: snapshot[s.addr] & 0xffff,
          encode: { kind: 'restore', from: 'snapshot' },
          dwell_s: restoreDwell, min_change: 0, bench_pending: true,
        });
      }
    }
    if (reg && planned.length === 0) {
      // No snapshot (or nothing captured): DISABLE the scheduler -> self-consumption.
      planned = [{
        role: 'tou_enable', fc: writeFc, addr: reg.touEnable, value: 0,
        encode: { kind: 'tou_mask', all_week: false, release: true },
        dwell_s: restoreDwell, min_change: 0, bench_pending: true,
      }];
    }
    const readbacks = planned.map((w) => ({ role: w.role, fc: 3, addr: w.addr, expect: w.value & 0xffff, tolerance: 0 }));
    return {
      adapter: 'solarman_v5', family, tier, certified, calibration, mode: 'release',
      controlPath: DEYE_PATH_TOU,
      target: ip + ':' + port, connection: { ip, port, serial, mb_slave_id: slaveId },
      writes: releaseAllowed ? planned : [], readbacks: releaseAllowed ? readbacks : [],
      planned, capabilityProbe: deyeCapabilityProbeSpec(family),
      reason: releaseAllowed ? undefined : 'Steuerung für dieses Modell noch nicht freigegeben',
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
// "Energy Pattern" 0x008D/0x00F3: Battery First(0) charges the battery from PV
// BEFORE serving load/export; Load First(1) does not. A DISCHARGE command sets
// Load First so a midday PV surplus stops preferentially charging the battery
// (the missing lever, report §1/§8); a CHARGE command sets Battery First.
const DEYE_ENERGY_PATTERN = { BATTERY_FIRST: 0, LOAD_FIRST: 1 };
// "Solar Sell" 0x0091/0x00F7: the export-surplus enable. A "discharge to grid"
// command has nowhere to put the energy but the battery unless an export path is
// enabled, so every working forced-discharge recipe sets this =1 (report §1/§3/§8).
const DEYE_SOLAR_SELL = { OFF: 0, ON: 1 };
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

// resolveDeyePowerScale - N1 fix (report §2.3/§9.A.1). The Program-Power AND
// Max-Sell-Power registers are scale [1,10] (LV = 1 -> W, HV = 10 -> decawatt).
// Before this the WRITE path only ever read the EXPLICIT `power_scale` config and
// silently fell back to 1 - so an HV SG01HP3 left on "Automatisch" was written 10x
// too LARGE (a commanded 1,5 kW discharge writes raw 1500, the inverter reads
// 15 000 W; the live plant exported 14,6 kW on a 0,3 kW command). Resolution order:
//
//   1. the operator's EXPLICIT power_scale (1 or 10)                -> confirmed
//   2. the DEVICE-DETECTED LV/HV class from the identity register    -> confirmed
//      0x0000 (the same auto-detect the READ path already does in
//      deye/deye-decode.js), probed by the executor and threaded in
//      via opts.deye.scaleClass - this is report §9.A.1 option (a)
//   3. nothing known -> scale 1 but confirmed:false. The adapter then REFUSES to
//      emit the plan at all (report §9.A.1 option (b)) - see deyeControl.
function resolveDeyePowerScale(conn, cap) {
  const v = Number(conn && conn.power_scale);
  if (v === 1 || v === 10) return { scale: v, confirmed: true, source: 'config' };
  const d = Number(cap && cap.scaleClass);
  if (d === 1 || d === 10) return { scale: d, confirmed: true, source: 'device' };
  return { scale: 1, confirmed: false, source: 'fallback' };
}

// --- Deye REMOTE MODE (registers 1100-1121) - the Tier-2 interface ------------
//
// Deye's MODBUS RTU protocol V105.1 (2023-10-06) added a "Customized register"
// block that IS a textbook external-EMS interface: mode enable, a native
// WATCHDOG, a control-mode selector and a SIGNED power setpoint in 0.1 % of rated
// power. It supersedes the Time-of-Use hack as the Deye control surface (scout
// report data/vp-deye-approach-w8 §3/§7/§9) and moves Deye into the same class as
// the Tier-2 vendors (Sungrow/Kostal/SMA/Huawei).
//
// PROVEN on the owner's SUN-30K-SG01HP3-EU (live read-only probe 2026-07-27,
// logger 192.168.254.210:8899, serial 1127365518, slave 1): FC03 of 0x044C..0x0461
// answered cleanly with 1100=0x0000, 1101=0xFFFF (the documented "watchdog off"
// default), 1104=0x0000, 1105=0x0002, 1121=0x0000 - i.e. remote mode is PRESENT
// and, per the §8.1 discriminator (1101 valid, 1104 in 0..2, 1105 in 0..5), the
// device uses the PR #978 layout, so the power setpoint is at 1109 (NOT the
// alternative V105.1 layout's 1111).
//
// WHY THIS IS BETTER THAN ToU (report §7), and what it changes for us:
//   - a TRUE signed watt setpoint (0,1 % of rated = ~30 W on a 30 kW unit),
//     bidirectional, instead of a direction permission + a coarse power CAP;
//   - RAM registers -> NO EEPROM wear, so we re-assert on the normal ~10 s tick
//     (the write IS the heartbeat) instead of a 900 s dwell;
//   - a NATIVE dead-man's switch (1101): on expiry the inverter leaves remote mode
//     BY ITSELF and everything reverts - so release is "stop writing", and the
//     ToU path's snapshot/restore is unnecessary HERE;
//   - it touches NO installer setting at all (no Energy-Pattern, no Solar-Sell, no
//     export limit, no ToU slot), so the foreign ToU program stops mattering.
//
// THE ONE THING IT DOES NOT GIVE US (report §7, claim 17 - REPORTED ONCE, treated
// as a hard requirement): a field report says the inverter's OWN min/max-SoC
// protections may NOT apply in remote mode. So `guards.Clamp`'s SoC band is
// SAFETY-CRITICAL here, not cosmetic: this adapter writes the ALREADY guard-clamped
// kW verbatim and never widens it, and it additionally arms strategy 5 (Power+SOC)
// with the SoC belt in 1108 as an independent ON-DEVICE second belt.
const DEYE_REMOTE_REG = {
  mode: 0x044c, // 1100 R/W 0 = disabled, 1..3 = remote mode 1..3
  watchdog: 0x044d, // 1101 R/W [10,18000] s, 0xFFFF = off (default)
  powerControlMode: 0x0450, // 1104 R/W 0 = AC-side, 1 = BATTERY-side, 2 = grid-side
  batteryStrategy: 0x0451, // 1105 R/W 0..5 (2 = Power, 5 = Power+SOC)
  constantSoc: 0x0454, // 1108 R/W 0..100 % - the on-device floor/ceiling for strategy 5
  constantPower: 0x0455, // 1109 R/W [-1200,1200] 0.1 % of rated, - = charge / + = discharge
  status: 0x0461, // 1121 R   bit-coded remote-control execution state (observation)
};
// The capability probe block: registers 1100..1121 in ONE FC03 read (22 regs, far
// under the 125-register limit). Reading an unimplemented block answers with a
// Modbus exception, which is the definitive "absent" verdict - harmless either way.
const DEYE_REMOTE_PROBE = { addr: 0x044c, count: 22 };
// The device-identity register the READ path already auto-detects the LV/HV power
// scale from (deye/deye-decode.js DEVICE_REG) - probed in the same pass for N1.
const DEYE_DEVICE_REG = 0x0000;
const DEYE_DEVICE_TYPES_LV = [0x0005, 0x0500]; // ha-solarman mod 0 -> scale 1
const DEYE_DEVICE_TYPES_HV = [0x0006, 0x0007, 0x0600, 0x0008, 0x0601]; // mod 1 -> scale 10

const DEYE_REMOTE_MODE = { OFF: 0, ON: 1 };
const DEYE_POWER_CONTROL_MODE = { AC_SIDE: 0, BATTERY_SIDE: 1, GRID_SIDE: 2 };
const DEYE_BATTERY_STRATEGY = {
  VOLTAGE: 0, CURRENT: 1, POWER: 2, SOC: 3, VOLT_CURRENT: 4, POWER_SOC: 5,
};
// 1109 is 0.1 % of rated power, range +/-1200 (= +/-120 % of nameplate).
const DEYE_REMOTE_SETPOINT_UNITS_PER_RATED = 1000;
const DEYE_REMOTE_SETPOINT_LIMIT = 1200;
// The dead-man's switch. 60 s is the wiki's recommendation and ~6 ticks of slack on
// the ~10 s setpoint republish; operators can tune it via connection.remote_watchdog_s.
const DEYE_REMOTE_WATCHDOG_DEFAULT_S = 60;
const DEYE_REMOTE_WATCHDOG_MIN_S = 10;
const DEYE_REMOTE_WATCHDOG_MAX_S = 18000;
const DEYE_REMOTE_WATCHDOG_OFF = 0xffff;

// The two Deye control PATHS. `remote` = the Tier-2 register block above;
// `tou` = the legacy Time-of-Use synthesis (the fallback when the firmware has no
// remote block). Surfaced on the plan + the readback so the operator always sees
// WHICH path is driving the inverter - we never write into the void silently.
const DEYE_PATH_REMOTE = 'remote';
const DEYE_PATH_TOU = 'tou';

/**
 * deyeCapabilityProbeSpec - what the executor must FC3-read to classify a Deye's
 * control capability. Battery-hybrid families only (string/micro have no battery
 * and no remote-mode use). Pure: it describes reads, it never performs them.
 */
function deyeCapabilityProbeSpec(family) {
  if (!deyeFamilyControlReg(family)) return null;
  return {
    reads: [
      { role: 'device_type', addr: DEYE_DEVICE_REG, count: 1 },
      { role: 'remote_block', addr: DEYE_REMOTE_PROBE.addr, count: DEYE_REMOTE_PROBE.count },
    ],
  };
}

/**
 * deyeCapabilityKey - the flow-context cache key for a probed capability, keyed by
 * the logger endpoint. Exported so the plan node and the executor cannot drift.
 */
function deyeCapabilityKey(ip, port) {
  const p = Number(port) > 0 ? Number(port) : 8899;
  return 'deye_cap:' + String(ip || '').trim() + ':' + p;
}

function inRange(v, lo, hi) {
  return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
}

// A plausible watchdog register: the documented "off" sentinel or a real timeout.
// An all-zero block (a logger answering an unimplemented range with zeros) fails
// this, which is exactly what keeps it from being misread as "remote mode present".
function plausibleWatchdog(v) {
  return v === DEYE_REMOTE_WATCHDOG_OFF
    || inRange(v, DEYE_REMOTE_WATCHDOG_MIN_S, DEYE_REMOTE_WATCHDOG_MAX_S);
}

/**
 * classifyDeyeCapability - the PURE classifier for a capability probe result
 * (report §8.1's interpretation table). Input:
 *
 *   { deviceType?: number|null,       // register 0x0000 (LV/HV scale class)
 *     remoteBlock?: number[]|null,    // registers 1100..1121, index i = 1100+i
 *     error?: string, definitive?: boolean }
 *
 * Returns { present, layout, supported, path, scaleClass, watchdogRaw, statusRaw,
 *           reason, definitive } where
 *   - layout 'pr978'   = the PR #978 / wiki layout: mode selector 1104, strategy
 *                        1105, SIGNED power setpoint 1109. This is what the owner's
 *                        SUN-30K-SG01HP3-EU answers, and the ONLY layout this
 *                        adapter writes.
 *   - layout 'v105_1'  = the older public-PDF layout (selector 1106, AC-output
 *                        setpoint 1111). Present but supported:false - its 1111 is
 *                        an AC-OUTPUT setpoint with no documented battery-side
 *                        selector, so its semantics do NOT match our
 *                        battery_setpoint_kw and AC-side control throttles PV
 *                        (report §7). We fall back to ToU rather than guess.
 *   - path             = the control path this capability selects ('remote'|'tou').
 */
function classifyDeyeCapability(probe) {
  const p = probe || {};
  const dev = Number(p.deviceType);
  let scaleClass = null;
  if (DEYE_DEVICE_TYPES_HV.indexOf(dev) !== -1) scaleClass = 10;
  else if (DEYE_DEVICE_TYPES_LV.indexOf(dev) !== -1) scaleClass = 1;

  const out = {
    present: false, layout: null, supported: false, path: DEYE_PATH_TOU,
    scaleClass, watchdogRaw: null, statusRaw: null,
    reason: '', definitive: p.definitive !== false,
  };
  const block = Array.isArray(p.remoteBlock) ? p.remoteBlock : null;
  if (!block || block.length < 22) {
    out.reason = p.error
      ? ('Remote-Mode-Register nicht lesbar: ' + p.error)
      : 'Remote-Mode-Register nicht lesbar (Firmware ohne Fernsteuerung) - Zeitfenster-Steuerung (ToU)';
    if (p.error) out.definitive = p.definitive === true;
    return out;
  }
  const at = (reg) => block[reg - 1100] & 0xffff;
  const mode = at(1100);
  const wd = at(1101);
  out.watchdogRaw = wd;
  out.statusRaw = at(1121);
  const modeOk = inRange(mode, 0, 3);
  const wdOk = plausibleWatchdog(wd);
  if (modeOk && wdOk && inRange(at(1104), 0, 2) && inRange(at(1105), 0, 5)) {
    out.present = true; out.layout = 'pr978'; out.supported = true; out.path = DEYE_PATH_REMOTE;
    out.reason = 'Fernsteuerung (Remote Mode) verfügbar';
    return out;
  }
  if (modeOk && wdOk && inRange(at(1106), 0, 1) && inRange(s16(at(1111)), -DEYE_REMOTE_SETPOINT_LIMIT, DEYE_REMOTE_SETPOINT_LIMIT)) {
    out.present = true; out.layout = 'v105_1'; out.supported = false;
    out.reason = 'Fernsteuerung in der älteren V105.1-Registerlage (AC-seitiger Sollwert 1111) - '
      + 'diese Variante steuert nicht batterieseitig und wird nicht geschrieben; Zeitfenster-Steuerung (ToU)';
    return out;
  }
  out.reason = 'Fernsteuerung auf dieser Firmware nicht vorhanden - Zeitfenster-Steuerung (ToU)';
  return out;
}

/**
 * deyeControlPath - which Deye control path a (possibly absent) capability selects.
 * No capability yet -> the legacy ToU path, so behaviour without a probe is
 * byte-identical to before this feature; the EXECUTOR is what refuses to write
 * until the probe has answered (never write into the void).
 */
function deyeControlPath(cap) {
  return cap && cap.present === true && cap.supported === true
    ? DEYE_PATH_REMOTE : DEYE_PATH_TOU;
}

/**
 * resolveDeyeRemoteWatchdog - the dead-man's timeout written to 1101. Operator
 * override connection.remote_watchdog_s, clamped to the documented [10, 18000] s;
 * anything else -> 60 s. NEVER 0xFFFF (watchdog off) from config: the whole point
 * of this path is that the inverter reverts on its own if we go silent.
 */
function resolveDeyeRemoteWatchdog(conn) {
  const v = Number(conn && conn.remote_watchdog_s);
  if (inRange(v, DEYE_REMOTE_WATCHDOG_MIN_S, DEYE_REMOTE_WATCHDOG_MAX_S)) return Math.round(v);
  return DEYE_REMOTE_WATCHDOG_DEFAULT_S;
}

/**
 * deyeRemoteSetpointUnits - the SIGN + SCALE conversion, the one place a slip
 * becomes a 10x command. Register 1109 is 0.1 % of RATED power with the Deye sign
 * convention `- = charge / + = discharge`, while OUR contract
 * (mqtt-schedule.schema.json) is `+ = charge / - = discharge` - so the register is
 * the NEGATED per-mille of rated:
 *
 *     units = -round(kw / ratedKw * 1000),  clamped to +/-1200
 *
 * ratedKw comes from the inverter CATALOG (inverter.Model.RatedKw), never a
 * hardcoded number. On a 30 kW unit 1 kW = 33 units (~30 W resolution).
 * Returns { units, raw (u16 two's complement), clamped, ok }.
 */
function deyeRemoteSetpointUnits(kw, ratedKw) {
  if (!isFiniteNum(kw) || !(Number(ratedKw) > 0)) {
    return { units: 0, raw: 0, clamped: false, ok: false };
  }
  const exact = -(kw / Number(ratedKw)) * DEYE_REMOTE_SETPOINT_UNITS_PER_RATED;
  // `|| 0` normalizes JS's negative zero (Math.round(-0.2) is -0), so an idle
  // command encodes as a plain 0 and never as a surprising -0 in the plan.
  let units = Math.round(exact) || 0;
  const clamped = units > DEYE_REMOTE_SETPOINT_LIMIT || units < -DEYE_REMOTE_SETPOINT_LIMIT;
  units = Math.max(-DEYE_REMOTE_SETPOINT_LIMIT, Math.min(DEYE_REMOTE_SETPOINT_LIMIT, units));
  return { units, raw: units & 0xffff, clamped, ok: true };
}

// s16 - two's-complement read of a raw 16-bit register (the readback twin of the
// `& 0xffff` encode above).
function s16(raw) {
  const v = raw & 0xffff;
  return v > 0x7fff ? v - 0x10000 : v;
}

// deyeSnapshotSpec - the ORDERED set of control registers deyeControl may write for
// a battery-hybrid family (report §8 snapshot/restore). Deye has NO revert timer, so
// anything we change persists in EEPROM until we change it back; the executor
// FC3-reads these BEFORE its first write to capture the installer's pre-control
// values, and controlRelease writes them back on hand-back. touEnable (activation)
// is LAST, so restore re-arms the installer's own ToU state only after every slot/
// config register is already back to its captured value. Returns [{ role, addr }].
function deyeSnapshotSpec(reg, slot) {
  const spec = [
    { role: 'energy_pattern', addr: reg.energyPattern },
    { role: 'work_mode', addr: reg.workMode },
    { role: 'max_sell_power', addr: reg.maxSellPower },
    { role: 'solar_sell', addr: reg.solarSell },
    { role: 'program_time', addr: reg.progTimeBase + slot },
    { role: 'battery_power', addr: reg.progPowerBase + slot },
    { role: 'battery_target_soc', addr: reg.progSocBase + slot },
    { role: 'grid_charge_enable', addr: reg.progChargeBase + slot },
  ];
  // On hybrid_3p exportLimit (0x00E7) is a SEPARATE register from maxSellPower
  // (0x008F); on hybrid_1p they are the SAME register (0x00F5, already listed), so
  // only add it once.
  if (reg.exportLimit !== reg.maxSellPower) {
    spec.push({ role: 'export_limit', addr: reg.exportLimit });
  }
  spec.push({ role: 'tou_enable', addr: reg.touEnable }); // activation - restore LAST
  return spec;
}

// deyeProgramTimeAddrs - the 6 ToU program start-time registers, for the N2 slot-
// time check (report §8.9): VoltPilot writes Program 1 = 00:00, but if the installer
// left Programs 2..6 with later start times, a DIFFERENT slot governs "now" and our
// Program-1 command is inert even though every register reads back. The executor
// reads these once (at snapshot time) and warns.
function deyeProgramTimeAddrs(reg) {
  const out = [];
  for (let i = 0; i < 6; i++) out.push(reg.progTimeBase + i);
  return out;
}

// deyeHhmmToMinutes - decode a Deye ToU program start time (decimal HHMM, e.g.
// 830 = 08:30) to minutes since midnight. 00:00 = 0 in both decimal-HHMM and BCD;
// the exact time encoding is firmware-dependent -> VERIFY-on-device (the N2 warning
// is advisory only, it never changes a write).
function deyeHhmmToMinutes(hhmm) {
  const v = Number(hhmm) || 0;
  return Math.floor(v / 100) * 60 + (v % 100);
}

// deyeProgram1Displaced - N2 detection (report §8.9): is VoltPilot's Program 1
// (start 00:00) NOT the governing slot at nowMinutes? True iff some LATER program
// (2..6, start strictly after Program 1's) has already started (start <= now), so
// the inverter is running a different slot and IGNORES our Program-1 command. All-
// zero / unset program times (the fresh state) never trip this.
function deyeProgram1Displaced(programTimes, nowMinutes) {
  if (!Array.isArray(programTimes) || programTimes.length < 2) return false;
  const p1 = deyeHhmmToMinutes(programTimes[0]);
  for (let i = 1; i < programTimes.length; i++) {
    const start = deyeHhmmToMinutes(programTimes[i]);
    if (start > p1 && start <= nowMinutes) return true;
  }
  return false;
}

/**
 * deyeRemoteControl - the Tier-2 REMOTE-MODE write plan: a true signed-watt
 * battery setpoint (registers 1100-1121, see the DEYE_REMOTE_REG header).
 *
 * THE WRITE ORDER IS LOAD-BEARING - the failsafe goes FIRST, activation LAST:
 *   1. 1101 <- watchdog seconds   arm the dead-man's switch BEFORE anything can move
 *   2. 1104 <- 1 (BATTERY-side)   battery-side leaves PV production untouched and is
 *                                 the mode whose semantics match battery_setpoint_kw;
 *                                 AC-/grid-side would throttle PV (report §7)
 *   3. 1105 <- 5 (Power+SOC) when a SoC belt is known, else 2 (Power)
 *   4. 1108 <- the SoC belt       an independent ON-DEVICE second belt (strategy 5)
 *   5. 1109 <- signed setpoint    derived from the ALREADY guard-clamped kW
 *   6. 1100 <- 1 (enable)         LAST, so the inverter never runs a half-written plan
 *
 * CADENCE: these are RAM registers, so every op carries dwell_s = 0, min_change = 0
 * AND `always: true` - the executor's EEPROM write-on-change discipline is BYPASSED
 * here on purpose. Re-asserting every ~10 s tick IS the watchdog kick (the intended
 * pattern), and without `always` an unchanged value would be skipped and the
 * watchdog would expire mid-operation.
 *
 * RELEASE is trivial on this path (controlRelease below): 1100 <- 0 hands control
 * back immediately, and simply STOPPING is the failsafe of last resort because the
 * inverter's own watchdog expires and it reverts by itself. NOTHING installer-level
 * is touched, so there is no snapshot to restore (`snapshotPlan` is deliberately
 * absent -> the executor never captures one on this path).
 *
 * NOT ON THIS PATH: pv_limit / curtailment. The Deye feed-in cap is an EEPROM
 * INSTALLER register (0x00E7 "Grid Max Export power"); writing it would break the
 * "touches no installer setting" property that makes this path safe. A curtailment
 * command is therefore reported as unsupported (pvLimitSupported:false), never
 * silently dropped and never silently written.
 */
function deyeRemoteControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
  const serial = conn.serial;
  const slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;
  const writeFc = resolveDeyeWriteFc(conn);
  // Sign stays CONFIGURATION, never code (same as every other adapter).
  const invert = conn.invert_control_sign === true;
  const battKw = invert ? -kw : kw;
  const ratedKw = Number(opts.ratedKw) > 0 ? Number(opts.ratedKw) : 0;
  const watchdogS = resolveDeyeRemoteWatchdog(conn);
  const writeAllowed = controlEnabled && (certified || calibration);

  const base = {
    adapter: 'solarman_v5', family, controlPath: DEYE_PATH_REMOTE,
    target: ip + ':' + port,
    connection: { ip, port, serial, mb_slave_id: slaveId },
    certified, controlEnabled, calibration: calibration === true,
    remote: {
      layout: (cap && cap.layout) || 'pr978',
      watchdog_s: watchdogS,
      rated_kw: ratedKw,
      status_addr: DEYE_REMOTE_REG.status,
    },
    // Curtailment is NOT part of the remote block (see the header).
    pvLimitSupported: false,
    pvLimitKw,
    capabilityProbe: deyeCapabilityProbeSpec(family),
  };

  // The nameplate is what turns kW into the 0.1 %-of-rated register. Without it we
  // CANNOT compute a setpoint - refuse rather than guess a rating (a wrong rating is
  // a scale error, i.e. exactly the N1 class of bug this PR also fixes).
  if (!(ratedKw > 0)) {
    return Object.assign(base, {
      writes: [], readbacks: [], planned: [],
      reason: 'Fernsteuerung: Nennleistung des Modells unbekannt - bitte das genaue '
        + 'Wechselrichter-Modell auswählen (der Sollwert ist 0,1 % der Nennleistung).',
    });
  }

  const sp = deyeRemoteSetpointUnits(battKw, ratedKw);
  // The SoC belt (report §7, claim 17): the inverter's own min/max-SoC protection may
  // NOT apply in remote mode, so guards.Clamp upstream owns the SoC band absolutely -
  // and we arm strategy 5 with 1108 as an INDEPENDENT on-device belt. Direction picks
  // which end of the band is the belt: a charge is bounded by the ceiling, a discharge
  // by the floor. Neither known -> plain Power strategy (2), no 1108 write.
  const charging = battKw > 0;
  const socMin = isFiniteNum(setpoint.soc_min_pct) ? clampPct(setpoint.soc_min_pct) : null;
  const socMax = isFiniteNum(setpoint.soc_max_pct) ? clampPct(setpoint.soc_max_pct) : null;
  const belt = charging ? socMax : socMin;
  const strategy = belt == null ? DEYE_BATTERY_STRATEGY.POWER : DEYE_BATTERY_STRATEGY.POWER_SOC;
  // RAM registers: no dwell, no min_change, and ALWAYS re-written (the write is the
  // watchdog kick - see the header). `always` is what makes the executor bypass its
  // EEPROM write-on-change filter for this path only.
  const ram = { dwell_s: 0, min_change: 0, always: true, bench_pending: true };

  const planned = [];
  // 1) FAILSAFE FIRST.
  planned.push({
    role: 'remote_watchdog', fc: writeFc, addr: DEYE_REMOTE_REG.watchdog, value: watchdogS & 0xffff,
    encode: { kind: 'remote_watchdog_s', seconds: watchdogS }, ...ram,
  });
  // 2) BATTERY-side control (PV production keeps running untouched).
  planned.push({
    role: 'power_control_mode', fc: writeFc, addr: DEYE_REMOTE_REG.powerControlMode,
    value: DEYE_POWER_CONTROL_MODE.BATTERY_SIDE,
    encode: { kind: 'remote_power_control_mode', enum: 'battery_side' }, ...ram,
  });
  // 3) strategy: Power+SOC when a belt exists, else Power.
  planned.push({
    role: 'battery_strategy', fc: writeFc, addr: DEYE_REMOTE_REG.batteryStrategy, value: strategy,
    encode: { kind: 'remote_battery_strategy', enum: strategy === DEYE_BATTERY_STRATEGY.POWER_SOC ? 'power_soc' : 'power' }, ...ram,
  });
  // 4) the on-device SoC belt (strategy 5 only).
  if (belt != null) {
    planned.push({
      role: 'battery_soc_belt', fc: writeFc, addr: DEYE_REMOTE_REG.constantSoc, value: belt,
      encode: { kind: 'pct', direction: charging ? 'charge_ceiling' : 'discharge_floor' }, ...ram,
    });
  }
  // 5) the signed setpoint (0.1 % of rated; - = charge / + = discharge).
  planned.push({
    role: 'battery_power', fc: writeFc, addr: DEYE_REMOTE_REG.constantPower, value: sp.raw,
    encode: {
      kind: 'remote_power_permille', rated_kw: ratedKw, kw: battKw,
      units: sp.units, limit: DEYE_REMOTE_SETPOINT_LIMIT, clamped: sp.clamped,
    }, ...ram,
  });
  // 6) ACTIVATION - strictly LAST.
  planned.push({
    role: 'remote_mode', fc: writeFc, addr: DEYE_REMOTE_REG.mode, value: DEYE_REMOTE_MODE.ON,
    encode: { kind: 'remote_mode', enum: 'on' }, ...ram,
  });

  // Readbacks: the setpoint echo (1109, decoded back to kW so the :8484 card and the
  // First-Light verdict see real numbers), the mode (1100) and every other commanded
  // register. 1121 (remote control STATUS) is read-only - it is not a commanded value,
  // so it rides `observations` and can never fabricate a commanded-vs-actual match.
  const rbTol = (role) => (role === 'battery_power' ? 1 : 0);
  const readbacks = planned.map((w) => {
    const rb = { role: w.role, fc: 3, addr: w.addr, expect: w.value & 0xffff, tolerance: rbTol(w.role) };
    if (w.role === 'battery_power') rb.decode = { kind: 'remote_power_permille', rated_kw: ratedKw };
    return rb;
  });
  const observations = [{ role: 'remote_status', fc: 3, addr: DEYE_REMOTE_REG.status }];

  const execWrites = planned.map((w) => { const c = { ...w }; delete c.bench_pending; return c; });
  const out = Object.assign(base, {
    writes: writeAllowed ? execWrites : [],
    readbacks: writeAllowed ? readbacks : [],
    planned,
    observations,
    setpointUnits: sp.units,
    setpointClamped: sp.clamped,
  });
  if (pvLimitKw != null) {
    // Honest, never silent: a curtailment command cannot be served on this path.
    // Its own field, so it is never swallowed by (or swallowing) a gate reason.
    out.pvLimitNote = 'Fernsteuerung: PV-Begrenzung wird auf diesem Pfad nicht geschrieben '
      + '(sie wäre eine Installateur-Einstellung im EEPROM).';
  }
  if (!writeAllowed) {
    out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)'
      : 'Fernsteuerung erkannt, Steuerung für dieses Modell noch nicht freigegeben';
  } else if (out.pvLimitNote) {
    out.reason = out.pvLimitNote;
  }
  return out;
}

// deyeControl - the CORRECTED battery-power -> live ToU slot translation (report
// §8). Strategy A (target-SoC = floor + power cap + grid-charge off) is CORRECT for
// CHARGE but fundamentally INCOMPLETE for DISCHARGE: on a Deye the ToU target-SoC is
// a discharge FLOOR (a permission), not a discharge command, and Export/Selling-First
// charges the battery from surplus BEFORE exporting - so a "discharge to floor"
// program does not FORCE a discharge, it permits one while the inverter charges
// instead (the live +12 kW symptom). To actually push power OUT you must ALSO enable
// Solar Sell, set Energy-Pattern to Load-First, and set the export/sell-power limit
// (the gentle "6b" forcing lever the owner chose; the heavier "6a" max-charge-current
// clamp 0x006C is DELIBERATELY NOT wired here). See DEYE.md + CONTROL-BENCH.md; every
// new lever stays bench_pending until the family is certified.
function deyeControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
  const serial = conn.serial;
  const slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;
  const invert = conn.invert_control_sign === true;
  const socMin = isFiniteNum(setpoint.soc_min_pct) ? setpoint.soc_min_pct : 5;
  // N1 fix (report §2.3/§9.A.1): the EXPLICIT power_scale, else the DEVICE-DETECTED
  // LV/HV class from the capability probe; confirmed=false when neither is known -
  // and then the plan is REFUSED outright below (never a silent 10x write).
  const ps = resolveDeyePowerScale(conn, cap);
  const powerScale = ps.scale;
  // The Modbus WRITE function code (FC16 default, FC6 flip-back) - see the
  // resolveDeyeWriteFc header. ONLY the wire function changes; the register map,
  // values, ordering and EEPROM write-on-change discipline are untouched.
  const writeFc = resolveDeyeWriteFc(conn);
  // The captured pre-control snapshot the executor FC3-read before its first write
  // (report §8) - a plain map addr->raw, threaded back so the CHARGE plan can RESTORE
  // maxSellPower to the installer's pre-control value. Absent on the first tick.
  const snapshot = (opts && opts.snapshot && typeof opts.snapshot === 'object') ? opts.snapshot : null;
  const snapVal = (addr) => (snapshot && snapshot[addr] !== undefined ? snapshot[addr] & 0xffff : undefined);

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
  // Readback tolerance: the power registers are decawatt/watt-scaled so allow ±1 raw
  // unit; the enum/flag registers must match exactly.
  const deyeRbTol = (role) => (role === 'battery_power' || role === 'pv_limit' || role === 'max_sell_power' ? 1 : 0);
  const finalize = (planned, extra) => {
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
      adapter: 'solarman_v5', family, controlPath: DEYE_PATH_TOU,
      target: ip + ':' + port,
      connection: { ip, port, serial, mb_slave_id: slaveId },
      certified, controlEnabled, calibration: calibration === true,
      writes: writeAllowed ? execWrites : [],
      readbacks: writeAllowed ? readbacks : [],
      planned,
      // What the executor must FC3-read to classify this device's control
      // capability (remote mode present? LV/HV scale class?). Null for a
      // batteryless family. Reads only - always safe, never a write.
      capabilityProbe: deyeCapabilityProbeSpec(family),
    };
    if (extra) Object.assign(out, extra);
    // A reason supplied by the caller (today: the N1 scale refusal) is MORE specific
    // than the generic gate message and explains an EMPTY plan, so it wins.
    if (!writeAllowed && !out.reason) {
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
        role: 'pv_limit', fc: writeFc, addr: deyeDecode.POWER_LIMIT_REG,
        value: clampPct((pvLimitKw / ratedKw) * 100),
        encode: { kind: 'active_power_pct', rated_kw: ratedKw, kw: pvLimitKw },
        dwell_s: 900, min_change: 1, bench_pending: true,
      });
    }
    return finalize(planned);
  }

  // N1 (report §2.3/§9.A.1) - REFUSE, never guess. On a battery hybrid the whole ToU
  // plan is power-scaled: Program-Power and (on hybrid_3p) Max-Sell-Power are
  // scale [1,10]. With the scale UNKNOWN an HV inverter is written 10x too large -
  // and the failure mode is not a small error: enabling ToU + Export-First +
  // Solar-Sell with a 10x export ceiling is exactly what emptied the live battery
  // into the grid at 14,6 kW on a 0,3 kW command. Emitting the plan WITHOUT the
  // power ops would be just as dangerous (ToU armed against the installer's own,
  // possibly huge, sell-power ceiling), so the ENTIRE plan is withheld until the
  // scale is known - from the operator's power_scale or from the device probe.
  if (!ps.confirmed) {
    return finalize([], {
      powerScaleConfirmed: false,
      powerScaleSource: ps.source,
      powerScaleSuppressed: true,
      reason: 'Leistungsskalierung unbestätigt (HV/LV): Der Schreibplan wird zurückgehalten, '
        + 'damit ein HV-Wechselrichter nicht 10-fach überschrieben wird. Bitte die '
        + 'Leistungsskalierung am Wechselrichter setzen (HV = 10, LV = 1) oder das Gerät '
        + 'erreichbar machen, damit sie automatisch erkannt wird.',
    });
  }

  const slot = DEYE_CONTROL_SLOT;
  const battKw = invert ? -kw : kw;
  const charging = battKw > 0;
  const watts = Math.abs(battKw) * 1000;
  // Program Power is the slot's charge/discharge power cap (W / power_scale, N1 fix).
  const powerReg = Math.max(0, Math.round(watts / powerScale)) & 0xffff;
  // Direction is PERMITTED by the slot's target SoC (charge -> full, discharge ->
  // the operating floor) - a permission, NOT a command (report §1); the levers below
  // are what actually force export.
  const targetSoc = charging ? 100 : clampPct(socMin);
  // Grid-charge is EEG-gated: the slot's "Program N Charging" is only ever set to
  // Grid when the site explicitly permits grid charging (netzladen_erlaubt) AND
  // the slot is charging. Default = Disabled (an EEG plant must never grid-charge;
  // the optimizer already refuses it - this is the on-device belt-and-braces).
  const gridChargeAllowed = setpoint.grid_charge_allowed === true;
  const chargeEnum = gridChargeAllowed && charging
    ? DEYE_PROG_CHARGE.GRID : DEYE_PROG_CHARGE.DISABLED;
  // The 6b export/sell-power lever: its register is scale [1,10] on hybrid_3p (0x008F,
  // via power_scale) but a fixed scale-1 W register on hybrid_1p (0x00F5, where it IS
  // the exportLimit register); pick the scale per family so the magnitude is right.
  const maxSellScale = (reg.maxSellPower === reg.exportLimit) ? reg.exportLimitScale : powerScale;

  // The write plan, in the report §8 order: config/EEPROM levers first, the slot, and
  // ACTIVATION (touEnable) strictly LAST - so the inverter never runs a half-written
  // program (the reorder is itself a correctness fix; the old plan enabled ToU second).
  const cfg = { dwell_s: 900, min_change: 0, bench_pending: true };
  const planned = [];
  // 1) Energy-Pattern: discharge -> Load First (stop prioritising battery charge from
  //    PV, the missing lever); charge -> Battery First (prioritise charging).
  planned.push({
    role: 'energy_pattern', fc: writeFc, addr: reg.energyPattern,
    value: charging ? DEYE_ENERGY_PATTERN.BATTERY_FIRST : DEYE_ENERGY_PATTERN.LOAD_FIRST,
    encode: { kind: 'energy_pattern', enum: charging ? 'battery_first' : 'load_first' }, ...cfg,
  });
  // 2) Work-Mode: Export/Selling First (permit export).
  planned.push({
    role: 'work_mode', fc: writeFc, addr: reg.workMode, value: DEYE_WORK_MODE.EXPORT_FIRST,
    encode: { kind: 'work_mode', enum: 'export_first' }, ...cfg,
  });
  // 3) Solar-Sell: ON for a DISCHARGE (enable surplus/battery export - without an
  //    export path a "discharge to grid" has nowhere to go but the battery). A CHARGE
  //    leaves it to the snapshot restore, so we never latch export-on for a charge.
  if (!charging) {
    planned.push({
      role: 'solar_sell', fc: writeFc, addr: reg.solarSell, value: DEYE_SOLAR_SELL.ON,
      encode: { kind: 'flag', enum: 'solar_sell_on' }, ...cfg,
    });
  }
  // 4) Program 1 start 00:00 = the day's BASE window (report §6), so the commanded
  //    slot governs "now". We only ever write OUR slot's own time, never Programs 2..6.
  planned.push({
    role: 'program_time', fc: writeFc, addr: reg.progTimeBase + slot, value: DEYE_PROGRAM_TIME_BASE_HHMM,
    encode: { kind: 'program_time_hhmm', hhmm: DEYE_PROGRAM_TIME_BASE_HHMM }, ...cfg,
  });
  // 5) Program 1 Charging enum (grid-charge, EEG-gated).
  planned.push({
    role: 'grid_charge_enable', fc: writeFc, addr: reg.progChargeBase + slot, value: chargeEnum,
    encode: { kind: 'charge_enum', eeg_gated: true, disabled: DEYE_PROG_CHARGE.DISABLED, grid: DEYE_PROG_CHARGE.GRID }, ...cfg,
  });
  // 6) Program 1 target SoC (the discharge floor / charge ceiling - the permission).
  planned.push({
    role: 'battery_target_soc', fc: writeFc, addr: reg.progSocBase + slot, value: targetSoc,
    encode: { kind: 'pct', direction: charging ? 'charge' : 'discharge' }, dwell_s: 900, min_change: 1, bench_pending: true,
  });
  // 7) Max-Sell-Power (the 6b forcing lever). DISCHARGE -> the export/sell-power limit
  //    = X so the battery actually exports at the commanded rate. CHARGE -> RESTORE it
  //    to the installer's pre-control value from the snapshot, so an earlier
  //    discharge's export cap never latches. No snapshot yet (the very first tick) ->
  //    omit; the executor snapshots BEFORE writing, so the next tick restores.
  if (!charging) {
    planned.push({
      role: 'max_sell_power', fc: writeFc, addr: reg.maxSellPower,
      value: Math.max(0, Math.round(watts / maxSellScale)) & 0xffff,
      encode: { kind: 'watt_scaled_u16', scale: maxSellScale, kw: battKw, lever: 'force_discharge' },
      dwell_s: 900, min_change: 50, bench_pending: true,
    });
  } else if (snapVal(reg.maxSellPower) !== undefined) {
    planned.push({
      role: 'max_sell_power', fc: writeFc, addr: reg.maxSellPower, value: snapVal(reg.maxSellPower),
      encode: { kind: 'restore', from: 'snapshot' }, dwell_s: 900, min_change: 0, bench_pending: true,
    });
  }
  // 8) Program 1 Power = the slot's charge/discharge power cap (N1-scaled).
  planned.push({
    role: 'battery_power', fc: writeFc, addr: reg.progPowerBase + slot, value: powerReg,
    encode: { kind: 'watt_scaled_u16', scale: powerScale, kw: battKw }, dwell_s: 900, min_change: 50, bench_pending: true,
  });
  // pv_limit -> the family's feed-in cap register, in W / register-scale. Absent (no
  // curtailment) -> no write (contract: absent = no limit). On hybrid_1p this IS the
  // maxSellPower register (0x00F5); dedup to the TIGHTER cap so one addr is never
  // written twice (on hybrid_3p 0x00E7 != 0x008F, so no clash).
  if (pvLimitKw != null) {
    const capRaw = Math.round(Math.max(0, pvLimitKw * 1000) / reg.exportLimitScale) & 0xffff;
    const clash = planned.find((w) => w.addr === reg.exportLimit);
    if (clash) {
      clash.value = Math.min(clash.value & 0xffff, capRaw) & 0xffff;
      clash.encode = { ...clash.encode, feed_in_cap_kw: pvLimitKw };
    } else {
      planned.push({
        role: 'pv_limit', fc: writeFc, addr: reg.exportLimit, value: capRaw,
        encode: { kind: 'feed_in_cap_w', scale: reg.exportLimitScale, kw: pvLimitKw },
        dwell_s: 900, min_change: 1, bench_pending: true,
      });
    }
  }
  // 9) ACTIVATION: enable the ToU scheduler (all weekdays) - STRICTLY LAST.
  planned.push({
    role: 'tou_enable', fc: writeFc, addr: reg.touEnable, value: DEYE_TOU_ENABLED_ALL_WEEK,
    encode: { kind: 'tou_mask', all_week: true }, ...cfg,
  });

  return finalize(planned, {
    powerScaleConfirmed: ps.confirmed,
    // The executor uses these to (a) FC3-snapshot the installer's pre-control values
    // before the first write, and (b) N2-check whether Program 1 governs "now".
    snapshotPlan: { registers: deyeSnapshotSpec(reg, slot), programTimes: deyeProgramTimeAddrs(reg) },
  });
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
  DEYE_ENERGY_PATTERN,
  DEYE_SOLAR_SELL,
  DEYE_PROG_CHARGE,
  DEYE_TOU_ENABLED_ALL_WEEK,
  DEYE_CONTROL_SLOT,
  CERTIFIED_CONTROL_FAMILIES,
  SETPOINT_STALE_MS,
  DEYE_WRITE_FC_FC16,
  DEYE_WRITE_FC_FC6,
  // Deye remote mode (Tier 2, registers 1100-1121)
  DEYE_REMOTE_REG,
  DEYE_REMOTE_PROBE,
  DEYE_REMOTE_MODE,
  DEYE_POWER_CONTROL_MODE,
  DEYE_BATTERY_STRATEGY,
  DEYE_REMOTE_SETPOINT_LIMIT,
  DEYE_REMOTE_WATCHDOG_DEFAULT_S,
  DEYE_REMOTE_WATCHDOG_OFF,
  DEYE_PATH_REMOTE,
  DEYE_PATH_TOU,
  deyeCapabilityProbeSpec,
  deyeCapabilityKey,
  classifyDeyeCapability,
  deyeControlPath,
  resolveDeyeRemoteWatchdog,
  deyeRemoteSetpointUnits,
  resolveDeyeWriteFc,
  resolveDeyePowerScale,
  deyeSnapshotSpec,
  deyeProgramTimeAddrs,
  deyeHhmmToMinutes,
  deyeProgram1Displaced,
  resolveControlTier,
  controlRoute,
  controlRelease,
  setpointStale,
  dualControllerSignal,
};
