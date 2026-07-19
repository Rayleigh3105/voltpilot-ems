'use strict';

/**
 * Offline tests for the canonical go-e Charger HTTP API v2 decode module. No
 * hardware, no network: recorded `/api/status` fixtures are fed through the exact
 * decoder the flow's function nodes embed.
 *
 * Run: node --test edge-app/nodered/goe/
 */

const { test } = require('node:test');
const assert = require('node:assert');

const G = require('./goe-api.js');

// --- fixtures (recorded-shape go-e HTTP API v2 /api/status responses) --------
//
// nrg order (apikeys-en.md): U(L1,L2,L3,N), I(L1,L2,L3), P(L1,L2,L3,N,Total),
// pf(L1,L2,L3,N). In the v2 API the P values are WATTS (see goe-api.js header),
// so a 3-phase ~16 A charge reads ~3680 W per phase and ~11040 W total.

// A go-e actively charging a car at ~11 kW (3-phase, ~16 A).
function chargingStatus(overrides) {
  return Object.assign(
    {
      car: 2, // Charging
      alw: true,
      amp: 16,
      wh: 5321.4,
      nrg: [232.1, 231.8, 232.5, 0.0, 16.0, 16.1, 15.9, 3680, 3700, 3660, 0, 11040, 99.9, 99.8, 99.7, 0],
    },
    overrides || {},
  );
}

// A go-e with the car connected but NOT charging (Complete): a real 0 W. The
// power field is present and exactly 0 - a real value that must be KEPT.
function notChargingStatus(overrides) {
  return Object.assign(
    {
      car: 4, // Complete (charging finished, car still connected)
      alw: false,
      amp: 6,
      wh: 8000.0,
      nrg: [231.0, 231.0, 231.0, 0.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    },
    overrides || {},
  );
}

// --- happy path: charging -> load_kw --------------------------------------

test('decodeStatus maps the total charging power (nrg[11], W) onto load_kw', () => {
  const out = G.decodeStatus(chargingStatus());
  assert.deepStrictEqual(out.reading, { load_kw: 11.04 }); // 11040 W -> 11.04 kW
  assert.strictEqual(out.carState, 'charging');
  assert.strictEqual(out.charging, true);
  assert.strictEqual(out.allowed, true);
  // nothing but load_kw is surfaced as a measurement channel (read-only consumer).
  assert.strictEqual(out.reading.pv_power_kw, undefined);
  assert.strictEqual(out.reading.power_kw, undefined);
  assert.strictEqual(out.reading.soc_pct, undefined);
});

test('the total charging power comes from nrg index 11, not a per-phase value', () => {
  // per-phase powers differ from the total; only nrg[11] must drive load_kw.
  const s = chargingStatus();
  s.nrg[11] = 7360; // total 7.36 kW
  const out = G.decodeStatus(s);
  assert.strictEqual(out.reading.load_kw, 7.36);
  assert.strictEqual(G.NRG_TOTAL_POWER_IDX, 11);
});

test('load_kw is clamped >= 0 (a wallbox only ever consumes)', () => {
  const out = G.decodeStatus(chargingStatus({ nrg: [230, 230, 230, 0, 0, 0, 0, 0, 0, 0, 0, -12, 0, 0, 0, 0] }));
  assert.strictEqual(out.reading.load_kw, 0);
});

// --- a real 0 W (not charging) is KEPT, never dropped -----------------------

test('a not-charging go-e reports a real load_kw 0 (kept, not omitted)', () => {
  const out = G.decodeStatus(notChargingStatus());
  assert.strictEqual('load_kw' in out.reading, true, 'a real 0 W is a real value');
  assert.strictEqual(out.reading.load_kw, 0);
  assert.strictEqual(out.carState, 'complete');
  assert.strictEqual(out.charging, false);
});

test('carState maps every documented code (0..5) and null -> unknown', () => {
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: 1 })).carState, 'idle');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: 2 })).carState, 'charging');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: 3 })).carState, 'waiting');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: 4 })).carState, 'complete');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: 5 })).carState, 'error');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: 0 })).carState, 'unknown');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: null })).carState, 'unknown');
  assert.strictEqual(G.decodeStatus(chargingStatus({ car: undefined })).carState, 'unknown');
});

// --- absent field: OMIT load_kw, never fabricate 0 (the key discipline) -----

test('a missing nrg omits load_kw (absent, NOT a fabricated 0)', () => {
  const s = chargingStatus();
  delete s.nrg;
  const out = G.decodeStatus(s);
  assert.strictEqual('load_kw' in out.reading, false, 'absent field -> omitted');
  assert.deepStrictEqual(out.reading, {}, 'no fabricated 0');
  // the charging state is still surfaced honestly even without a power reading.
  assert.strictEqual(out.carState, 'charging');
});

test('a non-numeric / absent nrg[11] omits load_kw (never a fabricated 0)', () => {
  // nrg present but the total power slot is null / a string / short array.
  let out = G.decodeStatus(chargingStatus({ nrg: [230, 230, 230, 0, 0, 0, 0, 0, 0, 0, 0, null, 0, 0, 0, 0] }));
  assert.strictEqual('load_kw' in out.reading, false);
  out = G.decodeStatus(chargingStatus({ nrg: [230, 230, 230, 0, 0, 0, 0, 0, 0, 0, 0, 'x', 0, 0, 0, 0] }));
  assert.strictEqual('load_kw' in out.reading, false);
  out = G.decodeStatus(chargingStatus({ nrg: [230, 230] })); // too short to have index 11
  assert.strictEqual('load_kw' in out.reading, false);
});

// --- garbage / malformed inputs fold into null (idle-safe) ------------------

test('garbage / malformed inputs decode to null', () => {
  assert.strictEqual(G.decodeStatus(null), null);
  assert.strictEqual(G.decodeStatus(undefined), null);
  assert.strictEqual(G.decodeStatus(42), null);
  assert.strictEqual(G.decodeStatus('not json'), null);
  assert.strictEqual(G.decodeStatus([1, 2, 3]), null); // an array is not a status object
});

test('an empty status object decodes to an empty reading (no fabricated channels)', () => {
  const out = G.decodeStatus({});
  assert.deepStrictEqual(out.reading, {});
  assert.strictEqual(out.carState, 'unknown');
  assert.strictEqual(out.allowed, null);
});

// --- endpoint URL -----------------------------------------------------------

test('statusUrl builds the /api/status URL with the payload filter', () => {
  assert.strictEqual(
    G.statusUrl('192.168.1.42', 80),
    'http://192.168.1.42:80/api/status?filter=nrg,car,alw,amp,wh',
  );
  // no port -> omit the :port part
  assert.strictEqual(G.statusUrl('goe.local'), 'http://goe.local/api/status?filter=nrg,car,alw,amp,wh');
});

test('FAMILIES exposes exactly the one go-e HTTP API family', () => {
  assert.deepStrictEqual(Object.keys(G.FAMILIES), ['goe_http_api']);
});
