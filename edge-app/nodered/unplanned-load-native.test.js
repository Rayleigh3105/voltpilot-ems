'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CERTIFIED_NATIVE_CAPABILITIES, nativeWritePlan } = require('./unplanned-load-native');

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
