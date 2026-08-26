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
 *   - A second, independent gate lives HERE, and it has TWO halves. FLEET-WIDE:
 *     families in CERTIFIED_CONTROL_FAMILIES (bench-verified for every device of
 *     that model class). PER-DEVICE: the runtime First-Light grant the core carries
 *     on the setpoint as `device_certified` (see deviceGrant). A family that is in
 *     NEITHER (an unproven Deye) returns writes:[] REGARDLESS of control_enabled, so
 *     a triangulated-but-unproven register address can never be written live; its
 *     intended mapping is surfaced as `planned` (display/tests only, never executed)
 *     so the bench session has something concrete to verify. The per-device half is
 *     what lets an operator's PROVEN release actually drive the Fahrplan without
 *     widening the fleet allowlist by one byte.
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
const unplannedNative = require('./unplanned-load-native');
// The firmware CONDITION the Deye pilot certificate is keyed on - imported, never
// re-spelled here, so adapter and certificate can never disagree about the key.
const DEYE_REMOTE_PR978_FIRMWARE = unplannedNative.DEYE_REMOTE_PR978_FIRMWARE;

const COMM_SOLARMAN = 'solarman_v5';
const COMM_MODBUS = 'modbus_tcp';
const COMM_FRONIUS = 'fronius_solar_api';
// KOSTAL PLENTICORE BI: the vendor's own Modbus-TCP server (TCP 1502, Unit-ID
// 71) - the first REALIZED Tier-2 (vendor external-EMS) control surface. See
// kostalControl below + the scout report data/vp-kostal-plenticore-s5.
const COMM_KOSTAL = 'kostal_modbus';
// KACO: die drei Wege der Marke. `sunspec_tcp` ist die brand-neutrale Kennung
// desselben SunSpec-Modbus-Pfads, den Fronius unter `fronius_sunspec` faehrt -
// hier fuehrt sie zur Wirkleistungsbegrenzung ueber Model 123. `kaco_modbus`
// ist die AISWEI-Registerkarte des hybriden NH3 (Batterie-Sollwert),
// `kaco_http` die App-Schnittstelle - dort gibt es keinen Steuerweg.
// ALLE DREI sind VORBEREITET und GESPERRT (siehe die KACO-Adapter unten).
const COMM_SUNSPEC_TCP = 'sunspec_tcp';
const COMM_KACO_MODBUS = 'kaco_modbus';
const COMM_KACO_HTTP = 'kaco_http';

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
//
// This is the FLEET-WIDE half of the certification gate. It is deliberately NOT
// "repaired" by adding a family an operator released on one device - see
// deviceGrant() below for the per-device half.
const CERTIFIED_CONTROL_FAMILIES = new Set(['sunspec']);

/**
 * deviceGrant - the PER-DEVICE half of the certification gate: the runtime
 * First-Light grant the CORE carries on edge/setpoint as `device_certified`.
 *
 * WHY THIS EXISTS. First-Light (the guided, bounded, evidence-gated first real
 * write, internal/calibration + agent/calibration.go) lets an operator PROVE a
 * battery inverter's sign + scale on real hardware and then release control for
 * THAT device - a grant the core persists and merges into
 * Agent.controlCertified(family). The executor's own gate, however, only ever
 * consulted the STATIC allowlist above, which cannot know a runtime grant. So on
 * a released pilot (family hybrid_3p) the Fahrplan path computed
 * `writeAllowed = true && (false || false)` and emitted writes:[] forever, while
 * the calibration bypass - the one path that skips the family allowlist - kept
 * working. The proven grant could not reach the component that writes, which made
 * the whole First-Light mechanism inert for real operation.
 *
 * SCOPE OF THIS GATE - what it does NOT do:
 *   - it does NOT widen the fleet: a device without a grant carries
 *     `device_certified` false/absent and behaves byte-for-byte as before;
 *   - it does NOT bypass the kill-switch: `controlEnabled` stays the outer AND in
 *     every adapter (structure: controlEnabled && (allowlist || grant || calibration));
 *   - it does NOT change how a grant is EARNED - the evidence gate still demands a
 *     readback-confirmed test with observed movement inside the confirm window;
 *   - it does NOT touch guards.Clamp, the SoC band, the magnitude caps, the remote
 *     watchdog (1101) or the write ORDER. The core clamps first and the adapter may
 *     only ever narrow.
 *
 * The core computes this as `Agent.controlCertified(family)` = the env allowlist
 * MERGED with the persisted grant, i.e. exactly what `:8484` renders and what the
 * cloud heartbeat reports - so the executor now agrees with the core by construction
 * instead of diverging by design (see agent.logControlGateDivergence).
 */
function deviceGrant(setpoint) {
  return !!setpoint && setpoint.device_certified === true;
}

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
    case COMM_KOSTAL: return CONTROL_TIER.VENDOR_EMS;
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

// --- the one-shot INSTALLER/REGISTER write over the Solarman lane -----------
//
// „Grid Max Export power" (dec. 231) was the ONE register this path started
// with: the inverter's OWN feed-in cap, the value an installer normally only
// reaches through the device's installer menu ON SITE. At Anlage Herzogau the
// Deye held 33,0 kW there while 70 kW were registered, and raising it meant an
// appointment.
//
// ⚠ SINCE STUFE 2 („Freie Register") THE ADDRESS ALLOWLIST IS GONE - announced,
// not undermined: the previous PR wrote that a further register „is a code
// change with its own review", and this is that change. What replaces it are
// LANE rules, and they are the ones this planner can actually judge:
//
//   - the device must be read over the SOLARMAN logger (this is that lane; a
//     component on plain Modbus-TCP has its own executor),
//   - a connection with an IP must exist,
//   - address and value must be register words (0..65535).
//
// ⚠ WHAT IS NOT GIVEN UP, and where it lives: the SELF-CONFLICT lock in the core
// (internal/registerwrite.ControlOwns) refuses exactly the registers the RUNNING
// control loop commands - on hybrid_1p that is the feed-in cap „Max Sell Power"
// (0x00F5), which our own discharge lever writes. That rule is stated where it
// can be judged against the LIVE readback, instead of as a static family table
// that would also refuse an installer write while nothing is controlling at all.
// The two-stage confirm, the value ceiling of the local button, the preview
// duty, the rate limit, the one-shot rule and the journal are all unchanged.
//
// ⚠ FC16, not FC6, for the same measured reason as every other Deye control
// write: many Deye firmwares behind the Solarman logger ACCEPT an FC6 frame and
// never apply it (see resolveDeyeWriteFc). `connection.control_write_fc: 6`
// flips back, exactly like the control path.
const INSTALLER_WRITE_ADDR = 0x00e7; // the register this path was built for
const INSTALLER_WRITE_MAX_RAW = 7000; // 70,0 kW at scale 10 - the LOCAL button's ceiling
const REGISTER_WORD_MAX = 0xffff;

/**
 * installerWriteRoute - map a parsed Selection + an ALREADY ADMITTED request
 * onto the one-shot write plan. Pure, like every other route.
 *
 *   sel: the parsed edge/inverter/config (inverter-routing.parseConfig output)
 *   req: { mode: 'dry_run'|'apply', addr, value }
 *
 * Returns { ok: false, reason } or:
 *   { ok: true, adapter: 'solarman_v5', target, connection:{ip,port,serial,
 *     mb_slave_id}, apply, addr, value, scale?, kw?, read:{fc:3,addr,count:1},
 *     write:{fc,addr,value} }   // write ABSENT on a dry run
 *
 * `scale`/`kw` are present ONLY for the register whose scale this family's own
 * read table knows (the feed-in cap). A free register gets NO invented unit.
 */
