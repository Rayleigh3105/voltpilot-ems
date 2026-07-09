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

const SCHEMA_VERSION = '1.0';

const COMM_SOLARMAN = 'solarman_v5';
const COMM_MODBUS = 'modbus_tcp';
const COMM_FRONIUS = 'fronius_solar_api';

const DEFAULT_SOLARMAN_PORT = 8899;
const DEFAULT_MODBUS_PORT = 502;
const DEFAULT_FRONIUS_PORT = 80;

// Deye register families that carry measurement registers (the ones the read
// plan can serve). Mirrors deye-decode.FAMILIES keys.
const DEYE_FAMILIES = Object.keys(deyeDecode.FAMILIES);

// The Fronius Solar API family set (one entry - the API is self-describing).
const FRONIUS_FAMILIES = Object.keys(froniusSolarApi.FAMILIES);

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
  if (communication !== COMM_SOLARMAN && communication !== COMM_MODBUS && communication !== COMM_FRONIUS) return null;

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
        power_scale: num(conn.power_scale, 1) > 0 ? num(conn.power_scale, 1) : 1,
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

  return { adapter: 'idle', reason: 'unbekannte Kommunikationsmethode' };
}

module.exports = {
  SCHEMA_VERSION,
  COMM_SOLARMAN,
  COMM_MODBUS,
  COMM_FRONIUS,
  DEFAULT_SOLARMAN_PORT,
  DEFAULT_MODBUS_PORT,
  DEFAULT_FRONIUS_PORT,
  parseConfig,
  route,
};
