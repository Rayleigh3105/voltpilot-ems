'use strict';

/**
 * inverter-routing - the canonical, unit-tested reference that turns the
 * retained `edge/inverter/config` selection (produced by edge-app/core, see
 * edge-app/INVERTER-CONFIG.md) into the read plan Node-RED self-wires from.
 *
 * This is the heart of the capstone "vorne auswählen, hinten ist alles
 * verdrahtet": the customer picks the inverter once in the Edge-App web UI, the
 * core publishes the choice retained on the local bus, and Node-RED reads it and
 * runs the matching read adapter WITHOUT any per-customer flow edit.
 *
 * It owns two pure, dependency-free things the flow's "Router / Leseplan"
 * function node also implements inline (a Node-RED flow is self-contained JSON
 * and cannot `require` a repo file at runtime - keep the two in sync, this file
 * is the source of truth + the test target, see inverter-routing.test.js):
 *
 *   1. parseConfig() - validate + normalize a raw retained payload into a
 *                      Selection, or null when it is malformed / unusable.
 *   2. route()       - map a Selection onto { adapter, ... } describing exactly
 *                      one read path:
 *                        - solarman_v5 -> the Deye Solarman-V5 reader + the
 *                          family register map (deye/deye-decode.js).
 *                        - modbus_tcp  -> the generic Modbus-TCP reader + the
 *                          SunSpec/Modbus profile (modbus-tcp.js).
 *                        - idle        -> no usable selection (stay idle-safe).
 *
 * The register maps + scaling stay in their owning modules (deye-decode.js,
 * modbus-tcp.js); routing only SELECTS which one runs. Read/monitoring only -
 * nothing here controls the inverter.
 */

// The two register-map owners. In the flow's function node these are inlined
// (families/profiles copied); here we import them so the routing stays DRY and
// the read plans are the exact ones the decoders expect.
const deyeDecode = require('./deye/deye-decode');
const modbusTcp = require('./modbus-tcp');
const froniusSolarApi = require('./fronius/solar-api');
const goeApi = require('./goe/goe-api');
const kostalDecode = require('./kostal/kostal-decode');
const kacoHttp = require('./kaco/kaco-http');
const aisweiDecode = require('./kaco/aiswei-decode');

const SCHEMA_VERSION = '1.0';

const COMM_SOLARMAN = 'solarman_v5';
const COMM_MODBUS = 'modbus_tcp';
const COMM_FRONIUS = 'fronius_solar_api';
// go-e Charger local HTTP API v2 (LAN HTTP/JSON, keyless, port 80): a read-only
// CONSUMER (wallbox) whose charging power is site load. One GET to /api/status
// returns the total charging power; no per-model register map (self-describing).
// Read-only like Fronius Solar API - never in a control allowlist. See goe/goe-api.js.
const COMM_GOE = 'goe_http_api';
// Real SunSpec discovery over Modbus TCP (port 502): a Fronius Eco (and any
// SunSpec-conformant inverter) whose Solar API is unusable is read this way. The
// read path is the live model-discovery walk + measurement decode
// (sunspec/sunspec-live.js), NOT the fake fixed-block modbus_tcp `sunspec`
// profile. Read-only; control (Model 123) is a separate bench-gated increment.
const COMM_FRONIUS_SUNSPEC = 'fronius_sunspec';
// The BRAND-NEUTRAL id of the very same SunSpec-live read path. `fronius_sunspec`
// is a PERSISTED id (the two Fronius Eco of Anlage Herzogau carry it), so it
// stays byte-identical; every brand added to this path AFTER Fronius - KACO is
// the first - carries `sunspec_tcp`, so no operator surface has to call a KACO a
// "Fronius SunSpec". The two are ONE way everywhere: ask isSunSpecTcp(), never
// compare the string twice. Cross-side twin of inverter.IsSunSpecTCP (Go).
const COMM_SUNSPEC_TCP = 'sunspec_tcp';
// KOSTAL PLENTICORE BI over the vendor's own Modbus-TCP server (TCP 1502,
// Unit-ID 71 - factory defaults, hence its own communication): fixed official
// register map, battery power + SoC + (via KSEM) grid power. Read-only; the
// Tier-2 control path (external battery management) is a separate gated
// increment. See kostal/kostal-decode.js.
const COMM_KOSTAL = 'kostal_modbus';
// KACO/AISWEI communication unit, local HTTP-JSON on port 8484 (getdevdata.cgi
// device=2 inverter / 3 meter / 4 battery). The DEFAULT way of that platform,
// because it runs ALONGSIDE the KACO app + SmartCloud, while the stick's SunSpec
// mode is exclusive to the cloud. See kaco/kaco-http.js.
const COMM_KACO_HTTP = 'kaco_http';
// KACO hybrid NH3 over the AISWEI-native register map on the inverter's OWN
// Ethernet port (TCP 502, unit 1). Mixes INPUT (FC4) and HOLDING (FC3) blocks -
// the read plan carries the function code per block. See kaco/aiswei-decode.js.
const COMM_KACO_MODBUS = 'kaco_modbus';