function installerWriteRoute(sel, req) {
  if (!sel) return { ok: false, reason: 'Es ist kein Wechselrichter eingerichtet.' };
  if (sel.communication !== COMM_SOLARMAN) {
    return { ok: false, reason: 'Dieser Wechselrichter wird nicht über den Solarman-Logger gelesen; der Fernschreibpfad steht nur dort zur Verfügung.' };
  }
  const r = req || {};
  const addr = Number(r.addr);
  if (!isFiniteNum(addr) || !Number.isInteger(addr) || addr < 0 || addr > REGISTER_WORD_MAX) {
    return { ok: false, reason: 'Die Adresse ist kein Register (0 bis ' + REGISTER_WORD_MAX + ').' };
  }
  const apply = r.mode === 'apply';
  const raw = Number(r.value);
  const wordOk = isFiniteNum(raw) && Number.isInteger(raw) && raw >= 0 && raw <= REGISTER_WORD_MAX;
  if (apply && !wordOk) {
    return { ok: false, reason: 'Der Wert ist kein Registerwort (0 bis ' + REGISTER_WORD_MAX + ').' };
  }
  // A DRY RUN may carry the value it WOULD write (the :8484 button does) or none
  // at all (a portal preview must not, per contract) - both are fine, nothing is
  // written either way.
  const value = wordOk ? raw : 0;
  const conn = sel.connection || {};
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return { ok: false, reason: 'Für den Wechselrichter ist keine IP-Adresse hinterlegt.' };
  const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
  const slaveId = Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1;
  const reg = DEYE_CONTROL_REG[sel.family];
  const out = {
    ok: true, adapter: 'solarman_v5', family: sel.family,
    target: ip + ':' + port,
    connection: { ip, port, serial: conn.serial, mb_slave_id: slaveId },
    apply,
    addr, value,
    // The read is the SAME on both stages: a dry run reports the Ist-value, a
    // real write reads before AND after. One register, FC3.
    read: { fc: 3, addr, count: 1 },
  };
  // Only the ONE register whose scale the read-side table states gets a unit -
  // and only where it really is the family's own dedicated feed-in cap.
  if (reg && reg.exportLimit === addr && reg.exportLimit !== reg.maxSellPower) {
    out.scale = reg.exportLimitScale;
    out.kw = (value * reg.exportLimitScale) / 1000;
  }
  if (apply) {
    out.write = { fc: resolveDeyeWriteFc(conn), addr, value };
  }
  return out;
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
  // Certified = the fleet-wide family allowlist OR this device's runtime First-Light
  // grant (see deviceGrant). ONE variable on purpose: `certified` means "this device
  // may receive live control writes" at every consumption point - the write gate, the
  // German reason, the readback stamp, dualControllerSignal - and that is precisely
  // what the core's own Agent.controlCertified computes. A device with no grant is
  // unchanged.
  const certified = CERTIFIED_CONTROL_FAMILIES.has(family) || deviceGrant(setpoint);
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
    // block gives it a TRUE Tier-2 setpoint. The STICKY per-device path decision
    // (opts.deyeSticky, persisted durably by the executor; see deyeUpdateSticky)
    // decides which adapter runs; without one the raw PROBED capability (opts.deye)
    // does, and with neither the legacy ToU path plans - but a CERTIFIED device's
    // ToU writes only engage DELIBERATELY (see the gate in deyeControl).
    // `remote_mode: 'off'` on the connection is the operator's force-ToU hatch.
    const sticky = (opts && opts.deyeSticky && typeof opts.deyeSticky === 'object') ? opts.deyeSticky : null;
    const rawCap = (opts && opts.deye && typeof opts.deye === 'object') ? opts.deye : null;
    const cap = deyeEffectiveCap(rawCap, sticky);
    const remoteOff = conn.remote_mode === 'off' || conn.remote_mode === false;
    if (!remoteOff && deyeControlPath(cap) === DEYE_PATH_REMOTE) {
      return deyeRemoteControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap });
    }
    return deyeControl({ selection, conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap, sticky });
  }
  if (tier === CONTROL_TIER.VENDOR_EMS) {
    if (comm === COMM_KOSTAL) {
      return kostalControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw });
    }
    return vendorEmsControl({ conn, ip, family, certified, controlEnabled });
  }
  if (tier === CONTROL_TIER.SUNSPEC) {
    if (comm === COMM_MODBUS) {
      return sunspecControl({ selection, conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw });
    }
    if (comm === COMM_FRONIUS) {
      return froniusControl({ conn, ip, family, certified, controlEnabled, kw, pvLimitKw, setpoint, opts });
    }
    // KACO: innerhalb desselben Tiers waehlt die KOMMUNIKATION die Register-
    // FLAECHE (die Regel, die schon fuer generic/Fronius gilt). Beide Adapter
    // sind vorbereitet und GESPERRT - `writes` bleibt leer.
    if (comm === COMM_SUNSPEC_TCP) {
      return kacoSunspecControl({ conn, ip, family, certified, controlEnabled, pvLimitKw, opts });
    }
    if (comm === COMM_KACO_MODBUS) {
      return kacoNh3Control({ conn, ip, family, certified, controlEnabled, kw, setpoint });
    }
    if (comm === COMM_KACO_HTTP) {
      // Ehrlich: ueber die App-Schnittstelle gibt es keinen dokumentierten
      // Steuerweg. Kein Plan, keine erfundene Adresse - nur der Grund.
      return idle('KACO App-Schnittstelle: kein Steuerweg (nur lesen)');
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

// --- KOSTAL PLENTICORE Tier-2 control adapter (external battery management) ---
//
// The FIRST realized vendor external-EMS surface (scout report
// data/vp-kostal-plenticore-s5 §3.3; official "Interface description MODBUS
// (TCP) & SunSpec with control information" Rev. 2.9 §3.4, field-proven by
// OpenEMS io.openems.edge.kostal + evcc):
//
//   ONE LEVER: register 1034 "Battery charge power (DC) setpoint, absolute"
//   (float32, FC16, watts). Doc note 1: NEGATIVE = charge / POSITIVE =
//   discharge - the OPPOSITE of VoltPilot's + = charge, so the adapter
//   NEGATES; `invert_control_sign` is the First-Light hatch on top.
//
// SINGLE-LEVER DISCIPLINE (load-bearing; field evidence evcc #26709 +
// openHAB): while external control is active, EVERY register written in the
// session stays in force until the inverter's watchdog expires - mixing 1034
// with the limit/SoC registers creates stuck state conflicts (battery fully
// blocked). So this adapter touches register 1034 and NOTHING else: the SoC
// window registers 1042/1044 and the limit registers 1038/1040 are NEVER
// written - guards.Clamp upstream is the SoC/limit authority (it already
// clamped the kw this adapter receives), and "hold" is simply the clamped
// setpoint 0.
//
// WATCHDOG MODEL (the inverter's own dead-man's switch): the PLENTICORE's
// external battery management has a webserver-configured timeout (60 s is the
// common standard); when the EMS goes silent the inverter DISCARDS the
// setpoint and returns to internal battery management. Control registers are
// RAM (doc §3.3 semantics: discarded on reset), so re-asserting every ~10-s
// setpoint tick IS the watchdog kick - `always: true` + `dwell_s: 0`, the
// Deye remote-mode discipline (an EEPROM write-on-change filter would let the
// watchdog expire mid-operation). Simply STOPPING is the failsafe of last
// resort; the explicit release additionally writes 0 once (controlRelease).
//
// ACTIVATION GATE: the installer must enable "Externe Batteriesteuerung über
// Protokoll Modbus (TCP)" (Webserver -> Servicemenü -> Batterieeinstellungen);
// register 1080 reports the active mode (2 = external via MODBUS). The plan
// carries `mgmt_gate` so the EXECUTOR verifies 1080 BEFORE the first write and
// refuses with the German lever otherwise; 1080 also rides the readbacks so a
// mid-session deactivation surfaces as a mismatch, never silently.
//
// SAFETY: kostal_plenticore is DELIBERATELY absent from
// CERTIFIED_CONTROL_FAMILIES - until the bench pass on the real unit
// (CONTROL-BENCH.md -> "Checkliste Kostal PLENTICORE") every write stays
// `planned`-only; First-Light calibration is the one bounded bypass, and
// VP_CONTROL_ENABLED stays the outer AND. PV curtailment does not exist on
// the BI (no MPPTs): a pv_limit_kw is reported dropped, never silently.
const KOSTAL_REG = { SETPOINT: 1034, MGMT_MODE: 1080 };
const KOSTAL_MGMT_EXTERNAL_MODBUS = 2;
const KOSTAL_DEFAULT_PORT = 1502;
const KOSTAL_DEFAULT_UNIT_ID = 71;
const KOSTAL_MGMT_GATE_REASON = 'Externe Batteriesteuerung (Modbus) ist am Wechselrichter nicht aktiviert - Webserver -> Servicemenü -> Batterieeinstellungen';

function kostalControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : KOSTAL_DEFAULT_PORT;
  const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : KOSTAL_DEFAULT_UNIT_ID;
  const invert = conn.invert_control_sign === true;
  const byteOrder = conn.byte_order === 'little' || conn.byte_order === 'big' ? conn.byte_order : 'auto';
  // VoltPilot + = charge -> Kostal register - = charge: NEGATE (hatch flips back).
  // `|| 0` normalizes the negative zero the negation produces at kw = 0 (a -0
  // would travel into the readback comparison + the payload as a distinct value).
  const watts = Math.round((invert ? 1 : -1) * kw * 1000) || 0;

  // The intended write (always computed so the readback surface + tests see the
  // full mapping); whether it EXECUTES depends on the gate below. float32 over
  // FC16 - the executor encodes per the resolved byte order (register 5 on
  // 'auto'). always:true = re-assert every tick (the watchdog kick, RAM register).
  const planned = [
    {
      role: 'battery_setpoint', fc: 16, addr: KOSTAL_REG.SETPOINT, value: watts,
      encode: { kind: 'watts_float32', kw: watts / 1000 }, dwell_s: 0, min_change: 0, always: true,
    },
  ];

  // Readbacks ALWAYS run: the setpoint echo (float, 2 registers) proves the
  // hold; the management mode proves the installer gate stays active.
  const readbacks = [
    { role: 'battery_setpoint', fc: 3, addr: KOSTAL_REG.SETPOINT, count: 2, decode: 'float32', expect: watts, tolerance: 1 },
    { role: 'mgmt_mode', fc: 3, addr: KOSTAL_REG.MGMT_MODE, count: 1, expect: KOSTAL_MGMT_EXTERNAL_MODBUS, tolerance: 0 },
  ];

  const writeAllowed = controlEnabled && (certified || calibration);
  const out = {
    adapter: 'kostal_modbus', family, tier: CONTROL_TIER.VENDOR_EMS,
    target: ip + ':' + port,
    connection: { ip, port, unit_id: unitId, byte_order: byteOrder },
    certified, controlEnabled, calibration: calibration === true,
    // The executor's pre-write activation probe (register 1080 must read 2).
    mgmt_gate: { fc: 3, addr: KOSTAL_REG.MGMT_MODE, expect: KOSTAL_MGMT_EXTERNAL_MODBUS, reason: KOSTAL_MGMT_GATE_REASON },
    writes: writeAllowed ? planned.map((w) => ({ ...w })) : [],
    readbacks,
    planned,
  };
  if (!writeAllowed) {
    out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Modell noch nicht freigegeben';
  }
  if (pvLimitKw !== null && pvLimitKw !== undefined) {
    // The BI has no PV - a curtailment cap cannot be executed here. Reported,
    // never silently dropped (the Deye remote-mode rule).
    out.pvLimitSupported = false;
    out.pvLimitDroppedKw = pvLimitKw;
  }
  return out;
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
 *   opts:      { sunspec?: discovery, calibration?: boolean, controlEnabled?: boolean,
 *                deviceCertified?: boolean }
 *              - live SunSpec model discovery for Fronius, the calibration-revert
 *              bypass, the core's control_enabled for the setpoint that
 *              triggered this hand-back, and that setpoint's per-device First-Light
 *              grant (`device_certified`) so a device we may DRIVE can also RELEASE.
 *
 * controlEnabled is CARRIED THROUGH like every other adapter result (portal-signal
 * fix, 2026-07-27). It used to be absent here, so the exec node's
 * `!!ctrl.controlEnabled` stamped a hard `false` on every release readback -
 * `!!undefined`, not an observation. The cloud heartbeat no longer sources the flag
 * from a readback at all (agent.controlSummary reads the core), but a readback must
 * still report what Layer 1 actually saw rather than a structural lie.
 *
 * Returns { adapter, family, tier, certified, controlEnabled, mode:'release',
 *           target, connection, writes:[WriteOp], readbacks:[ReadOp],
 *           planned:[WriteOp], reason? }.
 */
function controlRelease(selection, opts = {}) {
  const calibration = opts.calibration === true;
  const controlEnabled = opts.controlEnabled === true;
  const idle = (reason) => ({
    adapter: 'idle', family: '', tier: CONTROL_TIER.READ_ONLY, certified: false,
    controlEnabled, mode: 'release', writes: [], readbacks: [], planned: [], reason,
  });
  if (!selection) return idle('keine Auswahl');
  const conn = selection.connection || {};
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return idle('keine IP-Adresse');
  const family = typeof selection.family === 'string' ? selection.family.trim() : '';
  // Same disjunction as controlRoute, and it is LOAD-BEARING here: whatever may be
  // DRIVEN must be able to be HANDED BACK. Without the grant on this side a released
  // device would start controlling and then never release on a kill-off / stale core,
  // which is the one asymmetry that would make the gate change unsafe.
  const certified = CERTIFIED_CONTROL_FAMILIES.has(family) || opts.deviceCertified === true;
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
    // The release follows the SAME sticky-decision resolution as controlRoute: what
    // was DRIVEN is what must be HANDED BACK. A transient probe failure right at
    // release time must not make a remote hand-back degrade into a ToU restore
    // (1100 <- 0 is the correct remote release; the watchdog is the last resort).
    const rawRemoteCap = (opts && opts.deye && typeof opts.deye === 'object') ? opts.deye : null;
    const remoteSticky = (opts && opts.deyeSticky && typeof opts.deyeSticky === 'object') ? opts.deyeSticky : null;
    const remoteCap = deyeEffectiveCap(rawRemoteCap, remoteSticky);
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
        adapter: 'solarman_v5', family, tier, certified, controlEnabled, calibration, mode: 'release',
        controlPath: DEYE_PATH_REMOTE,
        target: ip + ':' + port, connection: { ip, port, serial, mb_slave_id: slaveId, remote_mode: 'auto' },
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
      adapter: 'solarman_v5', family, tier, certified, controlEnabled, calibration, mode: 'release',
      controlPath: DEYE_PATH_TOU,
      target: ip + ':' + port, connection: { ip, port, serial, mb_slave_id: slaveId, remote_mode: remoteOff ? 'off' : 'auto' },
      writes: releaseAllowed ? planned : [], readbacks: releaseAllowed ? readbacks : [],
      planned, capabilityProbe: deyeCapabilityProbeSpec(family),
      reason: releaseAllowed ? undefined : 'Steuerung für dieses Modell noch nicht freigegeben',
    };
  }

  if (tier === CONTROL_TIER.VENDOR_EMS && comm === COMM_KOSTAL) {
    // KOSTAL release: setpoint 0 ONCE, then the caller simply stops writing -
    // the inverter's OWN watchdog (webserver timeout) discards the external
    // setpoint and returns to internal battery management with NOTHING changed.
    // No installer state was ever touched (single-lever discipline), so there is
    // no snapshot to restore - structurally the Deye remote-mode release.
    const port = Number(conn.port) > 0 ? Number(conn.port) : KOSTAL_DEFAULT_PORT;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : KOSTAL_DEFAULT_UNIT_ID;
    const byteOrder = conn.byte_order === 'little' || conn.byte_order === 'big' ? conn.byte_order : 'auto';
    const planned = [
      {
        role: 'battery_setpoint', fc: 16, addr: KOSTAL_REG.SETPOINT, value: 0,
        encode: { kind: 'watts_float32', kw: 0 }, dwell_s: 0, min_change: 0, always: true,
      },
    ];
    const readbacks = [
      { role: 'battery_setpoint', fc: 3, addr: KOSTAL_REG.SETPOINT, count: 2, decode: 'float32', expect: 0, tolerance: 1 },
    ];
    return {
      adapter: 'kostal_modbus', family, tier, certified, controlEnabled, calibration, mode: 'release',
      target: ip + ':' + port, connection: { ip, port, unit_id: unitId, byte_order: byteOrder },
      writes: releaseAllowed ? planned.map((w) => ({ ...w })) : [],
      readbacks: releaseAllowed ? readbacks : [],
      planned,
      reason: releaseAllowed ? undefined : 'Modell noch nicht freigegeben',
    };
  }

  if (tier === CONTROL_TIER.VENDOR_EMS) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    return {
      adapter: 'vendor_ems', family, tier, certified: false, controlEnabled, mode: 'release',
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
      adapter: 'modbus_tcp', family, tier, certified, controlEnabled, calibration, mode: 'release', profile: family,
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
      adapter: 'fronius_sunspec', family, tier, certified, controlEnabled, mode: 'release',
      target: ip + ':' + port, connection: { ip, port, unit_id: unitId },
      writes: [], readbacks: [], planned,
      reason: planned.length > 0 ? 'Fronius SunSpec: Steuerung nicht freigegeben'
        : 'Fronius SunSpec: ' + curtail.reason + ' (Steuerung nicht freigegeben)',
    };
  }

  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_SUNSPEC_TCP) {
    // Ruecknahme der Wirkleistungsbegrenzung: `WMaxLim_Ena` = 0 an den
    // ENTDECKTEN Adressen (dieselbe geteilte Planung wie bei Fronius).
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
    const plan = sunspec.planCurtailment({ discovery: opts.sunspec || null, pvLimitKw: null });
    const planned = plan.ok ? plan.writes.map((w) => ({ ...w, bench_pending: true })) : [];
    return {
      adapter: 'kaco_sunspec', family, tier, certified, controlEnabled, mode: 'release',
      target: ip + ':' + port, connection: { ip, port, unit_id: unitId },
      writes: [], readbacks: [], planned,
      reason: planned.length > 0 ? 'KACO SunSpec: Steuerung nicht freigegeben'
        : 'KACO SunSpec: ' + plan.reason + ' (Steuerung nicht freigegeben)',
    };
  }

  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_KACO_MODBUS) {
    // ⚠ DIE RUECKNAHME IST HIER DER GANZE FAILSAFE: der NH3 hat kein
    // dokumentiertes Totmann-Register, ein gesetzter Sollwert bliebe also
    // stehen. Zurueck auf Eigenverbrauch (41104 = 2) und Sollwert 0.
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
    return {
      adapter: 'kaco_nh3', family, tier, certified, controlEnabled, mode: 'release',
      target: ip + ':' + port, connection: { ip, port, unit_id: unitId },
      writes: [], readbacks: [], planned: kacoNh3ReleasePlan(),
      reason: 'KACO NH3: Steuerung nicht freigegeben',
    };
  }

  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_KACO_HTTP) {
    return { ...idle('KACO App-Schnittstelle: kein Steuerweg (nur lesen)'), mode: 'release', tier, planned: [] };
  }

  return idle('unbekannte Kommunikationsmethode');
}

