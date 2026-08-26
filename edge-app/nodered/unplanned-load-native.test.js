'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEYE_REMOTE_PR978_FIRMWARE,
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

test('production releases the pilot and NOTHING else', () => {
  // Since 2026-08-26 the catalog is no longer empty - it carries EXACTLY the
  // pilot, and this test is what keeps "exactly" true: a second entry, or a
  // broader key on this one, has to be a deliberate edit here.
  assert.equal(CERTIFIED_NATIVE_CAPABILITIES.length, 1);
  const pilot = CERTIFIED_NATIVE_CAPABILITIES[0];
  assert.deepEqual(
    { brand: pilot.brand, model: pilot.model, firmware: pilot.firmware },
    { brand: 'deye', model: 'sun-30k-sg01hp3', firmware: DEYE_REMOTE_PR978_FIRMWARE });
  // Any other device is still on the proven follower.
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
  // It is NOT in the production catalog - a piece of software must never be able
  // to release a customer's inverter.
  assert.ok(!CERTIFIED_NATIVE_CAPABILITIES.some((c) => c.simulatorOnly === true));
  assert.ok(!CERTIFIED_NATIVE_CAPABILITIES.some((c) => c.brand === e.brand && c.model === e.model));
});

// --- THE PILOT RELEASE (2026-08-26) ------------------------------------------
//
// The captain's decision was "kein separater Prüfstand - der Deye-Pilot IST der
// Prüfstand". These tests pin what that release is BOUND to, because the whole
// safety argument of the catalog is that the binding is narrow.

const PILOT_KEY = { brand: 'deye', model: 'sun-30k-sg01hp3', firmware: DEYE_REMOTE_PR978_FIRMWARE };

test('the pilot matches on its exact model AND the probed firmware, nothing wider', () => {
  assert.ok(exactCapability(PILOT_KEY), 'the pilot itself resolves');

  // A SISTER MODEL of the same family is not released - the register map is
  // shared, the bench result is not.
  for (const model of ['sun-50k-sg01hp3', 'sun-29.9k-sg01hp3', 'sun-12k-sg04lp3']) {
    assert.equal(exactCapability({ ...PILOT_KEY, model }), null, model);
  }
  // The same device on a firmware WITHOUT the PR-978 remote block: the adapter
  // never produces this key, and an operator-typed string can never stand in
  // for it.
  for (const firmware of ['', undefined, 'V105.1', 'remote-v105_1', 'sim']) {
    assert.equal(exactCapability({ ...PILOT_KEY, firmware }), null, String(firmware));
  }
  // And it is a Deye, so the interlock still applies to it - it only passes
  // because ITS OWN entry carries both halves of the lift.
  const pilot = CERTIFIED_NATIVE_CAPABILITIES[0];
  assert.equal(pilot.interlockLifted, 'deye');
  assert.ok(typeof pilot.benchRecord === 'string' && pilot.benchRecord !== '');
  assert.equal(exactCapability(PILOT_KEY, [{ ...pilot, interlockLifted: undefined }]), null);
  assert.equal(exactCapability(PILOT_KEY, [{ ...pilot, benchRecord: '' }]), null);
});

test('the pilot certificate describes the hand-over the adapter really plans', () => {
  // The Deye hand-over is a SINGLE write: disabling remote mode (1100 <- 0), with
  // the same register read back as the proof. If the adapter ever plans something
  // else, certificateMatchesPlan refuses - this pins the bytes the release stands
  // on so that refusal cannot be silently "fixed" by editing the certificate.
  const pilot = CERTIFIED_NATIVE_CAPABILITIES[0];
  assert.deepEqual(pilot.chargeBlockWrites, [{ addr: 0x044c, value: 0 }]);
  assert.deepEqual(pilot.readbackChecks, [{ addr: 0x044c, expect: 0 }]);
  assert.equal(certificateMatchesPlan(pilot,
    [{ addr: 0x044c, value: 0 }], [{ addr: 0x044c, expect: 0 }]), true);
  // The take-back is the ORDINARY remote plan; the certificate names its decisive
  // register (the enable that ends the native mode), never a second copy of the
  // full ordered sequence.
  assert.deepEqual(pilot.releaseWrites, [{ addr: 0x044c, value: 1 }]);
  assert.deepEqual(pilot.releaseReadbackChecks, [{ addr: 0x044c, expect: 1 }]);
  // The dead-man is the DEVICE's own (1101) - "stop writing" is the failsafe here.
  assert.equal(pilot.watchdogSpec.timeoutS, 60);
});
