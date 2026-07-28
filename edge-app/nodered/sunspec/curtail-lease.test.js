'use strict';

// Unit tests for sunspec/curtail-lease.js - the bounded write-priority lease
// between the curtailment executor and the source read poll (the Pilsting
// 2026-07-28 starvation incident). Pure decision logic; the behavioral proofs
// against the REAL flow node bodies live in curtail-lease.e2e.test.js.

const test = require('node:test');
const assert = require('node:assert');

const lease = require('./curtail-lease');

const T0 = 1_000_000_000;

test('claimState: none / live / stale', () => {
  assert.strictEqual(lease.claimState(0, T0), 'none');
  assert.strictEqual(lease.claimState(undefined, T0), 'none');
  assert.strictEqual(lease.claimState(T0 - 1, T0), 'live');
  assert.strictEqual(lease.claimState(T0 - lease.CLAIM_TTL_MS + 1, T0), 'live');
  assert.strictEqual(lease.claimState(T0 - lease.CLAIM_TTL_MS, T0), 'stale');
  assert.strictEqual(lease.claimState(T0 - 20 * 60 * 1000, T0), 'stale');
});

test('pollDecision: no claim reads and resets the skip counter', () => {
  assert.deepStrictEqual(
    lease.pollDecision({ claimAt: 0, nowMs: T0, skips: 2 }),
    { action: 'read', skips: 0 },
  );
});

test('pollDecision: a live claim yields at most MAX_CLAIM_SKIPS ticks, then forces', () => {
  const claimAt = T0 - 1000;
  let skips = 0;
  for (let i = 1; i <= lease.MAX_CLAIM_SKIPS; i++) {
    const d = lease.pollDecision({ claimAt, nowMs: T0, skips });
    assert.strictEqual(d.action, 'yield', 'tick ' + i + ' yields');
    assert.strictEqual(d.skips, i, 'counter increments');
    skips = d.skips;
  }
  const forced = lease.pollDecision({ claimAt, nowMs: T0, skips });
  assert.strictEqual(forced.action, 'force', 'budget exhausted -> read anyway');
  assert.strictEqual(forced.skips, 0, 'force resets the counter');
});

test('pollDecision: a stale claim expires (dead holder) and reads', () => {
  const heldFor = lease.CLAIM_TTL_MS + 5000;
  const d = lease.pollDecision({ claimAt: T0 - heldFor, nowMs: T0, skips: 1 });
  assert.strictEqual(d.action, 'expire');
  assert.strictEqual(d.skips, 0);
  assert.strictEqual(d.heldMs, heldFor, 'reports how long the claim sat unreleased');
});

test('discoveryState: success cache is fresh for DISC_CACHE_MS', () => {
  const disc = { ok: true };
  assert.strictEqual(lease.discoveryState({ at: T0 - 1, disc }, T0), 'fresh');
  assert.strictEqual(
    lease.discoveryState({ at: T0 - lease.DISC_CACHE_MS + 1, disc }, T0), 'fresh',
  );
  assert.strictEqual(
    lease.discoveryState({ at: T0 - lease.DISC_CACHE_MS, disc }, T0), 'due',
    'an expired success cache walks again',
  );
});

test('discoveryState: a failed walk backs off instead of re-walking every tick', () => {
  const failed = { at: T0 - 1, failed: true, reason: 'SunSpec-Modelle nicht lesbar' };
  assert.strictEqual(lease.discoveryState(failed, T0), 'failed_backoff');
  assert.strictEqual(
    lease.discoveryState({ at: T0 - lease.DISC_FAIL_BACKOFF_MS, failed: true }, T0), 'due',
    'after the backoff the walk retries',
  );
  // The two pre-fix broken cache shapes both walk (they carry no marker):
  assert.strictEqual(lease.discoveryState(undefined, T0), 'due');
  assert.strictEqual(lease.discoveryState({ at: T0 - 1, disc: null }, T0), 'due');
});

test('observeDue: at most one observe pass per OBSERVE_MIN_MS', () => {
  assert.strictEqual(lease.observeDue(0, T0), true, 'never observed -> due');
  assert.strictEqual(lease.observeDue(T0 - 1000, T0), false);
  assert.strictEqual(lease.observeDue(T0 - lease.OBSERVE_MIN_MS, T0), true);
});

test('opTimeoutMs: capped to the remaining budget, floored, ceilinged', () => {
  assert.strictEqual(lease.opTimeoutMs(T0 + 60000, T0), lease.OP_TIMEOUT_MAX_MS);
  assert.strictEqual(lease.opTimeoutMs(T0 + 3000, T0), 3000);
  assert.strictEqual(lease.opTimeoutMs(T0 - 1, T0), lease.OP_TIMEOUT_MIN_MS,
    'past the deadline an op still fails fast instead of hanging');
});

test('the lease is bounded far tighter than the calibration test + revert grace', () => {
  // curtailcal.DefaultTTL = 120 s, native WMaxLimPct_RvrtTms = 60 s. The task
  // invariant: a claim's bounds must sit well inside test + revert grace.
  const testPlusRevertMs = 120000 + 60000;
  assert.ok(lease.EXEC_DEADLINE_MS < testPlusRevertMs / 4, 'one cycle is a fraction of the test');
  assert.ok(lease.CLAIM_TTL_MS < lease.EXEC_DEADLINE_MS, 'a dead holder expires before a live cycle ends');
});
