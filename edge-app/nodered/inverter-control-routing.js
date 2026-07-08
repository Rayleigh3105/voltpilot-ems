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
 *   - Control is OFF by default. `setpoint.control_enabled` is the CORE's
 *     kill-switch (VP_CONTROL_ENABLED, default false) AND its per-model
 *     certification verdict, folded into one boolean the core publishes on
 *     edge/setpoint. When it is false, `writes` is EMPTY - the readbacks still
 *     run so the UI shows the inverter's ACTUAL state, but nothing is written.
 *   - A second, independent gate lives HERE: only families in
 *     CERTIFIED_CONTROL_FAMILIES may ever emit executable writes. An uncertified
 *     family (every Deye family until its model is bench-verified) returns
 *     writes:[] REGARDLESS of control_enabled, so a triangulated-but-unproven
 *     register address can never be written live. Its intended mapping is
 *     surfaced as `planned` (display/tests only, never executed) so the bench
 *     session has something concrete to verify.
 *   - Signs are configuration, never code: `connection.invert_control_sign`
 *     flips the battery-power write direction if the bench shows it inverted.
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

const COMM_SOLARMAN = 'solarman_v5';
const COMM_MODBUS = 'modbus_tcp';

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
  const family = typeof selection.family === 'string' ? selection.family.trim() : '';
  const certified = CERTIFIED_CONTROL_FAMILIES.has(family);
  const kw = setpoint.battery_setpoint_kw;
  const pvLimitKw = isFiniteNum(setpoint.pv_limit_kw) && setpoint.pv_limit_kw >= 0
    ? setpoint.pv_limit_kw : null;

  if (selection.communication === COMM_MODBUS) {
    return sunspecControl({ selection, conn, ip, family, certified, controlEnabled, kw, pvLimitKw });
  }
  if (selection.communication === COMM_SOLARMAN) {
    return deyeControl({ selection, conn, ip, family, certified, controlEnabled, kw, pvLimitKw, setpoint, opts });
  }
  return idle('unbekannte Kommunikationsmethode');
}

// --- generic_modbus / SunSpec control adapter (CERTIFIED, proven vs sim) ------

function sunspecControl({ selection, conn, ip, family, certified, controlEnabled, kw, pvLimitKw }) {
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

  const writeAllowed = certified && controlEnabled;
  const out = {
    adapter: 'modbus_tcp', family, profile: family,
    target: ip + ':' + port,
    connection: { ip, port, unit_id: unitId },
    certified, controlEnabled,
    writes: writeAllowed ? planned : [],
    readbacks,
    planned,
  };
  if (!writeAllowed) {
    out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Modell noch nicht freigegeben';
  }
  return out;
}

// --- deye / hybrid control adapter (UNCERTIFIED - read-only until bench) ------
//
// The battery-power -> live ToU slot translation (report §3.3 strategy A). The
// addresses are triangulated from DEYE.md and are BENCH-PENDING, so this adapter
// NEVER emits executable writes (writes:[]). The `planned` list carries the
// intended ToU mapping for the :8484 display and the unit tests - it is the
// concrete artefact the bench session verifies, not a live command.

// Deye hybrid ToU / work-mode control registers (DEYE.md §"Ausgeklammert",
// triangulated from deye-controller / sunsynk / ha-solarman - VERIFY PER MODEL
// on the bench before certifying). Same base map for hybrid_1p and hybrid_3p
// (the high map); hybrid_1p addresses are analogous and equally bench-gated.
const DEYE_CONTROL_REG = {
  WORK_MODE: 0x0f01, // System Work Mode / energy pattern (Self-use / ToU ...)
  TOU_ENABLE: 0x0f02, // ToU enable + weekday mask (bitmask)
  SLOT_POWER: 0x0f3d, // ToU slot power (W), per slot
  SLOT_TARGET_SOC: 0x0f44, // ToU slot target SoC (%), per slot
  SLOT_GRID_CHARGE: 0x0f4b, // ToU slot grid-charge enable bit, per slot
  EXPORT_LIMIT: deyeDecode.POWER_LIMIT_REG, // 0x0028 active-power/export limit (%)
};
const WORK_MODE_TOU = 1; // "Time-of-Use" work-mode selector value (bench-verify)