/**
 * nativeSelfConsumption - the NATIVE SELF-REGULATION primitive ("Selbstregel-
 * Modus"): in a slot the CLOUD marked worth covering from the battery, hand the
 * SETPOINT ITSELF back to the inverter and let its own self-consumption loop
 * decide how many watts to pull, instead of writing a recomputed watt value
 * every 10 s (guards/nativemode.go carries the core-side supervision).
 *
 * ⚠ WHAT IT IS, in one line: the existing RELEASE write list of this tier PLUS a
 * STATE READBACK as proof, written ONCE and then only read. The return path is
 * the ordinary controlRoute plan - so there is no second way into or out of the
 * device, and every register here is one this file already writes today.
 *
 * ⚠ THE PROOF IS THE POINT. Once we stop writing, "the inverter regulates itself
 * because we asked it to" and "VoltPilot died" look identical from the cloud
 * (the scout's risk 5). So the primitive is only ever reported as executed when
 * the DEVICE's own state register says so - and the core withdraws an intent it
 * never sees confirmed. That is why `readbacks` here are the mode/state
 * registers, not the setpoint.
 *
 * ⚠ THE GATE IS THE CERTIFICATE, NOT THIS FILE. `planned` is always computed (the
 * bench artefact - the same discipline as every uncertified adapter here), but
 * `writes`/`readbacks` stay EMPTY unless unplanned-load-native.js releases an
 * exact (manufacturer, model, firmware) entry AND that entry's recorded bytes
 * still match what this adapter plans. So on every device shipped today the
 * result is supported:true, writes:[] - the honest "we know how, nobody measured
 * it yet".
 *
 * ⚠ DEYE ToU IS DELIBERATELY UNSUPPORTED (captain decision, 2026-08-26). On the
 * ToU path every mode change is an EEPROM write with ~20 s direction latency and
 * a snapshot/restore duty, so "native" would buy nothing there and cost write
 * cycles; that path keeps the 10-second follower.
 *
 *   selection: the parsed edge/inverter/config (or null)
 *   opts: { catalog?, sunspec?, deye?, deyeSticky?, controlEnabled?,
 *           deviceCertified?, solarOnlyCharge? }
 *     - catalog: the native capability catalog (production = empty; the flow's
 *       SIMULATOR tab passes SIMULATOR_NATIVE_CAPABILITIES)
 *     - solarOnlyCharge: the site's EEG posture. When true the device must PROVE
 *       from its OWN configuration that it cannot grid-charge, because that ban
 *       moves into the device the moment we stop commanding (scout risk 2, the
 *       dualControllerSignal pattern). A tier with no such register REFUSES on an
 *       EEG site rather than hoping.
 *     - deyeOwnConfig / effectiveFloorSocPct: the device's own Time-of-Use
 *       configuration (as read via `preconditions`) and the platform's reserve
 *       floor - the RUNTIME refusal on the Deye tier, see deyeNativePrecondition.
 *       Absent = refused, never assumed.
 *
 * Returns { adapter, family, tier, mode:'native', supported, certified,
 *           controlEnabled, target, connection, writes, readbacks, observations,
 *           planned, plannedReadbacks, preconditions, gridChargeProof, reason }.
 */
function nativeSelfConsumption(selection, opts = {}) {
  const controlEnabled = opts.controlEnabled === true;
  const solarOnly = opts.solarOnlyCharge === true;
  const catalog = Array.isArray(opts.catalog) ? opts.catalog : unplannedNative.CERTIFIED_NATIVE_CAPABILITIES;
  const idle = (reason) => ({
    adapter: 'idle', family: '', tier: CONTROL_TIER.READ_ONLY, mode: 'native',
    supported: false, certified: false, controlEnabled,
    writes: [], readbacks: [], observations: [], planned: [], plannedReadbacks: [],
    preconditions: [], reason,
  });
  if (!selection) return idle('keine Auswahl');
  const conn = selection.connection || {};
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return idle('keine IP-Adresse');
  const family = typeof selection.family === 'string' ? selection.family.trim() : '';
  const tier = resolveControlTier(selection);
  const comm = selection.communication;
  // Same disjunction as controlRoute/controlRelease: whatever may be DRIVEN may
  // be handed over, and nothing else.
  const certified = CERTIFIED_CONTROL_FAMILIES.has(family) || opts.deviceCertified === true;

  const built = nativeForTier({ selection, conn, ip, family, tier, comm, opts });
  if (!built) return idle('unbekannte Kommunikationsmethode');
  if (built.unsupported) {
    return {
      ...idle(built.reason), adapter: built.adapter, family, tier,
    };
  }

  const out = {
    adapter: built.adapter, family, tier, mode: 'native', supported: true,
    certified, controlEnabled,
    target: built.target, connection: built.connection,
    writes: [], readbacks: [], observations: built.observations || [],
    planned: built.planned, plannedReadbacks: built.readbacks,
    gridChargeProof: built.gridChargeProof || null,
    proofKind: built.proofKind || 'register',
    // What an executor must READ from the device BEFORE the hand-over. Empty on
    // every tier whose own configuration cannot make the hand-over meaningless.
    preconditions: built.preconditions || [],
  };

  // EEG: the ban on grid charging moves into the DEVICE's own configuration the
  // moment we stop commanding, so it has to be readable. A tier without such a
  // register refuses on an EEG site - a compliance rule may not rest on hope.
  if (solarOnly && !out.gridChargeProof) {
    out.reason = 'EEG-Anlage: dieser Wechselrichter kann nicht belegen, dass er nicht aus dem Netz lädt';
    return out;
  }
  if (!controlEnabled) {
    out.reason = certified ? 'Steuerung deaktiviert (Not-Aus)' : 'Modell noch nicht freigegeben';
    return out;
  }
  if (!certified) {
    out.reason = 'Modell noch nicht freigegeben';
    return out;
  }

  const capability = unplannedNative.exactCapability(nativeSelectionKey(selection, built), catalog);
  if (!capability) {
    out.reason = 'Wechselrichter-Automatik für dieses Modell noch nicht am Prüfstand freigegeben';
    return out;
  }
  // The certificate ATTESTS the adapter's bytes. If they drifted apart, nothing
  // on this device has been measured - refuse rather than execute an untested
  // sequence under a certificate that describes a different one.
  if (!unplannedNative.certificateMatchesPlan(capability, built.planned, built.readbacks)) {
    out.reason = 'Prüfstand-Freigabe und Schreibplan stimmen nicht überein - Freigabe erneuern';
    return out;
  }
  // ⚠ LAST GATE, and deliberately AFTER the certificate: the certificate answers
  // "can this model+firmware do it", the precondition answers "will THIS
  // customer's configuration actually cover the house once we let go". Ordering
  // it here also keeps the honest "not bench-released yet" reason for every
  // device that has no certificate at all.
  if (built.precondition) {
    const refusal = built.precondition(opts);
    if (refusal) {
      out.reason = refusal;
      return out;
    }
  }
  out.writes = built.planned.map((w) => ({ ...w })).concat(built.extraWrites || []);
  out.readbacks = built.readbacks.map((r) => ({ ...r })).concat(built.extraReadbacks || []);
  out.certificate = { brand: capability.brand, model: capability.model, firmware: capability.firmware,
    simulator_only: capability.simulatorOnly === true, bench_record: capability.benchRecord || '' };
  return out;
}

