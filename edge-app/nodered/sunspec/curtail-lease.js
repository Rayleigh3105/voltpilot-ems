'use strict';

/**
 * sunspec/curtail-lease - the BOUNDED write-priority lease between the
 * curtailment executor and the source read poll on a SHARED Modbus gateway
 * (the Fronius Datamanager: several inverters, ONE Modbus service, kill-oldest
 * on a second TCP connection).
 *
 * WHY THIS EXISTS (live incident, Pilsting 2026-07-28): the executor's raw
 * `curtail_want` timestamp was announced on EVERY ~10 s setpoint tick - even
 * for observe-only readbacks and for discovery walks that failed and were
 * retried EVERY tick with no backoff and no overall deadline. Against a
 * Datamanager whose Modbus service was restarting, each cycle burned chains of
 * 8-s timeouts while holding the claim, the next tick re-claimed seconds
 * later, and the read poll (which yielded UNCONDITIONALLY to a fresh claim)
 * starved BOTH sources for 15+ minutes; the rare free window always fell to
 * the first source in the list, so unit 2 was never read again. The claim was
 * released per cycle, but the SYSTEM re-claimed with a near-100 % duty cycle,
 * indefinitely.
 *
 * The lease rules (both nodes embed this module; flows-sync.test.js pins it):
 *
 *   1. A claim is a HEARTBEATED lease: the holder re-stamps the timestamp
 *      between ops. A claim older than CLAIM_TTL_MS is DEAD (crashed/wedged
 *      holder) - the poll clears it, warns, and reads. So even a claim whose
 *      holder never reaches its release dies on its own within the TTL.
 *   2. The poll yields to a LIVE claim at most MAX_CLAIM_SKIPS consecutive
 *      ticks PER SOURCE, then forces its read with a warning - telemetry can
 *      never starve regardless of claim churn. (The forced read may displace
 *      a wedged executor connection on a kill-oldest gateway - that actively
 *      un-wedges it; a healthy write burst finishes well inside the budget.)
 *   3. One executor gateway-cycle runs under a hard time budget
 *      (EXEC_DEADLINE_MS, per-op timeouts capped to the remaining budget), so
 *      a single claim-hold is bounded far tighter than the calibration test
 *      (TTL 120 s) plus the native revert grace (60 s).
 *   4. A FAILED discovery walk is cached with a backoff (DISC_FAIL_BACKOFF_MS)
 *      instead of being retried every tick; a successful walk keeps the 1-h
 *      cache (DISC_CACHE_MS).
 *   5. Observe-only readbacks (nothing to write, nothing to discover) take NO
 *      claim at all and run at most every OBSERVE_MIN_MS per gateway - the
 *      write PRIORITY exists only while there is write WORK.
 *
 * PURITY: no I/O, no Date.now() - every function takes nowMs (the curtail.js
 * discipline). Node-RED function nodes embed this file verbatim via
 * build-flows.js embedModule (they cannot `require`).
 */

// A claim older than this is dead: the holder crashed or wedged before its
// release. Holders MUST heartbeat (re-stamp) between ops; every executor op is
// capped at 8 s, so a live holder always refreshes well inside the TTL.
const CLAIM_TTL_MS = 15000;

// How many consecutive poll ticks ONE source yields to a live claim before its
// read is forced (the sv5 maxSkips discipline). At the 5-s poll cadence this
// bounds a source's claim-induced telemetry gap to ~20 s - far inside the 60-s
// reading-freshness windows.
const MAX_CLAIM_SKIPS = 3;

// The hard time budget of one executor gateway-cycle (connect + walk + writes
// + readbacks). Per-op timeouts are capped to the remaining budget, so a
// trickling half-dead gateway can never hold a claim beyond ~this.
const EXEC_DEADLINE_MS = 25000;

// A successful discovery walk is cached this long (the pre-existing 1 h).
const DISC_CACHE_MS = 3600000;

// A FAILED walk (gateway unreachable, garbage, deadline) is cached this long -
// the walk retries after the backoff instead of on every ~10 s tick.
const DISC_FAIL_BACKOFF_MS = 120000;