const DEFAULT_SOLARMAN_PORT = 8899;
const DEFAULT_MODBUS_PORT = 502;
const DEFAULT_FRONIUS_PORT = 80;
const DEFAULT_FRONIUS_SUNSPEC_PORT = 502;
const DEFAULT_GOE_PORT = 80;
const DEFAULT_KOSTAL_PORT = kostalDecode.DEFAULT_PORT; // 1502
const DEFAULT_KOSTAL_UNIT_ID = kostalDecode.DEFAULT_UNIT_ID; // 71
const DEFAULT_KACO_HTTP_PORT = kacoHttp.DEFAULT_PORT; // 8484
const DEFAULT_KACO_MODBUS_PORT = aisweiDecode.DEFAULT_PORT; // 502
const DEFAULT_KACO_MODBUS_UNIT_ID = aisweiDecode.DEFAULT_UNIT_ID; // 1

// The one register-profile id the SunSpec-live read path uses (mirrors how the
// Deye family / Modbus profile names the decode). Discovery is dynamic, so there
// is no fixed register block - the profile just names the adapter.
const SUNSPEC_LIVE_PROFILE = 'sunspec_live';

/** Both ids of the SunSpec-live read path (see COMM_SUNSPEC_TCP). */
function isSunSpecTcp(comm) {
  return comm === COMM_FRONIUS_SUNSPEC || comm === COMM_SUNSPEC_TCP;
}

// Deye register families that carry measurement registers (the ones the read
// plan can serve). Mirrors deye-decode.FAMILIES keys.
const DEYE_FAMILIES = Object.keys(deyeDecode.FAMILIES);

// The Fronius Solar API family set (one entry - the API is self-describing).
const FRONIUS_FAMILIES = Object.keys(froniusSolarApi.FAMILIES);

// The go-e HTTP API family set (one entry - the API is self-describing).
const GOE_FAMILIES = Object.keys(goeApi.FAMILIES);

// The KOSTAL register-family set (one entry - the official map covers the BI line).
const KOSTAL_FAMILIES = Object.keys(kostalDecode.FAMILIES);

// The two KACO/AISWEI HTTP profiles (string vs hybrid - they differ in the PV
// SOURCE, see kaco/kaco-http.js FAMILIES) and the NH3 register card.
const KACO_HTTP_FAMILIES = Object.keys(kacoHttp.FAMILIES);
const KACO_MODBUS_FAMILIES = Object.keys(aisweiDecode.FAMILIES);

function isObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v, fallback) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && isFinite(n) ? n : fallback;
}

/**
 * parseConfig - accept a Buffer, string or object retained payload and return a
 * normalized Selection, or null when it is not a usable inverter config.
 *
 * A usable config needs: schema_version "1.0", a known communication method, a
 * non-empty family, and a connection object with a non-empty ip. Unknown future
 * fields are ignored (forward-compatible per the contract).
 */
