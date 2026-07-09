'use strict';

/**
 * sources-routing - the canonical, unit-tested reference that turns the retained
 * `edge/sources/config` array (produced by edge-app/core internal/sources, see
 * localbus.go) into the per-source read plans Node-RED self-wires from. It is the
 * multi-source sibling of inverter-routing.js: the inverter routing handles the
 * ONE battery-hybrid (Speicher, control target); this handles the ADDITIONAL
 * read-only Erzeuger (PV) measurement points a site can have.
 *
 * Two pure, dependency-free things (the flow's source-reader function node
 * carries an inlined copy - a Node-RED flow is self-contained JSON and cannot
 * `require` a repo file; this file is the source of truth + the test target,
 * see sources-routing.test.js):
 *
 *   1. parseSourcesConfig() - validate + normalize the retained array into a
 *                             list of { id, role, capacity_kwp, interval_s,
 *                             selection } entries (each `selection` is exactly
 *                             the shape inverter-routing.route consumes).
 *   2. planSources()        - map that list onto the read plans, KEEPING only
 *                             Erzeuger sources with a usable read plan.
 *
 * The register maps + scaling stay in their owning modules (reused via
 * inverter-routing.route). READ-ONLY: a source never gets a control path.
 *
 * SCOPE (Phase 1): the flow read EXECUTOR wired in build-flows.js reads
 * `modbus_tcp` sources (the common separate AC-coupled PV / SunSpec inverter, and
 * what the e2e sim uses). A `solarman_v5` source is recognised by the routing but
 * its per-source socket executor is deferred (a second Deye as a read-only source
 * is unusual; the primary Deye path is unchanged). See report §4 Phase 1.
 */

const { parseConfig, route } = require('./inverter-routing');

const SCHEMA_VERSION = '1.0';
const ROLE_ERZEUGER = 'pv-generation';
const ROLE_NETZ = 'grid-meter';

function num(v, fallback) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  return typeof n === 'number' && isFinite(n) ? n : fallback;
}

/**
 * parseSourcesConfig - accept a Buffer, string or object retained payload
 * ({ schema_version, sources: [...] }) and return the list of validated source
 * entries. A malformed payload or entry is dropped (never throws); an empty /
 * cleared config yields [].
 */
function parseSourcesConfig(input) {
  let obj = input;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    try {
      obj = JSON.parse(input.toString());
    } catch (e) {
      return [];
    }
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return [];
  if (obj.schema_version !== SCHEMA_VERSION) return [];
  if (!Array.isArray(obj.sources)) return [];

  const out = [];
  obj.sources.forEach((s) => {
    if (s == null || typeof s !== 'object') return;
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!id) return;
    // A source reuses the inverter selection shape; parseConfig validates the
    // transport/connection. The per-entry schema_version is the array's, so we
    // inject it (the entries carry brand/model/family/communication/connection).
    const selection = parseConfig({
      schema_version: SCHEMA_VERSION,
      brand: s.brand,
      label: s.label,
      family: s.family,
      communication: s.communication,
      connection: s.connection,
    });
    if (!selection) return;
    out.push({
      id,
      role: typeof s.role === 'string' ? s.role : '',
      capacity_kwp: num(s.capacity_kwp, 0),
      interval_s: num(s.interval_s, 5),
      selection,
    });
  });
  return out;
}

/**
 * planSources - map parsed source entries onto their read plans, keeping ONLY
 * read-only measurement roles (Erzeuger PV + Netz grid meter) that route to a
 * usable (non-idle) read path. Returns a list of { id, role, capacity_kwp, plan }
 * where plan is the inverter-routing.route result (adapter modbus_tcp |
 * solarman_v5). The role rides along so the reader picks the right field to
 * publish (Erzeuger -> pv_power_kw, Netz -> signed power_kw).
 */
function planSources(entries) {
  const out = [];
  (entries || []).forEach((e) => {
    if (!e || (e.role !== ROLE_ERZEUGER && e.role !== ROLE_NETZ)) return;
    const plan = route(e.selection);
    if (!plan || plan.adapter === 'idle') return;
    out.push({ id: e.id, role: e.role, capacity_kwp: e.capacity_kwp, plan });
  });
  return out;
}

module.exports = {
  SCHEMA_VERSION,
  ROLE_ERZEUGER,
  ROLE_NETZ,
  parseSourcesConfig,
  planSources,
};
