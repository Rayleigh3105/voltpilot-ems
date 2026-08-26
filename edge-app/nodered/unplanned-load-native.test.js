'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CERTIFIED_NATIVE_CAPABILITIES, SIMULATOR_NATIVE_CAPABILITIES,
  exactCapability, certificateMatchesPlan, nativeWritePlan,
} = require('./unplanned-load-native');

const safe = {
  authorized: true,
  emergencyStop: false,
  firstLightGranted: true,
  measurementsFresh: true,
  communicationHealthy: true,
  readbackHealthy: true,
  socPct: 95,
  effectiveFloorSocPct: 35,
  selection: { brand: 'Example', model: 'Lab-1', firmware: '1.2.3' },
};

test('production catalog contains no native writes until bench evidence exists', () => {
  assert.deepEqual(CERTIFIED_NATIVE_CAPABILITIES, []);
  assert.deepEqual(nativeWritePlan(safe), {
    path: 'idle_follow', writes: [], readback: [], reason: 'native_not_certified',
  });
});

test('Deye native behavior remains disabled even with an injected broad claim', () => {
  const request = { ...safe, selection: { brand: 'Deye', model: 'SUN-30K-SG01HP3-EU', firmware: 'V1' } };
  const catalog = [{ ...request.selection, capability: 'native_charge_block_discharge_auto', certified: true,
    readback: true, watchdog: true, chargeBlockWrites: [{ address: 1, value: 1 }],
    readbackChecks: [{ address: 1, equals: 1 }], releaseWrites: [{ address: 1, value: 0 }],
    releaseReadbackChecks: [{ address: 1, equals: 0 }], watchdogSpec: { timeoutS: 30 } }];
  assert.equal(nativeWritePlan(request, catalog).path, 'idle_follow');
  assert.deepEqual(nativeWritePlan(request, catalog).writes, []);
});

test('an exact fictional bench certificate produces a pure guarded write/readback plan', () => {
  const catalog = [{ ...safe.selection, capability: 'native_charge_block_discharge_auto', certified: true,
    readback: true, watchdog: true, chargeBlockWrites: [{ address: 41, value: 0 }],
    readbackChecks: [{ address: 41, equals: 0 }], releaseWrites: [{ address: 41, value: 100 }],
    releaseReadbackChecks: [{ address: 41, equals: 100 }], watchdogSpec: { timeoutS: 30 } }];
  const plan = nativeWritePlan(safe, catalog);
  assert.equal(plan.path, 'autonomous_discharge');
  assert.deepEqual(plan.writes, [{ address: 41, value: 0 }]);
  assert.deepEqual(plan.readback, [{ address: 41, equals: 0 }]);

  const release = nativeWritePlan({ ...safe, authorized: false, releaseRequested: true }, catalog);
  assert.equal(release.path, 'release');
  assert.deepEqual(release.writes, [{ address: 41, value: 100 }]);
  assert.deepEqual(release.readback, [{ address: 41, equals: 100 }]);
});

test('an incomplete certificate can never produce a native write plan', () => {
  const incomplete = [{ ...safe.selection, capability: 'native_charge_block_discharge_auto', certified: true,
    readback: true, watchdog: true, chargeBlockWrites: [{ address: 41, value: 0 }],
    readbackChecks: [{ address: 41, equals: 0 }], watchdogSpec: { timeoutS: 30 } }];
  assert.equal(nativeWritePlan(safe, incomplete).path, 'idle_follow');
  assert.deepEqual(nativeWritePlan(safe, incomplete).writes, []);
});

test('every missing safety fact fails closed before capability selection', () => {
  for (const patch of [
    { authorized: false }, { emergencyStop: true }, { firstLightGranted: false },
    { measurementsFresh: false }, { communicationHealthy: false }, { readbackHealthy: false },
    { socPct: NaN }, { effectiveFloorSocPct: NaN }, { socPct: 35 },
  ]) {
    assert.equal(nativeWritePlan({ ...safe, ...patch }).path, 'disabled');
  }
});

// --- the RELEASE mechanics ---------------------------------------------------

test('the Deye interlock lifts only per-entry, with evidence - never by a wildcard', () => {
  const sel = { brand: 'Deye', model: 'SUN-30K-SG01HP3-EU', firmware: 'V1' };
  const base = {
    ...sel, capability: 'native_charge_block_discharge_auto', certified: true,
    readback: true, watchdog: true,
    chargeBlockWrites: [{ addr: 1100, value: 0 }], readbackChecks: [{ addr: 1100, expect: 0 }],
    releaseWrites: [{ addr: 1100, value: 1 }], releaseReadbackChecks: [{ addr: 1100, expect: 1 }],
    watchdogSpec: { timeoutS: 60 },
  };
  // A complete entry alone is still refused - that is the interlock.
  assert.equal(exactCapability(sel, [base]), null);
  // The lift needs BOTH the explicit marker and a named bench record.
  assert.equal(exactCapability(sel, [{ ...base, interlockLifted: 'deye' }]), null);
  assert.equal(exactCapability(sel, [{ ...base, benchRecord: 'x' }]), null);
  assert.ok(exactCapability(sel, [{ ...base, interlockLifted: 'deye', benchRecord: 'bench 2026-09-01' }]));
  // And no other manufacturer is affected by the marker's absence.
  const other = { brand: 'Example', model: 'Lab-1', firmware: '1.2.3' };
  assert.ok(exactCapability(other, [{ ...base, ...other }]));
});

test('a certificate that no longer describes the shipped plan is refused', () => {
  const cap = {
    brand: 'x', model: 'y', firmware: 'z', capability: 'native_charge_block_discharge_auto',
    certified: true, readback: true, watchdog: true,
    chargeBlockWrites: [{ addr: 41, value: 0 }, { addr: 40, value: 0 }],
    readbackChecks: [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }],
    releaseWrites: [], releaseReadbackChecks: [], watchdogSpec: {},
  };
  assert.equal(certificateMatchesPlan(cap,
    [{ addr: 41, value: 0 }, { addr: 40, value: 0 }],
    [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }]), true);
  // A changed VALUE, a changed ORDER, an extra op and a changed readback each
  // mean the bench measured something else.
  assert.equal(certificateMatchesPlan(cap,
    [{ addr: 41, value: 1 }, { addr: 40, value: 0 }],
    [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }]), false);
  assert.equal(certificateMatchesPlan(cap,
    [{ addr: 40, value: 0 }, { addr: 41, value: 0 }],
    [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }]), false);
  assert.equal(certificateMatchesPlan(cap,
    [{ addr: 41, value: 0 }, { addr: 40, value: 0 }, { addr: 42, value: 0 }],
    [{ addr: 41, expect: 0 }, { addr: 40, expect: 0 }]), false);
  assert.equal(certificateMatchesPlan(cap,
    [{ addr: 41, value: 0 }, { addr: 40, value: 0 }],
    [{ addr: 41, expect: 1 }, { addr: 40, expect: 0 }]), false);
  assert.equal(certificateMatchesPlan(null, [], []), false);
});

test('the simulator catalog certifies SOFTWARE and can match nothing else', () => {
  assert.equal(SIMULATOR_NATIVE_CAPABILITIES.length, 1);
  const e = SIMULATOR_NATIVE_CAPABILITIES[0];
  assert.equal(e.simulatorOnly, true);
  assert.equal(e.brand, 'generic_modbus');
  assert.equal(e.model, 'sunspec-sim');
  // It is NOT in the production catalog - that is what keeps every real device
  // on the follower until a bench session says otherwise.
  assert.deepEqual(CERTIFIED_NATIVE_CAPABILITIES, []);
});