/**
 * nativeSelectionKey - the (brand, model, firmware) triple the certificate is
 * keyed on. `model` is the CATALOG MODEL ID the core publishes on
 * edge/inverter/config (inverter.go `Selection.Model`, e.g. 'sun-30k-sg01hp3'),
 * never a free-text label.
 *
 * ⚠ THE FIRMWARE HAS TWO SOURCES, AND THE DEVICE'S OWN ANSWER WINS. A tier that
 * can DETECT its firmware capability states it as `firmwareEvidence`
 * (Deye remote: the probed PR-978 layout) - on such a family an operator-typed
 * string is not evidence and must not be able to claim a certificate. Everything
 * else falls back to the recorded `connection.firmware`; a selection with
 * neither can never match an exact certificate, which is the intended
 * fail-closed behaviour (a firmware update may remove the very behaviour that
 * was measured).
 */
function nativeSelectionKey(selection, built) {
  return {
    brand: selection.brand,
    model: selection.model,
    firmware: (built && built.firmwareEvidence)
      || (selection.connection && selection.connection.firmware) || selection.firmware,
  };
}

/**
 * deyeNativePrecondition - the RUNTIME refusal that stands BETWEEN a released
 * certificate and an actual hand-over on a Deye.
 *
 * ⚠ WHY IT EXISTS: the certificate says "this model+firmware executes the
 * primitive correctly". It cannot say what the CUSTOMER's inverter is configured
 * to do afterwards - and on a Deye that decides whether letting go produces a
 * covering mode at all (see the `preconditions` comment in nativeForTier). The
 * supervision cannot catch this one: a device that runs but never covers still
 * reports `native` on its state register, so the core would see a PROVEN mode
 * while the house quietly imports.
 *
 * Fail-closed by construction: `cfg` absent or incomplete is a REFUSAL, never an
 * assumption ("lieber verweigern als blind umschalten"). Every reason is German
 * and names what the operator has to look at.
 *
 *   cfg: { tou_enable, program_target_soc, program_charge_enable } - raw register
 *        values, as read from the device
 *   floorPct: the platform's effective reserve floor (null = unknown)
 *   solarOnly: the site's EEG posture
 *
 * Returns null when the device may be let go, else the German reason.
 */
function deyeNativePrecondition(cfg, { floorPct, solarOnly } = {}) {
  // ⚠ Number(null) and Number('') are BOTH 0, so a MISSING register would read as
  // a real zero and produce the wrong sentence ("Programm nicht aktiv" instead of
  // "nicht gelesen"). Both refuse, but only one of them tells the operator the
  // truth - so an absent value is never coerced.
  const reg = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
  if (!cfg || typeof cfg !== 'object') {
    return 'Die eigene Konfiguration des Wechselrichters ist nicht bekannt - es wird nicht umgeschaltet';
  }
  const tou = reg(cfg.tou_enable);
  if (!Number.isFinite(tou)) {
    return 'Das Zeitfenster-Programm des Wechselrichters konnte nicht gelesen werden - es wird nicht umgeschaltet';
  }
  // Bit 0 is "Enabled"; the weekday bits above it say WHEN. Without the enable
  // bit the manual is unambiguous: the inverter will not discharge to the loads.
  if ((tou & DEYE_TOU_ENABLE_BIT) === 0) {
    return 'Das Zeitfenster-Programm (Time of Use) des Wechselrichters ist nicht aktiv - '
      + 'ohne es deckt er laut Handbuch nicht den Hausverbrauch aus der Batterie';
  }
  const targetSoc = reg(cfg.program_target_soc);
  if (!Number.isFinite(targetSoc) || targetSoc < 0 || targetSoc > 100) {
    return 'Das Ziel-Ladeniveau des Zeitfenster-Programms konnte nicht gelesen werden - es wird nicht umgeschaltet';
  }
  // The device stops discharging at ITS target SoC. If that sits above our
  // reserve floor the inverter would end the covering earlier than the
  // supervision expects - and nothing would report it, because the mode itself
  // stays correct. An unknown floor cannot be judged, so it refuses too.
  const floor = reg(floorPct);
  if (!Number.isFinite(floor)) {
    return 'Die Reserve-Untergrenze der Anlage ist nicht bekannt - es wird nicht umgeschaltet';
  }
  if (targetSoc > floor) {
    return 'Das Ziel-Ladeniveau des Zeitfenster-Programms (' + targetSoc + ' %) liegt über der '
      + 'Reserve-Untergrenze der Anlage (' + floor + ' %) - der Wechselrichter würde '
      + 'die Deckung zu früh beenden';
  }
  if (solarOnly === true) {
    const charge = reg(cfg.program_charge_enable);
    if (!Number.isFinite(charge) || charge !== DEYE_PROG_CHARGE.DISABLED) {
      return 'EEG-Anlage: das Zeitfenster-Programm des Wechselrichters erlaubt das Laden aus dem Netz '
        + '- es wird nicht umgeschaltet';
    }
  }
  return null;
}