function deyeControl({ conn, ip, family, certified, controlEnabled, kw, pvLimitKw, setpoint, opts }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
  const serial = conn.serial;
  const slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;
  const invert = conn.invert_control_sign === true;
  const socMin = isFiniteNum(setpoint.soc_min_pct) ? setpoint.soc_min_pct : 5;

  const battKw = invert ? -kw : kw;
  const charging = battKw > 0;
  const powerW = Math.round(Math.abs(battKw) * 1000);
  // Direction is encoded by target SoC vs. current SoC (strategy A): charge ->
  // full, discharge -> the operating floor.
  const targetSoc = charging ? 100 : clampPct(socMin);
  // Grid-charge is EEG-gated: only ever enabled when the site explicitly permits
  // grid charging (netzladen_erlaubt) AND the slot is charging. Default false =
  // EEG-compliant (an EEG plant must never grid-charge). The optimizer already
  // refuses grid-charging for EEG sites; this is the belt-and-braces on-device.
  const gridChargeAllowed = setpoint.grid_charge_allowed === true;
  const gridChargeBit = gridChargeAllowed && charging ? 1 : 0;

  // pv_limit -> export-limit % of rated (report §3.3 B). No limit -> 100 %.
  const ratedKw = Number(opts.ratedKw) > 0 ? Number(opts.ratedKw) : 0;
  const exportPct = pvLimitKw == null || ratedKw <= 0
    ? 100 : clampPct((pvLimitKw / ratedKw) * 100);

  const planned = [
    {
      role: 'work_mode', fc: 6, addr: DEYE_CONTROL_REG.WORK_MODE, value: WORK_MODE_TOU,
      encode: { kind: 'work_mode', mode: 'tou' }, dwell_s: 900, min_change: 0, bench_pending: true,
    },
    {
      role: 'battery_power', fc: 6, addr: DEYE_CONTROL_REG.SLOT_POWER, value: powerW & 0xffff,
      encode: { kind: 'watt_u16', kw: battKw }, dwell_s: 900, min_change: 50, bench_pending: true,
    },
    {
      role: 'battery_target_soc', fc: 6, addr: DEYE_CONTROL_REG.SLOT_TARGET_SOC, value: targetSoc,
      encode: { kind: 'pct', direction: charging ? 'charge' : 'discharge' },
      dwell_s: 900, min_change: 1, bench_pending: true,
    },
    {
      role: 'grid_charge_enable', fc: 6, addr: DEYE_CONTROL_REG.SLOT_GRID_CHARGE, value: gridChargeBit,
      encode: { kind: 'flag', eeg_gated: true }, dwell_s: 900, min_change: 0, bench_pending: true,
    },
    {
      role: 'pv_limit', fc: 6, addr: DEYE_CONTROL_REG.EXPORT_LIMIT, value: exportPct,
      encode: { kind: 'export_pct', rated_kw: ratedKw, kw: pvLimitKw }, dwell_s: 900, min_change: 1,
      bench_pending: true,
    },
  ];

  return {
    adapter: 'solarman_v5', family,
    target: ip + ':' + port,
    connection: { ip, port, serial, mb_slave_id: slaveId },
    certified, // false for all Deye families until bench-certified
    controlEnabled,
    // Read-only until certified: NEVER emit executable writes for a bench-pending
    // address, and do not pretend to confirm control registers we cannot trust.
    writes: [],
    readbacks: [],
    planned,
    reason: 'Steuerung für dieses Modell noch nicht freigegeben',
  };
}

module.exports = {
  COMM_SOLARMAN,
  COMM_MODBUS,
  SUNSPEC_REG,
  NO_PV_LIMIT,
  DEYE_CONTROL_REG,
  WORK_MODE_TOU,
  CERTIFIED_CONTROL_FAMILIES,
  controlRoute,
};