// Observe-only readbacks (no writes, no walk due) run at most this often per
// gateway - and they take no claim.
const OBSERVE_MIN_MS = 60000;

// Per-op floor/ceiling for deadline-capped op timeouts.
const OP_TIMEOUT_MAX_MS = 8000;
const OP_TIMEOUT_MIN_MS = 250;

/**
 * claimState - classify a claim timestamp: 'none' (no claim), 'live' (within
 * the TTL) or 'stale' (holder dead - past the TTL without a heartbeat).
 */
function claimState(claimAt, nowMs) {
  const at = Number(claimAt) || 0;
  if (!at) return 'none';
  return nowMs - at < CLAIM_TTL_MS ? 'live' : 'stale';
}

/**
 * pollDecision - what the read poll does for ONE source facing the gateway's
 * claim. { claimAt, nowMs, skips } -> { action, skips, heldMs? }:
 *
 *   'read'   no live claim - read normally.
 *   'yield'  live claim, skip budget left - skip this tick (skips = the new
 *            counter to store).
 *   'force'  live claim but the source has yielded MAX_CLAIM_SKIPS ticks in a
 *            row - read ANYWAY (warn: telemetry must not starve).
 *   'expire' the claim is stale (dead holder) - clear it, warn (heldMs = how
 *            long it sat unreleased), and read.
 *
 * For every action except 'yield' the stored skip counter resets to 0.
 */
function pollDecision(args) {
  const a = args || {};
  const nowMs = Number(a.nowMs) || 0;
  const skips = Number(a.skips) || 0;
  const st = claimState(a.claimAt, nowMs);
  if (st === 'none') return { action: 'read', skips: 0 };
  if (st === 'stale') return { action: 'expire', skips: 0, heldMs: nowMs - Number(a.claimAt) };
  if (skips >= MAX_CLAIM_SKIPS) return { action: 'force', skips: 0 };
  return { action: 'yield', skips: skips + 1 };
}

/**
 * discoveryState - classify a cached discovery entry (`curtail_disc:*`):
 *
 *   'fresh'          a successful walk within DISC_CACHE_MS - plan with it.
 *   'failed_backoff' a failed walk within DISC_FAIL_BACKOFF_MS - do NOT
 *                    re-walk yet; publish the cached reason.
 *   'due'            no usable cache - walk this tick.
 *
 * Cache shapes: success = { at, disc } (disc truthy; a completed walk whose
 * device lacks Model 123 is ALSO a success - a firmware fact, cached 1 h);
 * failure = { at, failed: true, reason } (unreachable / garbage / deadline).
 */
function discoveryState(cached, nowMs) {
  if (cached && cached.disc && nowMs - (Number(cached.at) || 0) < DISC_CACHE_MS) return 'fresh';
  if (cached && cached.failed && nowMs - (Number(cached.at) || 0) < DISC_FAIL_BACKOFF_MS) return 'failed_backoff';
  return 'due';
}

/**
 * observeDue - is an observe-only readback pass due for this gateway?
 */
function observeDue(lastObserveAt, nowMs) {
  return nowMs - (Number(lastObserveAt) || 0) >= OBSERVE_MIN_MS;
}

/**
 * opTimeoutMs - the timeout for the NEXT op, capped to the remaining cycle
 * budget (floor OP_TIMEOUT_MIN_MS so an op already past the deadline still
 * fails fast instead of hanging on a 0 ms timer).
 */
function opTimeoutMs(deadlineAt, nowMs) {
  const rem = (Number(deadlineAt) || 0) - (Number(nowMs) || 0);
  return Math.max(OP_TIMEOUT_MIN_MS, Math.min(OP_TIMEOUT_MAX_MS, rem));
}

module.exports = {
  CLAIM_TTL_MS,
  MAX_CLAIM_SKIPS,
  EXEC_DEADLINE_MS,
  DISC_CACHE_MS,
  DISC_FAIL_BACKOFF_MS,
  OBSERVE_MIN_MS,
  OP_TIMEOUT_MAX_MS,
  OP_TIMEOUT_MIN_MS,
  claimState,
  pollDecision,
  discoveryState,
  observeDue,
  opTimeoutMs,
};