function parseConfig(input) {
  let obj = input;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    try {
      obj = JSON.parse(input.toString());
    } catch (e) {
      return null;
    }
  }
  if (!isObject(obj)) return null;
  if (obj.schema_version !== SCHEMA_VERSION) return null;

  const communication = typeof obj.communication === 'string' ? obj.communication : '';
  if (communication !== COMM_SOLARMAN && communication !== COMM_MODBUS &&
      communication !== COMM_FRONIUS && !isSunSpecTcp(communication) &&
      communication !== COMM_GOE && communication !== COMM_KOSTAL &&
      communication !== COMM_KACO_HTTP && communication !== COMM_KACO_MODBUS) return null;

  const family = typeof obj.family === 'string' ? obj.family.trim() : '';
  if (!family) return null;

  const conn = isObject(obj.connection) ? obj.connection : null;
  if (!conn) return null;
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return null;

  return {
    schema_version: obj.schema_version,
    brand: typeof obj.brand === 'string' ? obj.brand : '',
    label: typeof obj.label === 'string' ? obj.label : '',
    family,
    communication,
    // rated_kw is the model's CATALOG nameplate (kW). Additive, forward-compatible
    // (absent on an older core). The WRITE side needs it: the Deye remote-mode
    // setpoint is 0.1 % of RATED power and the string/micro active-power limit is a
    // percentage of it, so without this the control adapter cannot compute a value
    // and honestly refuses rather than guessing a rating.
    rated_kw: (typeof obj.rated_kw === 'number' && isFinite(obj.rated_kw) && obj.rated_kw > 0)
      ? obj.rated_kw : undefined,
    connection: conn,
    updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : '',
  };
}

/**
 * route - map a parsed Selection onto the single active read path. Returns one
 * of:
 *
 *   { adapter: 'solarman_v5', family, target, connection:{ip,port,serial,
 *     mb_slave_id,invert_grid_sign,power_scale}, reads:[{start,count}] }
 *   { adapter: 'modbus_tcp', profile, target, connection:{ip,port,unit_id},
 *     read:{fc,addr,count} }
 *   { adapter: 'fronius_solar_api', family, target, connection:{ip,port,
 *     insecure_tls,invert_grid_sign}, scheme, url }   // one HTTP GET
 *   { adapter: 'idle', reason }   // no/unknown/unreadable selection
 *
 * `sel` may be null (nothing selected yet) -> idle.
 */
// --- the DEVICE'S OWN feed-in limit (read once a day) ------------------------
//
// „Grenzen & Wächter" Stufe 0 / Vierer #4: at Anlage Herzogau the Deye held an
// installer cap of 33,0 kW in register 0x00E7 while 70 kW were configured in the
// portal - invisible through two investigation rounds because nobody read the
// register (scout vp-herzogau-runde2-m6 §3 K1). We READ it, never write it.
//
// ⚠ ONE SOCKET LAW: this adds NO new TCP path and NO extra poll cadence. The
// register rides the family's EXISTING sequential read plan as one extra FC3
// round trip, at most once per EXPORT_LIMIT_INTERVAL_MS - the same discipline
// the Modbus mirror's learned blocks already follow (at most ONE per cycle,
// appended AFTER the primary blocks, inside the same sv5 lock that yields to
// control writes).
//
// ⚠ THE TABLE IS A CROSS-SIDE TWIN of `exportLimitRegisters` in
// edge-app/core/internal/inverter/exportlimit.go (which DECODES the word the
// poll brings back). Address AND scale must match or the value is off by 10x -
// change both together; the Go test reads THIS file by path and compares.
//
// ⚠ WHY hybrid_1p IS DELIBERATELY ABSENT - the honesty rule of the feature:
// there the feed-in-cap register IS „Max Sell Power" (0x00F5), which our own
// discharge lever WRITES (inverter-control-routing.js DEYE_CONTROL_REG). Reading
// it back would report OUR commanded value as „the limit the device itself
// holds". A family we cannot read honestly reports nothing, and every surface
// then says „unbekannt" instead of a fabricated foreign truth.
const DEYE_EXPORT_LIMIT = {
  // „Grid Max Export power", a DEDICATED cap separate from maxSellPower
  // (0x008F). Fixed scale 10 (register = W / 10) on both the LV and HV lines.
  hybrid_3p: { addr: 0x00e7, scale: 10 },
};

/** At most one read per 24 h - a device's installer cap does not move hourly. */
const EXPORT_LIMIT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The family's own feed-in-cap register, or null when we cannot read it
 * honestly (see DEYE_EXPORT_LIMIT).
 */
