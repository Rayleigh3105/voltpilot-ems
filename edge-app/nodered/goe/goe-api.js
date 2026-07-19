'use strict';

/**
 * goe-api - the canonical, unit-tested reference for the go-e Charger transport:
 * the **go-e local HTTP API v2** (LAN HTTP/JSON, keyless), mirroring how Home
 * Assistant reads a go-e Wallbox. One HTTP GET to `/api/status` returns the
 * charging power + state; VoltPilot maps it onto the canonical CONSUMER channel.
 *
 * A go-e Charger is a wallbox = a Verbraucher (consumer): its charging power is
 * site LOAD. This driver is READ-ONLY BY CONSTRUCTION - it decodes the status
 * and NEVER writes (no charge/current control), like the Fronius Solar API
 * driver (fronius/solar-api.js), whose shape this file follows exactly.
 *
 * This module owns ONLY the decode + the endpoint path. It is dependency-free
 * (no `require`, no socket/HTTP code), so it is fully testable offline with
 * recorded fixture JSON (see goe-api.test.js). The HTTP client lives in the
 * Node-RED flow's source-reader / "Verbindung testen" function nodes, which
 * carry an EMBEDDED copy of this module (a Node-RED flow is self-contained JSON
 * and cannot `require` a repo file at runtime); build-flows.js embeds it and
 * flows-sync.test.js pins the copy against this file - the same discipline the
 * fronius/solar-api.js + deye/deye-decode.js pair follows.
 *
 * The endpoint (go-e HTTP API v2, github.com/goecharger/go-eCharger-API-v2):
 *   GET http://<ip>/api/status?filter=nrg,car,alw,amp,wh   (keyless on the LAN)
 * The `filter` query shrinks the payload to the keys we read; a bare
 * `/api/status` (no filter) returns a superset and decodes identically.
 *
 * `nrg` (apikeys-en.md, verbatim): "energy array, U (L1, L2, L3, N), I (L1, L2,
 * L3), P (L1, L2, L3, N, Total), pf (L1, L2, L3, N)" - i.e. 16 elements:
 *   [0..3]  voltage  L1,L2,L3,N   [V]
 *   [4..6]  current  L1,L2,L3     [A]
 *   [7..10] power    L1,L2,L3,N   [W]   << per the v2 API these P values are WATTS
 *   [11]    power    TOTAL        [W]   << the charging power we map to load_kw
 *   [12..15] powerFactor L1,L2,L3,N [%]
 * The WATT unit is the well-documented v2 interpretation: the reference HA v2
 * integration (marq24/ha-goecharger-api2) declares `nrg` idx 7..11 as
 * `UnitOfPower.WATT` with NO scaling (a ~11 kW charge reads ~11040). Note this
 * DIFFERS from the go-e API v1, whose `nrg[11]` total was 0.01 kW - v2 is watts.
 * Like every vendor's sign/scale, this is VERIFY-on-device before trusting it
 * (the same "signs stay verify-on-device" rule as Deye/Fronius).
 *
 * `car` (apikeys-en.md, verbatim): "carState, null if internal error
 * (Unknown/Error=0, Idle=1, Charging=2, WaitCar=3, Complete=4, Error=5)".
 *
 * Absent-not-zero discipline (Deye socPlausible / Fronius "missing -> omit"): a
 * real 0 W (car unplugged / not charging) is a REAL value and KEPT; an absent /
 * non-numeric `nrg[11]` is OMITTED from the reading, never fabricated to 0.
 */

// The go-e HTTP API v2 status endpoint path + the payload-shrinking filter.
const STATUS_PATH = '/api/status';
const STATUS_FILTER = 'nrg,car,alw,amp,wh';

// Index of the TOTAL charging power in the nrg array (see the header). Pinned as
// a named constant so the "do not guess the index" contract is explicit + tested.
const NRG_TOTAL_POWER_IDX = 11;

// The register-map "families" this transport offers (mirrors the other decoders'
// FAMILIES so inverter-routing.js can gate on a known set). go-e needs only one:
// the HTTP API is self-describing, there is no per-model register map to pick.
const FAMILIES = {
  goe_http_api: { label: 'go-e Charger (HTTP API v2)' },
};

// carState codes -> honest short labels (docs verbatim above). null / any other
// value maps to 'unknown' (never guessed).
const CAR_STATES = {
  0: 'unknown', // Unknown/Error
  1: 'idle', // no car connected
  2: 'charging',
  3: 'waiting', // WaitCar (car connected, waiting/authenticating)
  4: 'complete', // charging finished, car still connected
  5: 'error',
};

const round3 = (x) => Math.round(x * 1000) / 1000;

/** num - a finite number, or null (go-e fields can be absent / null). */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** carState - map the `car` field onto an honest label; 'unknown' when absent. */
function carState(car) {
  const c = num(car);
  if (c === null) return 'unknown'; // null = internal error per the docs
  return Object.prototype.hasOwnProperty.call(CAR_STATES, c) ? CAR_STATES[c] : 'unknown';
}

/**
 * statusUrl - the full go-e status URL for a host. go-e is a plain-HTTP LAN
 * device (port 80 by default); there is no HTTPS/self-signed-cert case like
 * Fronius GEN24, so the scheme is always http.
 */
function statusUrl(host, port) {
  const portPart = port ? ':' + port : '';
  return 'http://' + host + portPart + STATUS_PATH + '?filter=' + STATUS_FILTER;
}

/**
 * decodeStatus - map a parsed go-e `/api/status` JSON response onto the flat
 * consumer reading + the honest charging state:
 *
 *   { reading: { load_kw? }, carState, charging, allowed }
 *
 * Returns null (-> the flow stays idle-safe) only when the payload is not an
 * object at all. A valid object always decodes: `reading` carries `load_kw` when
 * `nrg[NRG_TOTAL_POWER_IDX]` is a finite number (a real 0 is KEPT), and is empty
 * ({}) when that field is absent/non-numeric - OMITTED, never fabricated to 0
 * (the caller treats an absent load_kw as "no usable value" and publishes
 * nothing, exactly like the Fronius decoder). `carState`/`charging`/`allowed`
 * are surfaced for an honest status line; they are NOT measurement channels.
 *
 * Load is clamped >= 0: a wallbox only ever draws (consumes) - there is no V2G
 * export path in this read-only driver.
 */
function decodeStatus(json) {
  if (json == null || typeof json !== 'object' || Array.isArray(json)) return null;

  const reading = {};
  const nrg = json.nrg;
  if (Array.isArray(nrg)) {
    const w = num(nrg[NRG_TOTAL_POWER_IDX]);
    // W -> kW; clamp >= 0 (a consumer never exports). A real 0 (unplugged / not
    // charging) is KEPT; an absent nrg[11] leaves load_kw OMITTED (never a 0).
    if (w !== null) reading.load_kw = round3(Math.max(0, w) / 1000);
  }

  const state = carState(json.car);
  return {
    reading,
    carState: state,
    charging: state === 'charging',
    // `alw` = "Is the car allowed to charge at all now?" (honest status only).
    allowed: typeof json.alw === 'boolean' ? json.alw : null,
  };
}

module.exports = {
  STATUS_PATH,
  STATUS_FILTER,
  NRG_TOTAL_POWER_IDX,
  FAMILIES,
  CAR_STATES,
  statusUrl,
  decodeStatus,
  carState,
  _helpers: { num, round3 },
};