// nativeForTier builds the per-tier primitive: the release write list PLUS the
// state readback that proves it. Returns null for an unknown transport and
// { unsupported: true, reason } for a tier that deliberately has none.
function nativeForTier({ selection, conn, ip, family, tier, comm, opts }) {
  if (tier === CONTROL_TIER.TOU && comm === COMM_SOLARMAN) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 8899;
    const writeFc = resolveDeyeWriteFc(conn);
    const reg = deyeFamilyControlReg(family);
    const cap = deyeEffectiveCap(
      (opts && opts.deye && typeof opts.deye === 'object') ? opts.deye : null,
      (opts && opts.deyeSticky && typeof opts.deyeSticky === 'object') ? opts.deyeSticky : null);
    const remoteOff = conn.remote_mode === 'off' || conn.remote_mode === false;
    // ⚠ THE LAYOUT IS PART OF THE GATE, not only the path. `supported` is already
    // false for the older v105_1 layout, but stating it here is what makes the
    // certificate's firmware key (DEYE_REMOTE_PR978_FIRMWARE) a MEASURED fact
    // rather than an assumption: this branch only ever hands the key out for the
    // register layout the adapter actually writes.
    const pr978 = cap && cap.layout === DEYE_REMOTE_LAYOUT_PR978;
    if (remoteOff || !reg || deyeControlPath(cap) !== DEYE_PATH_REMOTE || !pr978) {
      // ⚠ Deye ToU: no native primitive, and that is a decision, not a gap. Every
      // mode change there is an EEPROM write with ~20 s direction latency and a
      // snapshot/restore duty, so handing over and taking back would cost more
      // write cycles than the 10-second follower it replaces.
      return {
        unsupported: true, adapter: 'solarman_v5',
        reason: 'Deye ohne Fernsteuer-Firmware: die Zeitfenster-Steuerung bleibt bei der 10-Sekunden-Nachführung',
      };
    }
    // REMOTE: disabling remote mode IS the hand-over - the inverter then runs its
    // OWN configuration (Work Mode + Time-of-Use), which is precisely the native
    // self-consumption loop. Nothing installer-level is touched, so there is
    // nothing to restore on the way back.
    const planned = [{
      role: 'remote_mode', fc: writeFc, addr: DEYE_REMOTE_REG.mode, value: DEYE_REMOTE_MODE.OFF,
      encode: { kind: 'remote_mode', enum: 'off', native: true },
      dwell_s: 0, min_change: 0, bench_pending: true,
    }];
    return {
      adapter: 'solarman_v5', target: ip + ':' + port,
      connection: { ip, port, serial: conn.serial,
        mb_slave_id: Number(conn.mb_slave_id) > 0 ? Number(conn.mb_slave_id) : 1,
        remote_mode: 'auto' },
      planned,
      // 1100 == 0 is the device saying "I am no longer remote-controlled".
      readbacks: [{ role: 'remote_mode', fc: 3, addr: DEYE_REMOTE_REG.mode, expect: DEYE_REMOTE_MODE.OFF, tolerance: 0 }],
      // 1121 is the remote execution state - an OBSERVATION, deliberately kept
      // out of the comparison so it can never fabricate or break a verdict.
      observations: [{ role: 'remote_status', fc: 3, addr: DEYE_REMOTE_REG.status }],
      // With remote off the device follows its own Program-1 charging enum, so
      // "Disabled" (0) is the readable proof that it will not charge from grid.
      gridChargeProof: { role: 'grid_charge_enable', fc: 3,
        addr: reg.progChargeBase + DEYE_CONTROL_SLOT, expect: DEYE_PROG_CHARGE.DISABLED, tolerance: 0 },
      // ⚠ THE FIRMWARE KEY IS THE DEVICE'S OWN ANSWER, never an operator string.
      // See DEYE_REMOTE_PR978_FIRMWARE in unplanned-load-native.js: the probe
      // classified this register layout, the sticky decision holds it, and a
      // firmware that loses the block stops matching by itself.
      firmwareEvidence: DEYE_REMOTE_PR978_FIRMWARE,
      // ⚠ WHAT THE DEVICE'S OWN CONFIGURATION MUST SAY BEFORE WE LET GO. Deye's
      // manual (SUN-29.9..50K-SG01HP3-EU-BM3/BM4, 2025-08-19) is explicit: "When
      // ... 'Time Of Use' is not enabled, the inverter can charge normally, but
      // only discharge to provide the inverter's self-consumption power, without
      // discharging to power the loads." So on THIS family "stop commanding" only
      // produces a COVERING mode when the device's own Time-of-Use program is
      // armed and permits discharging down past the platform's reserve floor.
      // The adapter is pure, so these are READ SPECS - an executor performs them
      // BEFORE the hand-over and passes the values back as opts.deyeOwnConfig.
      preconditions: [
        { role: 'tou_enable', fc: 3, addr: reg.touEnable },
        { role: 'program_target_soc', fc: 3, addr: reg.progSocBase + DEYE_CONTROL_SLOT },
        { role: 'grid_charge_enable', fc: 3, addr: reg.progChargeBase + DEYE_CONTROL_SLOT },
      ],
      precondition: (o) => deyeNativePrecondition(o && o.deyeOwnConfig, {
        floorPct: o && o.effectiveFloorSocPct,
        solarOnly: o && o.solarOnlyCharge === true,
      }),
    };
  }
  if (tier === CONTROL_TIER.VENDOR_EMS && comm === COMM_KOSTAL) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : KOSTAL_DEFAULT_PORT;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : KOSTAL_DEFAULT_UNIT_ID;
    const byteOrder = conn.byte_order === 'little' || conn.byte_order === 'big' ? conn.byte_order : 'auto';
    // ⚠ KOSTAL's hand-over is the ABSENCE of a write: after the webserver-configured
    // timeout the inverter discards the external setpoint and returns to its
    // internal battery management. So the primitive writes NOTHING at all.
    //
    // ⚠ AND ITS PROOF IS BEHAVIOURAL, not a register: 1080 reads 2 ("external via
    // Modbus") in BOTH states, so no register distinguishes them. The bench
    // criterion for this family is therefore observing 582 (battery power)
    // follow the house - which is why the certificate, not this adapter, is the
    // thing that may release it.
    return {
      adapter: 'kostal_modbus', target: ip + ':' + port,
      connection: { ip, port, unit_id: unitId, byte_order: byteOrder },
      planned: [],
      readbacks: [{ role: 'mgmt_mode', fc: 3, addr: KOSTAL_REG.MGMT_MODE, expect: KOSTAL_MGMT_EXTERNAL_MODBUS, tolerance: 0 }],
      observations: [{ role: 'battery_power', fc: 3, addr: 582, count: 2, decode: 'float32' }],
      proofKind: 'behavioral',
      // The internal battery management does not charge from the grid, but no
      // register STATES that - so an EEG site gets no proof and is refused.
      gridChargeProof: null,
    };
  }
  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_MODBUS) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
    // The generic/simulator profile: clearing the EMS-control flag hands the
    // device back to its own regulation, and zeroing the setpoint makes sure no
    // stale watt value can be re-adopted if the flag is set again.
    const planned = [
      { role: 'control_enable', fc: 6, addr: SUNSPEC_REG.ENABLE, value: 0, encode: { kind: 'flag', native: true }, dwell_s: 0, min_change: 0 },
      { role: 'battery_power', fc: 6, addr: SUNSPEC_REG.SETPOINT, value: 0, encode: { kind: 'kw_x100_s16', scale: 100, kw: 0 }, dwell_s: 0, min_change: 0 },
    ];
    // ⚠ CURTAILMENT IS NOT PART OF THE HAND-OVER. The native mode concerns the
    // BATTERY; the slot's PV feed-in cap is a separate, cloud-owned command, and
    // freezing it here would let a curtailment outlive its slot. So it rides
    // along as an ORDINARY write - gated by the ordinary control gate, never by
    // the certificate, and therefore deliberately outside `planned` (which is
    // what the certificate attests byte for byte).
    const pvKw = isFiniteNum(opts.pvLimitKw) && opts.pvLimitKw >= 0 ? opts.pvLimitKw : null;
    const pvRaw = pvKw == null ? NO_PV_LIMIT : Math.max(0, Math.round(pvKw * 100)) & 0xffff;
    return {
      adapter: 'modbus_tcp', target: ip + ':' + port,
      connection: { ip, port, unit_id: unitId },
      planned,
      readbacks: [
        { role: 'control_enable', fc: 3, addr: SUNSPEC_REG.ENABLE, expect: 0, tolerance: 0 },
        { role: 'battery_power', fc: 3, addr: SUNSPEC_REG.SETPOINT, expect: 0, tolerance: 1 },
      ],
      extraWrites: [{ role: 'pv_limit', fc: 6, addr: SUNSPEC_REG.PVLIMIT, value: pvRaw,
        encode: { kind: 'pv_limit_x100_u16', scale: 100, sentinel: NO_PV_LIMIT, kw: pvKw }, dwell_s: 0, min_change: 0 }],
      extraReadbacks: [{ role: 'pv_limit', fc: 3, addr: SUNSPEC_REG.PVLIMIT, expect: pvRaw, tolerance: 1 }],
      observations: [],
      // The compact profile carries no charging-source register, so an EEG site
      // is refused rather than assumed safe.
      gridChargeProof: null,
    };
  }
  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_FRONIUS) {
    const port = Number(conn.control_port) > 0 ? Number(conn.control_port) : DEFAULT_FRONIUS_CONTROL_PORT;
    const unitId = Number(conn.control_unit_id) > 0 ? Number(conn.control_unit_id) : 1;
    const discovery = opts.sunspec || null;
    // planStorage(0) IS the native primitive on Model 124: its own comment says
    // "idle (0 kW) sets NONE = release control -> the inverter self-consumes".
    // We reuse it verbatim rather than re-deriving the addresses - the bases are
    // DISCOVERED live and must never be fabricated.
    const storage = sunspec.planStorage({ discovery, batterySetpointKw: 0 });
    if (!storage.ok) {
      return {
        unsupported: true, adapter: 'fronius_sunspec',
        reason: 'Fronius SunSpec: ' + storage.reason,
      };
    }
    const s = discovery && discovery.storage ? discovery.storage : null;
    return {
      adapter: 'fronius_sunspec', target: ip + ':' + port,
      connection: { ip, port, unit_id: unitId },
      planned: storage.writes.map((w) => ({ ...w, bench_pending: true })),
      readbacks: storage.readbacks.map((r) => ({ ...r })),
      observations: [],
      // ChaGriSet is the vendor's own grid-charge gate; PV (0) is the readable
      // proof. It is AND-ed with a web-UI setting, so the bench has to confirm
      // the pair - the certificate is what states it was confirmed.
      gridChargeProof: s && s.chaGriSetAddr != null
        ? { role: 'grid_charge_gate', fc: 3, addr: s.chaGriSetAddr, expect: 0, tolerance: 0 }
        : null,
    };
  }
  if (tier === CONTROL_TIER.SUNSPEC && comm === COMM_KACO_MODBUS) {
    const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
    const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
    // 41104 = 2 ("Eigenverbrauch") is the documented self-consumption mode. It is
    // also this family's ONLY failsafe (no watchdog register is documented), so
    // the native mode and the safe state are literally the same write here.
    const planned = [{
      role: 'work_mode', fc: 6, addr: KACO_NH3_CONTROL_REG.MODE,
      value: KACO_NH3_CONTROL_REG.MODE_SELF_CONSUMPTION,
      encode: { kind: 'enum', native: true }, dwell_s: 0, min_change: 0, bench_pending: true,
    }];
    return {
      adapter: 'kaco_nh3', target: ip + ':' + port,
      connection: { ip, port, unit_id: unitId },
      planned,
      readbacks: [{ role: 'work_mode', fc: 3, addr: KACO_NH3_CONTROL_REG.MODE,
        expect: KACO_NH3_CONTROL_REG.MODE_SELF_CONSUMPTION, tolerance: 0 }],
      observations: [],
      // AISWEI documents no charging-source register, so no EEG proof exists.
      gridChargeProof: null,
    };
  }
  if (tier === CONTROL_TIER.SUNSPEC && (comm === COMM_SUNSPEC_TCP || comm === COMM_KACO_HTTP)) {
    return {
      unsupported: true, adapter: comm === COMM_KACO_HTTP ? 'kaco_http' : 'kaco_sunspec',
      reason: 'ohne Batterie gibt es keine Wechselrichter-Automatik',
    };
  }
  return null;
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
 * It keys on a REAL mismatch (allMatch === false), never on an UNCONFIRMED cycle
 * (allMatch === null - the inverter did not answer the readback; readback-verify.js).
 * Accusing a second controller over a read that never arrived is exactly the false
 * alarm the flap fix removes.
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
  if (facts.allMatch === false) {
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

// --- KACO control adapters (UNCERTIFIED - PREPARED and LOCKED) ---------------
//
// SAFETY (der ganze Punkt dieser Stufe): KACO steht in KEINER der beiden
// Freigabelisten. Diese Adapter geben NIEMALS einen ausfuehrbaren Schreibbefehl
// heraus (`writes: []`) und erfinden NIEMALS ein Rueckleseregister
// (`readbacks: []`). Was sie liefern, ist der `planned`-Satz - das konkrete
// Artefakt, das eine Bench-Sitzung am echten Geraet prueft (CONTROL-BENCH.md).
//
// ⚠ SIE SIND HAERTER GESPERRT ALS DIE FREIGABELISTE: `writes` bleibt leer
// UNABHAENGIG von `certified`. Ein First-Light-Grant am Geraet - der bei Fronius
// den Schreibweg oeffnet - reicht hier NICHT, weil an keinem KACO je etwas
// gemessen wurde. Die Sperre faellt erst, wenn diese Zeilen bewusst geaendert
// werden, nicht durch einen Klick.

const KACO_NOT_CERTIFIED_REASON = 'Steuerung für dieses Modell noch nicht freigegeben (Prüfstand ausstehend)';

// kacoSunspecControl - die WIRKLEISTUNGSBEGRENZUNG der KACO-eigenen Linie
// (blueplanet TL1/TL3, Powador TL3, NX3 M8/M10) ueber SunSpec **Model 123**.
//
// QUELLE (Fakten, kein Code): KACO dokumentiert das SELBST - App Note
// „blueplanet 100-125 NX3" §2.3.1 mit dem Beispiel 40295 (`WMaxLimPct`) / 40299
// (`WMaxLim_Ena`), und das Handbuch 87.0 TL3 §10.4.1 sagt: „P-Limit ist nur
// ueber das MODBUS/SunSpec-Wechselrichtermodell 123 WMaxLimPct und per
// RS485-Kommunikation verfuegbar." Das ist dasselbe Primitiv, das der
// Fronius-Adapter faehrt - deshalb wird `sunspec.planCurtailment` GETEILT statt
// nachgebaut, und die Adressen kommen aus dem LIVE-Discovery-Walk, nie aus einer
// erfundenen Konstante.
//
// ⚠ ZWEI KACO-EIGENE VORBEHALTE, die die Bench klaeren muss:
//   1. **Die Schreib-FORM.** KACOs Beispiel schreibt die zwei Register EINZELN
//      (FC6); Fronius verlangt den geschlossenen FC16-Block (an einer echten
//      Anlage am 09.08.2026 gemessen). Der Ausweg dafuer existiert schon als
//      Verbindungsfeld `curtail_write_fc` - er wird hier durchgereicht.
//   2. **Die Firmware.** Der Schreibzugriff ist ein EIGENER Menuepunkt am Geraet
//      und existiert erst ab Paket V4.00; ein Geraet mit V3.x liest Model 123,
//      nimmt aber keinen Schreibbefehl an. Ohne die Modell-1-`Version` des
//      Geraets ist das nicht entscheidbar - also wird es NICHT entschieden.
function kacoSunspecControl({ conn, ip, family, certified, controlEnabled, pvLimitKw, opts }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
  const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
  const discovery = (opts && opts.sunspec) || null;
  const plan = sunspec.planCurtailment({
    discovery,
    pvLimitKw,
    nameplateKw: opts && opts.nameplateKw,
    wMaxLimPctSf: opts && opts.wMaxLimPctSf,
    rvrtTms: opts && opts.rvrtTms,
  });
  const planned = plan.ok ? plan.writes.map((w) => ({ ...w, bench_pending: true })) : [];
  return {
    adapter: 'kaco_sunspec', family, tier: CONTROL_TIER.SUNSPEC,
    target: ip + ':' + port,
    connection: { ip, port, unit_id: unitId, curtail_write_fc: Number(conn.curtail_write_fc) || 0 },
    certified,
    controlEnabled,
    writes: [], // gesperrt - siehe der Kopf dieses Abschnitts
    readbacks: [],
    planned,
    reason: planned.length > 0
      ? KACO_NOT_CERTIFIED_REASON
      : 'KACO SunSpec: ' + plan.reason + ' (Steuerung nicht freigegeben)',
  };
}

// KACO_NH3_CONTROL_REG - die BATTERIE-Steuerregister des hybriden NH3, aus der
// AISWEI-Registerkarte `MB001_ASW GEN-Modbus` §3.3 (Holding, Doku-Nummern).
//
// QUELLE (Fakten, kein Code): dieselbe OEM-Doku, aus der der Lesepfad kommt,
// und evccs produktives `solplanet-modbus`-Template, das fuer die ASW-TH-Serie
// und ausdruecklich „KACO Blueplanet Hybrid NH3" die Faehigkeit
// `battery-control` fuehrt. Die Adressen sind belegt, an EINEM KACO gemessen
// hat sie niemand von uns.
const KACO_NH3_CONTROL_REG = {
  // 41104: Betriebsmodus. 1 = Aus, 2 = Eigenverbrauch, 3 = Backup,
  // 4 = „Customer defined" - nur in 4 gilt der Sollwert unten.
  MODE: 41104,
  MODE_SELF_CONSUMPTION: 2,
  MODE_CUSTOMER: 4,
  // 41152: Lade-/Entlade-Flag (1 Stop, 2 Laden, 3 Entladen).
  FLAG: 41152,
  FLAG_STOP: 1,
  FLAG_CHARGE: 2,
  FLAG_DISCHARGE: 3,
  // 41153: Lade-/Entladeleistung, S16 in W. ⚠ AISWEI-Vorzeichen:
  // **- laden / + entladen** - die UMKEHRUNG von VoltPilots Konvention.
  POWER_W: 41153,
  // 41154/41155: SoC-Ober-/Untergrenze (x 0,01 %).
  SOC_MAX: 41154,
  SOC_MIN: 41155,
};

// kacoNh3Control - der vorbereitete, GESPERRTE Batterie-Schreibweg des NH3.
//
// ⚠ ES GIBT KEIN TOTMANN-REGISTER. In MB001 ist keines dokumentiert - anders
// als bei Deyes Fernsteuerung (1101) oder KOSTALs eigenem Watchdog. Ein
// Sollwert, den wir setzen, bleibt also stehen, bis ihn jemand aendert. Der
// Failsafe muss deshalb UNSER Failsafe sein: laufend re-assertieren und bei
// Stille 41104 aktiv auf 2 (Eigenverbrauch) zuruecksetzen - genau das Muster,
// das der Shelly- und der go-e-Executor fahren. Das ist eine BENCH-PFLICHT,
// keine Annahme: bevor hier je ein Schreibbefehl herausgeht, muss am Geraet
// bewiesen sein, dass die Ruecknahme wirkt.
function kacoNh3Control({ conn, ip, family, certified, controlEnabled, kw, setpoint }) {
  const port = Number(conn.port) > 0 ? Number(conn.port) : 502;
  const unitId = Number(conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
  const invert = conn.invert_control_sign === true;
  const battKw = isFiniteNum(kw) ? (invert ? -kw : kw) : 0;
  // VoltPilot: + = laden. AISWEI: - = laden. Also NEGIEREN.
  const watts = Math.round(-battKw * 1000);
  const flag = battKw > 0 ? KACO_NH3_CONTROL_REG.FLAG_CHARGE
    : (battKw < 0 ? KACO_NH3_CONTROL_REG.FLAG_DISCHARGE : KACO_NH3_CONTROL_REG.FLAG_STOP);
  const sp = setpoint || {};
  const socMin = isFiniteNum(sp.soc_min_pct) ? sp.soc_min_pct : 5;
  const socMax = isFiniteNum(sp.soc_max_pct) ? sp.soc_max_pct : 95;

  const planned = [
    { role: 'work_mode', fc: 6, addr: KACO_NH3_CONTROL_REG.MODE, value: KACO_NH3_CONTROL_REG.MODE_CUSTOMER, encode: { kind: 'enum' }, dwell_s: 0, min_change: 0, bench_pending: true },
    { role: 'battery_flag', fc: 6, addr: KACO_NH3_CONTROL_REG.FLAG, value: flag, encode: { kind: 'enum' }, dwell_s: 0, min_change: 0, bench_pending: true },
    { role: 'battery_power', fc: 6, addr: KACO_NH3_CONTROL_REG.POWER_W, value: watts, encode: { kind: 'watts_s16_inverted', kw: battKw }, dwell_s: 0, min_change: 0, bench_pending: true },
    { role: 'battery_soc_max', fc: 6, addr: KACO_NH3_CONTROL_REG.SOC_MAX, value: Math.round(socMax * 100), encode: { kind: 'pct_x100' }, dwell_s: 0, min_change: 0, bench_pending: true },
    { role: 'battery_soc_min', fc: 6, addr: KACO_NH3_CONTROL_REG.SOC_MIN, value: Math.round(socMin * 100), encode: { kind: 'pct_x100' }, dwell_s: 0, min_change: 0, bench_pending: true },
  ];

  return {
    adapter: 'kaco_nh3', family, tier: CONTROL_TIER.SUNSPEC,
    target: ip + ':' + port,
    connection: { ip, port, unit_id: unitId },
    certified,
    controlEnabled,
    writes: [], // gesperrt - siehe der Kopf dieses Abschnitts
    readbacks: [],
    planned,
    reason: KACO_NOT_CERTIFIED_REASON,
  };
}

// kacoNh3Release - die Ruecknahme: zurueck auf Eigenverbrauch (41104 = 2) und
// den Sollwert auf 0. Sie ist der Failsafe, den es ohne Totmann-Register am
// Geraet braucht - und deshalb steht sie hier, obwohl noch nichts schreibt.
function kacoNh3ReleasePlan() {
  return [
    { role: 'work_mode', fc: 6, addr: KACO_NH3_CONTROL_REG.MODE, value: KACO_NH3_CONTROL_REG.MODE_SELF_CONSUMPTION, encode: { kind: 'enum' }, dwell_s: 0, min_change: 0, bench_pending: true },
    { role: 'battery_flag', fc: 6, addr: KACO_NH3_CONTROL_REG.FLAG, value: KACO_NH3_CONTROL_REG.FLAG_STOP, encode: { kind: 'enum' }, dwell_s: 0, min_change: 0, bench_pending: true },
    { role: 'battery_power', fc: 6, addr: KACO_NH3_CONTROL_REG.POWER_W, value: 0, encode: { kind: 'watts_s16_inverted', kw: 0 }, dwell_s: 0, min_change: 0, bench_pending: true },
  ];
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
// bit0 of that register is the ENABLE itself; the bits above it are the weekdays.
const DEYE_TOU_ENABLE_BIT = 0x0001;
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
// kW verbatim and never widens it. The battery-side STRATEGY (1105) is selectable and
// DEFAULTS to 2 (Power) - the signed setpoint (1109) is the ONLY thing the inverter is
// told, no on-device SoC target. The Power+SOC strategy (5) + the 1108 SoC belt is
// OPT-IN (connection.remote_battery_strategy = 5): on the live SUN-30K-SG01HP3-EU with
// the battery at 100 % SoC and 1108 = 5 %, a commanded -1,0 kW discharge (every register
// echoed) delivered ~-8,0 kW - the inverter drove TOWARD the 1108 % as a TARGET, not as
// a floor, so the power value was not the binding rate. Strategy 2 tells it only the
// setpoint; guards.Clamp remains the SoC authority (it clamps charge to 0 at/above
// SocMax and discharge to 0 at/below SocMin, re-evaluated every tick).
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
// The register layout `classifyDeyeCapability` names when the block is the PR #978
// one (mode selector 1104, strategy 1105, SIGNED power setpoint 1109) - the ONLY
// layout this adapter writes, and therefore the only one whose firmware may key a
// native-mode certificate.
const DEYE_REMOTE_LAYOUT_PR978 = 'pr978';
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
// How often the remote-mode CONFIGURATION registers (battery-side selector 1104,
// strategy 1105, the opt-in SoC belt 1108) are re-asserted when nothing changed.
// They are ALSO re-written immediately whenever a readback shows one of them not
// held, so this is the drift backstop, not the primary self-heal. 300 s = 30 ticks
// of the ~10 s setpoint cadence.
const DEYE_REMOTE_CFG_REASSERT_S = 300;

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

// A plausible watchdog register: the documented "off" sentinel (the FACTORY-FRESH
// state) or a real [10,18000] s timeout - which is what a device WE have already
// driven holds (the remote path writes 60 there), so a once-controlled inverter
// re-classifies as remote-capable after every restart exactly like a fresh one.
// An all-zero block never reaches this check (classified as the unreachable-logger
// stub above it, transient); a garbage value here still fails the shape.
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
  // An ALL-ZERO block is the documented Solarman-logger STUB for "the inverter did
  // not answer on the RS485 side right now" (the same well-framed zero answer that
  // fabricated soc_pct=0 - see deye-decode socPlausible), NOT evidence about the
  // firmware: a real remote-capable block is never all-zero (1101 is 0xFFFF
  // factory-fresh and [10,18000] once driven), and the observed remote-LESS
  // firmwares answer their own register values (the Akkudoktor LV reads 0x0500 in
  // 1100) or a Modbus exception. Before this rule an unreachable-moment stub was
  // classified "Firmware ohne Fernsteuerung" (DEFINITIVE, cached 6 h) - the exact
  // restart-window failure that flipped the certified Pilsting pilot from remote
  // mode to EEPROM ToU writes (live regression 2026-07-28). Transient -> re-probe.
  let allZero = true;
  for (let i = 0; i < 22; i++) { if ((block[i] & 0xffff) !== 0) { allZero = false; break; } }
  if (allZero) {
    out.definitive = false;
    out.reason = 'Wechselrichter über den Logger gerade nicht erreichbar (Null-Antwort auf die '
      + 'Fähigkeitsprüfung) - erneuter Versuch folgt';
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
    out.present = true; out.layout = DEYE_REMOTE_LAYOUT_PR978; out.supported = true; out.path = DEYE_PATH_REMOTE;
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

// --- STICKY control-path decision (live regression + flap, Pilsting 2026-07-28) --
//
// The control path is a DURABLE property of the device's firmware, not of the last
// probe read - so it is DECIDED ONCE and changed only on sustained contrary
// evidence or an operator action, never per tick. Before this, the path was
// re-derived from the newest raw probe result each tick: a restart wiped the
// volatile cache, the restart-window probe hit a degenerate answer (the logger's
// all-zero unreachable stub, or a transient gateway exception 0x0B regex-matched
// as "Ausnahme" = definitive), the verdict was cached as "Firmware ohne
// Fernsteuerung" and the certified pilot silently swapped RAM remote control for
// EEPROM ToU writes that fought the inverter (max_sell_power 0 vs. installer
// 7182) - and when probe results alternated, the :8484 card flapped between
// "bestätigt" and "Steuerung kann nicht ausgeführt werden" every ~10 s tick.
//
// The decision record (persisted per logger in the DURABLE 'file' flow context by
// the executor; the plan node only reads it):
//   { path: 'remote'|'tou', since, contrary, everRemote, verdict, verdictAt }
//     - path       the DECIDED control path (what the plan node plans)
//     - contrary   consecutive DEFINITIVE verdicts that disagree with `path`
//     - everRemote true once remote mode was ever definitively seen (or proven by
//                  a landed remote write / the core's device_certified_path grant)
//     - verdict    the last DEFINITIVE classify output (carries scaleClass/layout)
//
// HYSTERESIS: a decided path flips only after DEYE_PATH_CONTRARY_N consecutive
// definitive contrary verdicts. A FAILED/unreachable probe (definitive:false) is
// NOT evidence - it neither flips the path nor advances the counter; the executor
// just retries on a bounded cadence. Operator actions bypass the hysteresis:
// connection.remote_mode='off' forces ToU immediately (handled at the dispatch,
// not in this record).
const DEYE_PATH_CONTRARY_N = 3;

/**
 * deyeUpdateSticky - PURE decision update from a fresh probe verdict. Returns the
 * next record (the SAME object when nothing changed, so callers can `!==`-check
 * before persisting). A transient verdict (definitive === false) is no evidence.
 */
function deyeUpdateSticky(prev, verdict, nowMs) {
  const p = (prev && typeof prev === 'object') ? prev : null;
  if (!verdict || verdict.definitive === false) return p;
  const vPath = deyeControlPath(verdict);
  const everRemote = (p && p.everRemote === true) || vPath === DEYE_PATH_REMOTE;
  if (!p || (p.path !== DEYE_PATH_REMOTE && p.path !== DEYE_PATH_TOU)) {
    // First definitive answer decides immediately (commissioning stays one probe).
    return { path: vPath, since: nowMs, contrary: 0, everRemote, verdict, verdictAt: nowMs };
  }
  if (vPath === p.path) {
    return { path: p.path, since: p.since, contrary: 0, everRemote, verdict, verdictAt: nowMs };
  }
  const contrary = (Number(p.contrary) || 0) + 1;
  if (contrary >= DEYE_PATH_CONTRARY_N) {
    return { path: vPath, since: nowMs, contrary: 0, everRemote, verdict, verdictAt: nowMs };
  }
  return { path: p.path, since: p.since, contrary, everRemote, verdict, verdictAt: nowMs };
}

/**
 * deyeSeedStickyFromGrant - a fresh volume/context has no decision record, but the
 * CORE's First-Light grant may carry the path the certification was PROVEN on
 * (setpoint.device_certified_path, persisted with the grant in
 * calibration-certified.json). A remote-proven grant seeds the decision, so a
 * certified pilot plans its proven path from the very first post-restart tick
 * instead of falling back to ToU until a probe answers. Returns null when the
 * grant carries no path (older core, ToU grant handled by the normal decision).
 */
function deyeSeedStickyFromGrant(setpoint, nowMs) {
  if (setpoint && setpoint.device_certified === true
    && setpoint.device_certified_path === DEYE_PATH_REMOTE) {
    return { path: DEYE_PATH_REMOTE, since: nowMs, contrary: 0, everRemote: true, seededFromGrant: true };
  }
  return null;
}

/**
 * deyeEffectiveCap - the capability the adapters plan by, honoring the STICKY
 * decision: a decided path always wins over a raw per-tick verdict (a contrary
 * verdict inside the hysteresis window, or a transient failure, must not flip the
 * plan). Without a decision the raw cap passes through (legacy behaviour). When
 * the sticky record has no usable verdict object a minimal one is synthesized so
 * the dispatch + release still select the decided path (marked sticky:true).
 */
function deyeEffectiveCap(cap, sticky) {
  const s = (sticky && typeof sticky === 'object') ? sticky : null;
  if (!s || (s.path !== DEYE_PATH_REMOTE && s.path !== DEYE_PATH_TOU)) return cap || null;
  if (cap && cap.definitive !== false && deyeControlPath(cap) === s.path) return cap;
  if (s.verdict && deyeControlPath(s.verdict) === s.path) return s.verdict;
  const scaleClass = (cap && (cap.scaleClass === 1 || cap.scaleClass === 10)) ? cap.scaleClass
    : ((s.verdict && (s.verdict.scaleClass === 1 || s.verdict.scaleClass === 10)) ? s.verdict.scaleClass : null);
  if (s.path === DEYE_PATH_REMOTE) {
    return {
      present: true, supported: true, path: DEYE_PATH_REMOTE,
      layout: (s.verdict && s.verdict.layout) || DEYE_REMOTE_LAYOUT_PR978, scaleClass,
      definitive: true, sticky: true,
      reason: 'Fernsteuerung (Remote Mode) - nachgewiesener Steuerpfad dieses Geräts',
    };
  }
  return {
    present: false, supported: false, path: DEYE_PATH_TOU, layout: null, scaleClass,
    definitive: true, sticky: true,
    reason: 'Zeitfenster-Steuerung (ToU) - entschiedener Steuerpfad dieses Geräts',
  };
}

/**
 * deyeProbeErrorDefinitive - is a probe-read FAILURE a definitive "this register
 * block is not implemented" answer? ONLY the Modbus exceptions that indict the
 * REQUEST are: 0x01 illegal function / 0x02 illegal data address / 0x03 illegal
 * data value. Everything else - transport errors, timeouts and crucially the
 * GATEWAY exceptions 0x0A/0x0B (the Solarman logger answered but the inverter
 * behind it did not) - says nothing about the firmware and must be retried. The
 * executor's old `/Ausnahme|exception/i` regex matched a transient 0x0B
 * ("Wechselrichter hat nicht geantwortet") as the definitive absent verdict and
 * cached ToU for 6 h - half of the live Pilsting path flip.
 */
function deyeProbeErrorDefinitive(message) {
  return /Modbus-Ausnahme 0x0[123]\b/i.test(String(message || ''));
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
 * resolveDeyeRemoteStrategy - which battery-side strategy (register 1105) the remote
 * path arms. The DEFAULT is POWER (2): the signed power setpoint (1109) is the ONLY
 * thing the inverter is told, with NO on-device SoC target in 1108. POWER_SOC (5) +
 * the 1108 SoC belt is OPT-IN via connection.remote_battery_strategy = 5.
 *
 * WHY THE DEFAULT FLIPPED TO 2 (live SUN-30K-SG01HP3-EU, 2026-07-27): with strategy 5
 * and 1108 = 5 % armed on a battery at 100 % SoC, a commanded -1,0 kW discharge (33
 * units, echoed on every register) delivered ~-8,0 kW - the inverter drove TOWARD the
 * 1108 % as a TARGET (roughly rate-limited), not as a floor, so our power value was not
 * the binding rate. Strategy 2 tells the inverter only the setpoint, removing that
 * failure mode. guards.Clamp's SoC band is the SoC authority on BOTH strategies (it
 * clamps a commanded charge to 0 at/above SocMax and a discharge to 0 at/below SocMin,
 * re-evaluated every tick); strategy 5 is a re-testable on-device SECOND belt, not the
 * default. Absent / anything but 5 -> POWER (2).
 */
function resolveDeyeRemoteStrategy(conn) {
  const v = Number(conn && conn.remote_battery_strategy);
  return v === DEYE_BATTERY_STRATEGY.POWER_SOC ? DEYE_BATTERY_STRATEGY.POWER_SOC : DEYE_BATTERY_STRATEGY.POWER;
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
 *   3. 1105 <- 2 (Power) by DEFAULT; 5 (Power+SOC) only when the operator opts in via
 *              connection.remote_battery_strategy = 5 AND a belt value is known
 *   4. 1108 <- the SoC belt       an independent ON-DEVICE second belt, STRATEGY 5 ONLY
 *              (omitted entirely on the default Power strategy - the setpoint is the
 *              only instruction; see resolveDeyeRemoteStrategy + the DEYE_REMOTE_REG
 *              header for why the live SUN-30K read 1108 as a target, not a floor)
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
    // remote_mode rides the CONNECTION because the executor needs it: its
    // probe-vs-plan interlock must reach the same verdict the plan node did, and
    // without this an operator's force-ToU setting would make the two disagree
    // forever (the plan says 'tou', the probe says 'remote' -> skip every tick).
    connection: { ip, port, serial, mb_slave_id: slaveId, remote_mode: 'auto' },
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
  // a scale error, i.e. exactly the N1 class of bug this PR also fixes). `blocked`
  // marks this as an empty plan caused by a MISCONFIGURATION the operator can fix
  // (as opposed to the routine read-only/kill-switch quiet cases) - the executor
  // surfaces it via node.warn + the :8484 card so it is never silent (Defect 2).
  if (!(ratedKw > 0)) {
    return Object.assign(base, {
      writes: [], readbacks: [], planned: [],
      blocked: true,
      reason: 'Fernsteuerung: Nennleistung des Modells unbekannt - bitte das genaue '
        + 'Wechselrichter-Modell auswählen (der Sollwert ist 0,1 % der Nennleistung).',
    });
  }

  const sp = deyeRemoteSetpointUnits(battKw, ratedKw);
  // The battery-side strategy (register 1105) is SELECTABLE and DEFAULTS to POWER (2):
  // the signed setpoint (1109) is the ONLY thing the inverter is told, with NO 1108 SoC
  // target. The Power+SOC strategy (5) + the on-device SoC belt in 1108 is OPT-IN
  // (connection.remote_battery_strategy = 5), because on the live SUN-30K-SG01HP3-EU it
  // was read as a TARGET, not a floor - the battery drove toward the 1108 % and delivered
  // ~8x the commanded power (see resolveDeyeRemoteStrategy + the DEYE_REMOTE_REG header).
  // guards.Clamp upstream owns the SoC band absolutely EITHER WAY (report §7, claim 17):
  // it clamps a commanded charge to 0 at/above SocMax and a discharge to 0 at/below
  // SocMin, so dropping the on-device belt never removes SoC protection - it removes an
  // on-device TARGET the firmware mishandled. When strategy 5 is chosen, the belt's
  // direction picks which end of the band it is: a charge is bounded by the ceiling, a
  // discharge by the floor; with no belt value known it falls back to plain Power.
  const strategyPref = resolveDeyeRemoteStrategy(conn); // POWER (2, default) or POWER_SOC (5)
  const charging = battKw > 0;
  const socMin = isFiniteNum(setpoint.soc_min_pct) ? clampPct(setpoint.soc_min_pct) : null;
  const socMax = isFiniteNum(setpoint.soc_max_pct) ? clampPct(setpoint.soc_max_pct) : null;
  const beltValue = charging ? socMax : socMin;
  const belt = strategyPref === DEYE_BATTERY_STRATEGY.POWER_SOC && beltValue != null ? beltValue : null;
  const strategy = belt == null ? DEYE_BATTERY_STRATEGY.POWER : DEYE_BATTERY_STRATEGY.POWER_SOC;
  // RAM registers: no dwell, no min_change. `always` makes the executor bypass its
  // EEPROM write-on-change filter, and it is carried by exactly the three ops that
  // MUST be re-asserted on every ~10 s tick:
  //   - the watchdog (the write IS the dead-man's-switch kick),
  //   - the setpoint (the command itself),
  //   - the enable (so a watchdog expiry self-heals within one tick).
  // The two pure CONFIGURATION ops (battery-side selector + strategy, and the
  // opt-in SoC belt) do not need a per-tick re-write: they are re-asserted every
  // `reassert_s` and IMMEDIATELY whenever a readback shows them not held (the
  // executor invalidates their write-cache entry). This is not about EEPROM wear -
  // 1100-1121 is RAM - it is about the Solarman logger's SINGLE socket: every
  // avoided write is socket time the read poll (and the readback itself) gets back,
  // and a starved/interrupted read is what produced the false "not adopted" alarms.
  const ram = { dwell_s: 0, min_change: 0, always: true, bench_pending: true };
  const ramCfg = { dwell_s: 0, min_change: 0, reassert_s: DEYE_REMOTE_CFG_REASSERT_S, bench_pending: true };

  const planned = [];
  // 1) FAILSAFE FIRST.
  planned.push({
    role: 'remote_watchdog', fc: writeFc, addr: DEYE_REMOTE_REG.watchdog, value: watchdogS & 0xffff,
    encode: { kind: 'remote_watchdog_s', seconds: watchdogS }, ...ram,
  });
  // 2) BATTERY-side control (PV production keeps running untouched). Configuration:
  //    re-asserted periodically + on demand, not on every tick (see `ramCfg`).
  planned.push({
    role: 'power_control_mode', fc: writeFc, addr: DEYE_REMOTE_REG.powerControlMode,
    value: DEYE_POWER_CONTROL_MODE.BATTERY_SIDE,
    encode: { kind: 'remote_power_control_mode', enum: 'battery_side' }, ...ramCfg,
  });
  // 3) strategy: Power+SOC when a belt exists, else Power.
  planned.push({
    role: 'battery_strategy', fc: writeFc, addr: DEYE_REMOTE_REG.batteryStrategy, value: strategy,
    encode: { kind: 'remote_battery_strategy', enum: strategy === DEYE_BATTERY_STRATEGY.POWER_SOC ? 'power_soc' : 'power' }, ...ramCfg,
  });
  // 4) the on-device SoC belt (strategy 5 only).
  if (belt != null) {
    planned.push({
      role: 'battery_soc_belt', fc: writeFc, addr: DEYE_REMOTE_REG.constantSoc, value: belt,
      encode: { kind: 'pct', direction: charging ? 'charge_ceiling' : 'discharge_floor' }, ...ramCfg,
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
function deyeControl({ conn, ip, family, certified, controlEnabled, calibration, kw, pvLimitKw, setpoint, opts, cap, sticky }) {
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
  const remoteModeCfg = (conn.remote_mode === 'off' || conn.remote_mode === false) ? 'off' : 'auto';
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
      // See deyeRemoteControl: the executor's interlock reads remote_mode from here.
      connection: { ip, port, serial, mb_slave_id: slaveId, remote_mode: remoteModeCfg },
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

  // THE DELIBERATE-FALLBACK GATE (live regression 2026-07-28, Pilsting). The ToU
  // path writes INSTALLER EEPROM registers, so on a device that MAY be written
  // (family-certified or First-Light-granted, kill-switch on) it may only engage
  // DELIBERATELY:
  //   - the operator forced it (connection.remote_mode = 'off'), or
  //   - this is a bounded, operator-armed First-Light calibration test, or
  //   - the capability check DEFINITIVELY answered "no remote mode" (a decided
  //     sticky ToU path, or a definitive raw verdict) AND the device was never
  //     proven remote-capable.
  // A FAILED/unreachable probe is NOT an answer, and a device once PROVEN on the
  // remote path (sticky everRemote, or the core's device_certified_path grant)
  // must never silently swap RAM remote control for EEPROM ToU control: the
  // First-Light evidence gate certified REMOTE behaviour - its meaning does not
  // transfer to a different write surface. Hold off LOUDLY instead; the executor
  // keeps probing and the next definitive remote answer resumes the proven path.
  // This gate only ever NARROWS: an uncertified device already had writes:[] and
  // keeps its own reason; nothing here widens any allowlist or bypass.
  if (writeAllowed && !calibration && remoteModeCfg !== 'off') {
    const grantRemote = setpoint.device_certified_path === DEYE_PATH_REMOTE;
    const everRemote = grantRemote || !!(sticky && sticky.everRemote === true);
    const definitiveTou = !!(cap && cap.definitive !== false && deyeControlPath(cap) === DEYE_PATH_TOU);
    if (everRemote) {
      return finalize([], {
        blocked: true, pathHold: 'remote_proven',
        reason: 'Fernsteuerung (Remote Mode) ist für dieses Gerät nachgewiesen, wird aber gerade '
          + 'nicht bestätigt. Die Zeitfenster-Steuerung (EEPROM) wird nicht automatisch aktiviert - '
          + 'die Fähigkeitsprüfung läuft weiter und die Fernsteuerung wird wieder aufgenommen, '
          + 'sobald sie antwortet. (Zeitfenster erzwingen: remote_mode auf "off" setzen oder neu kalibrieren.)',
      });
    }
    if (!definitiveTou) {
      return finalize([], {
        blocked: true, pathHold: 'unconfirmed',
        reason: 'Steuerpfad noch unbestätigt: die Fähigkeitsprüfung (Fernsteuerung vs. Zeitfenster) '
          + 'hat noch keine eindeutige Antwort vom Wechselrichter. Es wird nichts geschrieben, '
          + 'bis der Pfad feststeht.',
      });
    }
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
      // A misconfiguration the operator must fix (the HV/LV scale) - surfaced, not
      // silent (Defect 2); see the `blocked` note in deyeRemoteControl.
      blocked: true,
      reason: 'Leistungsskalierung unbestätigt (HV/LV): Der Schreibplan wird zurückgehalten, '
        + 'damit ein HV-Wechselrichter nicht 10-fach überschrieben wird. Bitte die '
        + 'Leistungsskalierung am Wechselrichter setzen (HV = 10, LV = 1) oder das Gerät '
        + 'erreichbar machen, damit sie automatisch erkannt wird.',
    });
  }

  const slot = DEYE_CONTROL_SLOT;
  const battKw = invert ? -kw : kw;
  const charging = battKw > 0;
  // An IDLE slot (0 kW) is NEITHER a charge NOR a discharge: it must not arm the
  // export-forcing levers. The old `!charging` branches treated idle as a
  // "discharge at 0 W" and wrote max_sell_power = 0 + Solar-Sell ON - forbidding
  // ALL selling, which collides with the inverter's own solar-sell logic: the live
  // Pilsting device kept restoring its installer value (7182) over our 0 and the
  // conflict warning fired on every readback. Idle now RESTORES max_sell_power
  // from the pre-control snapshot (the #247 snapshot discipline: never leave an
  // installer value overwritten) and leaves Solar-Sell alone; the slot's
  // Program-Power cap of 0 is what keeps the battery still.
  const discharging = battKw < 0;
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
  // 3) Solar-Sell: ON for a DISCHARGE only (enable surplus/battery export - without
  //    an export path a "discharge to grid" has nowhere to go but the battery). A
  //    CHARGE and an IDLE slot leave it to the snapshot restore, so we never latch
  //    export-on (or fight the inverter's own solar-sell logic) outside a discharge.
  if (discharging) {
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
  //    = X so the battery actually exports at the commanded rate. CHARGE and IDLE ->
  //    RESTORE it to the installer's pre-control value from the snapshot, so an
  //    earlier discharge's export cap never latches - and an idle slot never writes
  //    the 0 the inverter's own solar-sell logic fights (the live 0-vs-7182 loop).
  //    No snapshot yet (the very first tick) -> omit; the executor snapshots BEFORE
  //    writing, so the next tick restores.
  if (discharging) {
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
  COMM_KOSTAL,
  COMM_SUNSPEC_TCP,
  COMM_KACO_MODBUS,
  COMM_KACO_HTTP,
  // KACO: vorbereitet + GESPERRT (writes bleibt leer, unabhaengig von certified)
  KACO_NH3_CONTROL_REG,
  KACO_NOT_CERTIFIED_REASON,
  // KOSTAL PLENTICORE Tier-2 (external battery management)
  KOSTAL_REG,
  KOSTAL_MGMT_EXTERNAL_MODBUS,
  KOSTAL_DEFAULT_PORT,
  KOSTAL_DEFAULT_UNIT_ID,
  KOSTAL_MGMT_GATE_REASON,
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
  // The ENABLE bit of the Time-of-Use register (bit 0; the bits above it are the
  // weekdays). Exported because the flow's native planner takes this fact
  // STRAIGHT from here rather than retyping it - the same discipline as the
  // register maps (build-flows.js).
  DEYE_TOU_ENABLE_BIT,
  DEYE_CONTROL_SLOT,
  CERTIFIED_CONTROL_FAMILIES,
  SETPOINT_STALE_MS,
  DEYE_WRITE_FC_FC16,
  DEYE_WRITE_FC_FC6,
  // Deye remote mode (Tier 2, registers 1100-1121)
  DEYE_REMOTE_REG,
  DEYE_REMOTE_PROBE,
  DEYE_REMOTE_MODE,
  // The register layout the adapter writes (and the ONLY one whose firmware may
  // key a native-mode certificate). Exported for the same reason as the bit
  // above: the flow's native planner must not retype it.
  DEYE_REMOTE_LAYOUT_PR978,
  DEYE_POWER_CONTROL_MODE,
  DEYE_BATTERY_STRATEGY,
  DEYE_REMOTE_SETPOINT_LIMIT,
  DEYE_REMOTE_WATCHDOG_DEFAULT_S,
  DEYE_REMOTE_WATCHDOG_OFF,
  DEYE_REMOTE_CFG_REASSERT_S,
  DEYE_PATH_REMOTE,
  DEYE_PATH_TOU,
  deyeCapabilityProbeSpec,
  deyeCapabilityKey,
  classifyDeyeCapability,
  deyeControlPath,
  DEYE_PATH_CONTRARY_N,
  deyeUpdateSticky,
  deyeSeedStickyFromGrant,
  deyeEffectiveCap,
  deyeProbeErrorDefinitive,
  resolveDeyeRemoteWatchdog,
  resolveDeyeRemoteStrategy,
  deyeRemoteSetpointUnits,
  resolveDeyeWriteFc,
  resolveDeyePowerScale,
  deyeSnapshotSpec,
  deyeProgramTimeAddrs,
  deyeHhmmToMinutes,
  deyeProgram1Displaced,
  resolveControlTier,
  deviceGrant,
  INSTALLER_WRITE_ADDR,
  REGISTER_WORD_MAX,
  INSTALLER_WRITE_MAX_RAW,
  installerWriteRoute,
  controlRoute,
  controlRelease,
  nativeSelfConsumption,
  deyeNativePrecondition,
  setpointStale,
  dualControllerSignal,
};