function exportLimitRegister(family) {
  const r = DEYE_EXPORT_LIMIT[family];
  return r ? { addr: r.addr, scale: r.scale } : null;
}

/**
 * Should THIS poll cycle carry the export-limit read?
 *
 * `lastAt` is the timestamp of the last attempt (a flow-context value; absent /
 * unusable = never attempted). Deliberately gated on the ATTEMPT, not on a
 * success: the router does not see the result, and the socket-load guarantee is
 * what matters - at most one extra round trip per day. A failed read is
 * therefore retried tomorrow, and the surfaces honestly say „unbekannt" until
 * then. A Node-RED restart clears the volatile context, so a fresh value
 * arrives on the first poll after every restart - bounded and useful.
 */
function shouldReadExportLimit(family, lastAt, now) {
  if (!exportLimitRegister(family)) return false;
  const t = Number(lastAt);
  if (!Number.isFinite(t) || t <= 0) return true;
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) return false;
  // A clock that jumped BACKWARDS must not lock the read out for a day.
  return nowMs < t || nowMs - t >= EXPORT_LIMIT_INTERVAL_MS;
}

function route(sel) {
  if (!sel) return { adapter: 'idle', reason: 'keine Auswahl' };

  const conn = sel.connection || {};
  const ip = typeof conn.ip === 'string' ? conn.ip.trim() : '';
  if (!ip) return { adapter: 'idle', reason: 'keine IP-Adresse' };

  if (sel.communication === COMM_SOLARMAN) {
    if (!DEYE_FAMILIES.includes(sel.family)) {
      return { adapter: 'idle', reason: 'unbekannte Deye-Familie: ' + sel.family };
    }
    const reads = deyeDecode.planReads({ family: sel.family });
    if (!reads.length) {
      return { adapter: 'idle', reason: sel.family + ': keine Messwert-Register' };
    }
    const serial = conn.serial;
    if (serial === undefined || serial === null || serial === '' || !(Number(serial) > 0)) {
      return { adapter: 'idle', reason: 'Datenlogger-Seriennummer fehlt' };
    }
    const port = num(conn.port, DEFAULT_SOLARMAN_PORT);
    return {
      adapter: COMM_SOLARMAN,
      family: sel.family,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        serial,
        mb_slave_id: num(conn.mb_slave_id, 1),
        invert_grid_sign: !!conn.invert_grid_sign,
        invert_batt_sign: !!conn.invert_batt_sign,
        // The narrow "battery without a coupled BMS" opt-in (deye-decode
        // socMissingSignature). It rides the connection into the DECODE config,
        // because that is where the plausibility gate lives - a plant that opted
        // in but whose decoder never learns it would still drop every sample.
        allow_missing_soc: !!conn.allow_missing_soc,
        // The pack's two ends for the voltage-based SoC estimate. Passed
        // THROUGH unvalidated (deye-decode validates defensively and estimates
        // nothing from a nonsensical pair) - a router that silently "fixed" a
        // bad pair would produce a percentage nobody entered.
        soc_from_voltage: conn.soc_from_voltage,
        // Manual override / fallback (0 = auto-detect the LV/HV scale from 0x0000).
        power_scale: num(conn.power_scale, 0),
      },
      reads,
    };
  }

  if (sel.communication === COMM_MODBUS) {
    const profile = sel.family; // the family IS the Modbus/SunSpec profile id
    const read = modbusTcp.profileRead(profile);
    if (!read) {
      return { adapter: 'idle', reason: 'unbekanntes Modbus-Profil: ' + profile };
    }
    const port = num(conn.port, DEFAULT_MODBUS_PORT);
    return {
      adapter: COMM_MODBUS,
      profile,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        unit_id: num(conn.unit_id, 1),
      },
      read,
    };
  }

  if (sel.communication === COMM_FRONIUS) {
    // The Solar API is self-describing, so there is exactly one family. Gate on
    // the known set for symmetry with the other adapters (an unknown family
    // stays idle-safe, never fabricates).
    if (!FRONIUS_FAMILIES.includes(sel.family)) {
      return { adapter: 'idle', reason: 'unbekannte Fronius-Familie: ' + sel.family };
    }
    const port = num(conn.port, DEFAULT_FRONIUS_PORT);
    // insecure_tls -> dial HTTPS and accept a self-signed cert (GEN24 firmware
    // that redirects to HTTPS); otherwise plain HTTP on the given port.
    const insecure = !!conn.insecure_tls;
    const scheme = insecure ? 'https' : 'http';
    return {
      adapter: COMM_FRONIUS,
      family: sel.family,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        insecure_tls: insecure,
        // Escape hatch, default off: Fronius's P_Grid sign already matches
        // VoltPilot's +import/-export, so no inversion is needed by default.
        invert_grid_sign: !!conn.invert_grid_sign,
      },
      scheme,
      url: froniusSolarApi.powerFlowUrl(scheme, ip, port),
    };
  }

  if (isSunSpecTcp(sel.communication)) {
    // Real SunSpec discovery over Modbus TCP. There is no fixed register block
    // (addresses are discovered live per device/firmware, report §2.1), so the
    // plan carries the connection + an optional model-type hint; the reader runs
    // the sunspec/sunspec-live.js walk + decode. unit_id is a first-class field
    // (default 1 on TCP; the two-Eco / meter multi-unit modelling is a later
    // increment).
    const port = num(conn.port, DEFAULT_FRONIUS_SUNSPEC_PORT);
    const modelType = conn.model_type === 'float' || conn.model_type === 'int_sf' ? conn.model_type : 'auto';
    return {
      adapter: 'sunspec_live',
      profile: SUNSPEC_LIVE_PROFILE,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        unit_id: num(conn.unit_id, 1),
        // Escape hatch, default off: a meter's SunSpec W sign vs VoltPilot's
        // +import/-export must be VERIFIED on device (no meter on the Eco site).
        invert_grid_sign: !!conn.invert_grid_sign,
        model_type: modelType,
      },
    };
  }

  if (sel.communication === COMM_KOSTAL) {
    // KOSTAL PLENTICORE BI: fixed FC3 blocks per the official register map
    // (kostal/kostal-decode.js planReads). Gate on the known family set (an
    // unknown family stays idle-safe, never fabricates). Read-only.
    if (!KOSTAL_FAMILIES.includes(sel.family)) {
      return { adapter: 'idle', reason: 'unbekannte Kostal-Familie: ' + sel.family };
    }
    const reads = kostalDecode.planReads({ family: sel.family });
    if (!reads.length) {
      return { adapter: 'idle', reason: sel.family + ': keine Messwert-Register' };
    }
    const port = num(conn.port, DEFAULT_KOSTAL_PORT);
    const byteOrder = conn.byte_order === 'little' || conn.byte_order === 'big' ? conn.byte_order : 'auto';
    return {
      adapter: COMM_KOSTAL,
      family: sel.family,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        unit_id: num(conn.unit_id, DEFAULT_KOSTAL_UNIT_ID),
        // Grid sign hangs on the CONFIGURED sensor position (2 = grid connection
        // point matches VoltPilot's +Bezug/-Einspeisung); battery sign per doc is
        // - charge/+ discharge and is NEGATED in the decode - both hatches are
        // VERIFY-on-device.
        invert_grid_sign: !!conn.invert_grid_sign,
        invert_batt_sign: !!conn.invert_batt_sign,
        // 'auto' reads device register 5 (in the plan) each cycle.
        byte_order: byteOrder,
      },
      reads,
    };
  }

  if (sel.communication === COMM_KACO_HTTP) {
    // The AISWEI communication unit: THREE GETs per cycle (inverter / meter /
    // battery). Gate on the known family set - an unknown family stays
    // idle-safe and never fabricates.
    if (!KACO_HTTP_FAMILIES.includes(sel.family)) {
      return { adapter: 'idle', reason: 'unbekannte KACO-Familie: ' + sel.family };
    }
    const port = num(conn.port, DEFAULT_KACO_HTTP_PORT);
    const insecure = !!conn.insecure_tls;
    const scheme = insecure ? 'https' : 'http';
    const serial = typeof conn.serial === 'string' ? conn.serial.trim() : '';
    return {
      adapter: COMM_KACO_HTTP,
      family: sel.family,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        // The serial is the KEY of every measurement call. It may legitimately
        // be EMPTY here: the reader then asks the inventory endpoint for it
        // (getdev.cgi?device=2) instead of guessing. Never fabricate one.
        serial,
        insecure_tls: insecure,
        invert_grid_sign: !!conn.invert_grid_sign,
        invert_batt_sign: !!conn.invert_batt_sign,
      },
      scheme,
      // The inventory URL is always usable; the three data URLs need the serial,
      // so they are built by the reader once it knows it.
      inventory_url: kacoHttp.inventoryUrl(scheme, ip, port),
      // hasBattery decides whether the battery endpoint is polled at all - a
      // string inverter has none, and asking would only cost a timeout.
      has_battery: !!(kacoHttp.FAMILIES[sel.family] || {}).hasBattery,
    };
  }

  if (sel.communication === COMM_KACO_MODBUS) {
    // KACO hybrid NH3, AISWEI register card over its own Ethernet port. Fixed
    // blocks (no discovery walk); each block carries its FUNCTION CODE because
    // the card mixes input (FC4) and holding (FC3) registers.
    if (!KACO_MODBUS_FAMILIES.includes(sel.family)) {
      return { adapter: 'idle', reason: 'unbekannte KACO-Familie: ' + sel.family };
    }
    const reads = aisweiDecode.planReads({ family: sel.family });
    if (!reads.length) {
      return { adapter: 'idle', reason: sel.family + ': keine Messwert-Register' };
    }
    const port = num(conn.port, DEFAULT_KACO_MODBUS_PORT);
    return {
      adapter: COMM_KACO_MODBUS,
      family: sel.family,
      target: ip + ':' + port,
      connection: {
        ip,
        port,
        unit_id: num(conn.unit_id, DEFAULT_KACO_MODBUS_UNIT_ID),
        invert_grid_sign: !!conn.invert_grid_sign,
        invert_batt_sign: !!conn.invert_batt_sign,
      },
      reads,
    };
  }

  if (sel.communication === COMM_GOE) {
    // go-e Charger local HTTP API v2: ONE HTTP GET to /api/status returns the
    // charging power. Self-describing (one family), so gate on the known set for
    // symmetry with Fronius (an unknown family stays idle-safe). Read-only.
    if (!GOE_FAMILIES.includes(sel.family)) {
      return { adapter: 'idle', reason: 'unbekannte go-e-Familie: ' + sel.family };
    }
    const port = num(conn.port, DEFAULT_GOE_PORT);
    return {
      adapter: COMM_GOE,
      family: sel.family,
      target: ip + ':' + port,
      connection: { ip, port },
      url: goeApi.statusUrl(ip, port),
    };
  }

  return { adapter: 'idle', reason: 'unbekannte Kommunikationsmethode' };
}

module.exports = {
  SCHEMA_VERSION,
  COMM_SOLARMAN,
  COMM_MODBUS,
  COMM_FRONIUS,
  COMM_FRONIUS_SUNSPEC,
  COMM_SUNSPEC_TCP,
  COMM_KACO_HTTP,
  COMM_KACO_MODBUS,
  isSunSpecTcp,
  COMM_GOE,
  COMM_KOSTAL,
  SUNSPEC_LIVE_PROFILE,
  DEFAULT_SOLARMAN_PORT,
  DEFAULT_MODBUS_PORT,
  DEFAULT_FRONIUS_PORT,
  DEFAULT_FRONIUS_SUNSPEC_PORT,
  DEFAULT_GOE_PORT,
  DEFAULT_KOSTAL_PORT,
  DEFAULT_KOSTAL_UNIT_ID,
  DEFAULT_KACO_HTTP_PORT,
  DEFAULT_KACO_MODBUS_PORT,
  DEFAULT_KACO_MODBUS_UNIT_ID,
  DEYE_EXPORT_LIMIT,
  EXPORT_LIMIT_INTERVAL_MS,
  exportLimitRegister,
  shouldReadExportLimit,
  parseConfig,
  route,
};
