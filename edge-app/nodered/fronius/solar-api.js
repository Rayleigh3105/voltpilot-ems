'use strict';

/**
 * solar-api - the canonical, unit-tested reference for the Fronius transport:
 * the **Fronius Solar API** (local HTTP/JSON), mirroring how Home Assistant
 * integrates Fronius (github.com/home-assistant/core + pyfronius). NOT Modbus:
 * HA deliberately does not use Modbus for Fronius, and one HTTP GET to
 * `GetPowerFlowRealtimeData.fcgi` (Solar API v1) already returns PV + grid +
 * load + battery + SoC together - VoltPilot's whole canonical channel set.
 *
 * This module owns ONLY the decode + the endpoint path. It is dependency-free
 * (no `require`, no socket/HTTP code), so it is fully testable offline with
 * recorded fixture JSON (see solar-api.test.js). The HTTP client lives in the
 * Node-RED flow's "Fronius Solar API lesen" function node, which carries a COPY
 * of `decodePowerFlow` (a Node-RED flow is self-contained JSON and cannot
 * `require` a repo file at runtime) plus the `http`/`https` request logic. Keep
 * the two in sync; this file is the source of truth + the test target, and
 * flows-sync.test.js pins the inline decoder against this module - exactly the
 * discipline the Deye deye/solarman-v5.js + deye/deye-decode.js pair follows.
 *
 * Read/monitoring ONLY - nothing here (or anywhere in the Fronius path) controls
 * the inverter. Fronius stays read-only by construction, like Deye: it is NOT in
 * inverter-control-routing.js's CERTIFIED_CONTROL_FAMILIES allowlist.
 *
 * Scope: **Solar API v1** only. `GetPowerFlowRealtimeData` is a v1 endpoint
 * (GEN24 + Datamanager 2.0 Symo/Primo/Symo Hybrid); a pure-v0 legacy Datamanager
 * 1.0 logger has no PowerFlow endpoint and is a deliberate NON-goal here - a v0
 * device just 404s and the flow folds that into the idle-safe state (never a
 * silent degrade). See FRONIUS.md.
 *
 * PowerFlow `Site` object (pyfronius `_system_power_flow`):
 *   P_PV   -> site PV generation (W, >=0; null when the inverter is asleep)
 *   P_Grid -> grid power (W, + = import, - = export)      << matches VoltPilot
 *   P_Load -> site load (W, - = consuming)                << opposite sign
 *   P_Akku -> battery power (W)  (calibration only, NEVER published)
 *   Inverters["1"].SOC -> battery SoC (%) for a single-hybrid site
 */

// The Solar API v1 PowerFlow endpoint path. v1-only by design (see the header).
const POWER_FLOW_PATH = '/solar_api/v1/GetPowerFlowRealtimeData.fcgi';

// The register-map "families" this transport offers (mirrors deye-decode.FAMILIES
// so inverter-routing.js can gate on a known set). Fronius needs only one: the
// Solar API is self-describing, there is no per-model register map to pick.
const FAMILIES = {
  fronius_solar_api: { label: 'Fronius Solar API' },
};

const round3 = (x) => Math.round(x * 1000) / 1000;
const round1 = (x) => Math.round(x * 10) / 10;

/** num - a finite number, or null (Fronius fields are `null` when unavailable). */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * socPlausible - a battery SoC we trust. Ported verbatim from Deye's
 * deye-decode.socPlausible: an exact 0 (or a missing/out-of-range key) is the
 * "no usable answer" signature (no battery, or a garbage read), NOT a real
 * charge level - so it is dropped, never fabricated as 0. In JSON the primary
 * "no battery" signal is the SOC key simply being absent (-> not a number ->
 * false here); this also guards a stray out-of-range value.
 */
const SOC_PCT_MIN = 0; // exclusive: an exact 0 is the empty-answer signature
const SOC_PCT_MAX = 100; // inclusive
function socPlausible(pct) {
  return typeof pct === 'number' && isFinite(pct) && pct > SOC_PCT_MIN && pct <= SOC_PCT_MAX;
}

/**
 * powerFlowUrl - the full GetPowerFlowRealtimeData.fcgi URL for a host. `scheme`
 * is 'http' (default) or 'https' (the GEN24 self-signed-cert firmware case, see
 * FRONIUS.md); the flow's function node dials it with rejectUnauthorized:false
 * when the operator ticked "insecure_tls".
 */
function powerFlowUrl(scheme, host, port) {
  const s = scheme === 'https' ? 'https' : 'http';
  return s + '://' + host + ':' + port + POWER_FLOW_PATH;
}

/**
 * decodePowerFlow - map a parsed GetPowerFlowRealtimeData.fcgi JSON response
 * onto the flat edge/telemetry reading + a calibration-only battery figure:
 *
 *   { reading: { power_kw?, pv_power_kw?, load_kw?, soc_pct? }, battKw }
 *
 * Returns null (-> the flow stays idle-safe, publishes nothing) when the payload
 * is malformed, Fronius signalled an internal bad status, there is no Site
 * object, or no usable measurement channel is present. Absent Fronius fields
 * (null / missing) map to OMITTED channels - never a fabricated 0. This is the
 * same "idle, never fabricate" discipline route() uses for unknown families and
 * the Deye decoder uses for an unanswered read.
 *
 * `opts.invertGridSign` (default false) is the escape hatch for the rare
 * firmware whose P_Grid sign disagrees with VoltPilot's +import/-export
 * convention. VERIFY the sign assumptions (grid: no inversion; load: negate) on
 * a real device before trusting them - same rule as Deye's "all scaling/signs
 * are VERIFY-on-device".
 */
function decodePowerFlow(json, opts) {
  opts = opts || {};
  if (json == null || typeof json !== 'object') return null;

  const body = json.Body;
  const data = body && typeof body === 'object' ? body.Data : null;
  if (!data || typeof data !== 'object') return null;

  // BadStatus: Fronius reports an internal error via Head.Status.Code != 0
  // (pyfronius raises BadStatusError). Treat as no usable answer.
  const head = json.Head;
  if (head && head.Status && typeof head.Status.Code === 'number' && head.Status.Code !== 0) {
    return null;
  }

  const site = data.Site;
  if (!site || typeof site !== 'object') return null;

  const reading = {};

  // grid (power_kw): P_Grid W, sign already matches VoltPilot (+import/-export),
  // so NO inversion by default (unlike Deye). VERIFY on a real device.
  const pGrid = num(site.P_Grid);
  if (pGrid !== null) {
    const sign = opts.invertGridSign ? -1 : 1;
    reading.power_kw = round3((sign * pGrid) / 1000);
  }

  // pv (pv_power_kw): P_PV W, >= 0. null = the inverter is asleep (no data) ->
  // OMIT, never fabricate a 0 (a daytime awake inverter reports a real 0).
  const pPv = num(site.P_PV);
  if (pPv !== null) reading.pv_power_kw = round3(Math.max(0, pPv) / 1000);

  // load (load_kw): Fronius reports load NEGATIVE when consuming; VoltPilot's
  // load_kw is a non-negative consumption channel, so negate (and clamp >= 0).
  // VERIFY the negation on a real device.
  const pLoad = num(site.P_Load);
  if (pLoad !== null) reading.load_kw = round3(Math.max(0, -pLoad) / 1000);

  // soc (soc_pct): from Inverters["1"].SOC for a single-hybrid site (pyfronius
  // reads exactly that path). Absent when there is no battery -> OMITTED via the
  // drop-don't-fabricate gate below (mirrors Deye's socPlausible discipline).
  let soc = null;
  const inverters = data.Inverters;
  if (inverters && typeof inverters === 'object') {
    const first = inverters['1'];
    if (first && typeof first === 'object') soc = num(first.SOC);
  }
  if (socPlausible(soc)) reading.soc_pct = round1(soc);

  // Nothing usable decoded (e.g. an asleep inverter with no meter at night, all
  // Site fields null) -> stay idle, publish nothing.
  if (Object.keys(reading).length === 0) return null;

  // battery power (P_Akku): read for calibration/cross-check ONLY - NEVER
  // published as a channel. VoltPilot derives battery_kw from the power balance
  // (same rule as Deye/SunSpec), so PowerFlow's own figure is a cross-check.
  const pAkku = num(site.P_Akku);
  const battKw = pAkku === null ? null : round3(pAkku / 1000);

  return { reading, battKw };
}

module.exports = {
  POWER_FLOW_PATH,
  FAMILIES,
  powerFlowUrl,
  decodePowerFlow,
  socPlausible,
  _helpers: { num, round3, round1 },
};
