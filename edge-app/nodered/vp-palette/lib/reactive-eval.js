/**
 * reactive-eval - the PURE evaluation engine of the generated consumer-policy
 * node (vp-consumer-policy, Verbrauchssteuerung Inkrement 4 §5.1/§5.3/§13.2).
 *
 * It owns every rule a reactive Pflichtregel's honesty rests on, with no I/O
 * so all of them are unit-testable:
 *
 *   - THREE-STATE logic 'true' | 'false' | 'unknown' (Kleene): an unknown
 *     condition NEVER starts a consumer, and a stale signal is unknown -
 *     never 0, never false-as-if-measured (§3.3).
 *   - Per-signal FRESHNESS: a local signal older than its max_age_s is
 *     unknown.
 *   - HYSTERESIS via reset_value: a threshold engages at `value` and only
 *     releases past `reset_value`, so a noisy SoC/PV-surplus signal cannot
 *     flap the consumer (§5.3). Between the two thresholds the previous
 *     verdict holds.
 *   - Precompiled UTC WINDOWS (D1: price/time conditions are compiled in the
 *     cloud): inside a window -> true, between windows -> false, AFTER the
 *     last window -> 'unknown' - the rule that an expired window never
 *     restarts a rule (§13.5).
 *   - OFF-DELAY debounce: when the merged condition ends, the previous target
 *     is HELD for off_delay_s before the engine reports inactive - a
 *     flickering vehicle_connected does not stop the charge mid-blink (§5.1).
 *     The hold applies only to ENDING; starting is immediate and only ever
 *     from a true (never unknown) condition.
 *
 * The engine merges multiple active requirements into ONE target (§7): the
 * highest requested value wins (on_off: an active requirement means ON), and
 * override (must_run) is claimed exactly when an ACTIVE requirement carries
 * must_run.
 */
'use strict';

const TRUE = 'true';
const FALSE = 'false';
const UNKNOWN = 'unknown';

function kleeneNot(v) {
  if (v === TRUE) return FALSE;
  if (v === FALSE) return TRUE;
  return UNKNOWN;
}

function kleeneAll(list) {
  let unknown = false;
  for (const v of list) {
    if (v === FALSE) return FALSE;
    if (v === UNKNOWN) unknown = true;
  }
  return unknown ? UNKNOWN : TRUE;
}

function kleeneAny(list) {
  let unknown = false;
  for (const v of list) {
    if (v === TRUE) return TRUE;
    if (v === UNKNOWN) unknown = true;
  }
  return unknown ? UNKNOWN : FALSE;
}

function compare(op, v, threshold) {
  switch (op) {
    case 'lt': return v < threshold;
    case 'lte': return v <= threshold;
    case 'gt': return v > threshold;
    case 'gte': return v >= threshold;
    case 'eq': return v === threshold;
    case 'ne': return v !== threshold;
    default: return false;
  }
}

/** Numeric coercion for spec values (booleans ride telemetry as 0/1). */
function numeric(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/**
 * Evaluate the precompiled window list at `nowMs`. Windows are chronological
 * [fromIso, toIso] pairs; from-inclusive, to-exclusive.
 */
function evalWindows(windows, nowMs) {
  if (!Array.isArray(windows) || windows.length === 0) return UNKNOWN;
  let lastEnd = -Infinity;
  for (const w of windows) {
    const from = Date.parse(w[0]);
    const to = Date.parse(w[1]);
    if (!isFinite(from) || !isFinite(to)) return UNKNOWN;
    if (nowMs >= from && nowMs < to) return TRUE;
    if (to > lastEnd) lastEnd = to;
  }
  // After the LAST precomputed window the cloud's answer has run out - the
  // condition is unknown, never "false and safe to invert" (§13.5).
  return nowMs >= lastEnd ? UNKNOWN : FALSE;
}

/**
 * Evaluate one local signal leaf against a sample {value, atMs} (or null).
 * `sticky` carries the leaf's previous hysteresis verdict (boolean|undefined).
 * Returns {state, sticky}.
 */
function evalLeaf(leaf, sample, sticky, nowMs) {
  if (!sample) return { state: UNKNOWN, sticky };
  const maxAge = Number(leaf.max_age_s);
  if (!(maxAge >= 1) || nowMs - sample.atMs > maxAge * 1000) {
    // Stale: unknown, and the hysteresis memory is DROPPED - a signal that
    // went dark must re-prove its state, never resume from memory.
    return { state: UNKNOWN, sticky: undefined };
  }
  const v = numeric(sample.value);
  const threshold = numeric(leaf.value);
  if (v === null || threshold === null) return { state: UNKNOWN, sticky };

  const reset = numeric(leaf.reset_value);
  if (reset === null || leaf.reset_value === undefined
      || (leaf.op !== 'lt' && leaf.op !== 'lte' && leaf.op !== 'gt' && leaf.op !== 'gte')) {
    // No hysteresis (eq/ne or none configured): direct comparison.
    return { state: compare(leaf.op, v, threshold) ? TRUE : FALSE, sticky: undefined };
  }

  // Hysteresis: engage past the threshold, release past reset_value, hold in
  // between. Initial verdict in the dead band is FALSE (never start unproven).
  const engaged = compare(leaf.op, v, threshold);
  const released = (leaf.op === 'gt' || leaf.op === 'gte') ? v < reset : v > reset;
  let on;
  if (engaged) on = true;
  else if (released) on = false;
  else on = sticky === true;
  return { state: on ? TRUE : FALSE, sticky: on };
}

/**
 * The stateful engine. `spec` is the vp.consumer.reactive parameter object
 * (already validated by flowc): {command, off_delay_s, requirements:[{id,
 * must_run, value, condition}]}.
 */
class Engine {
  constructor(spec) {
    this.spec = spec || {};
    this.signals = {}; // 'site:<channel>' / 'entity:<channel>' -> {value, atMs}
    this.sticky = {}; // leaf key -> previous hysteresis verdict
    this.held = null; // the target being off-delay-held, or null
    this.heldSince = null;
  }

  updateSignal(source, channel, value, atMs) {
    this.signals[source + ':' + channel] = { value, atMs };
  }

  evalTree(cond, keyPrefix, nowMs) {
    if (!cond || typeof cond !== 'object') return UNKNOWN;
    if (Array.isArray(cond.all)) {
      return kleeneAll(cond.all.map((c, i) => this.evalTree(c, keyPrefix + '.all' + i, nowMs)));
    }
    if (Array.isArray(cond.any)) {
      return kleeneAny(cond.any.map((c, i) => this.evalTree(c, keyPrefix + '.any' + i, nowMs)));
    }
    if (cond.not !== undefined) {
      return kleeneNot(this.evalTree(cond.not, keyPrefix + '.not', nowMs));
    }
    if (cond.windows !== undefined) {
      return evalWindows(cond.windows, nowMs);
    }
    if (typeof cond.signal === 'string') {
      const sample = this.signals[cond.source + ':' + cond.channel] || null;
      const r = evalLeaf(cond, sample, this.sticky[keyPrefix], nowMs);
      this.sticky[keyPrefix] = r.sticky;
      return r.state;
    }
    return UNKNOWN;
  }

  /**
   * Evaluate all requirements at `nowMs`.
   * Returns {active, mustRun, value, requirementIds, held, anyUnknown}.
   * `held` = true while only the off-delay keeps the target alive.
   */
  evaluate(nowMs) {
    const reqs = Array.isArray(this.spec.requirements) ? this.spec.requirements : [];
    const active = [];
    let anyUnknown = false;
    for (const req of reqs) {
      const state = this.evalTree(req.condition, String(req.id), nowMs);
      if (state === TRUE) active.push(req);
      else if (state === UNKNOWN) anyUnknown = true;
    }

    if (active.length > 0) {
      const target = {
        mustRun: active.some((r) => r.must_run === true),
        value: this.mergeValue(active),
        requirementIds: active.map((r) => r.id),
      };
      this.held = target; // remembered so an ENDING can off-delay-hold it
      this.heldSince = null;
      return { active: true, held: false, anyUnknown, ...target };
    }

    // Nothing true (false or unknown): apply the off-delay to an ENDING
    // target. Unknown never STARTS - but a target that was running keeps its
    // debounce window whether the end came from false or from unknown.
    const offDelayMs = Math.max(0, Number(this.spec.off_delay_s) || 0) * 1000;
    if (this.held && offDelayMs > 0) {
      if (this.heldSince === null) this.heldSince = nowMs;
      if (nowMs - this.heldSince < offDelayMs) {
        return { active: true, held: true, anyUnknown, ...this.held };
      }
    }
    this.held = null;
    this.heldSince = null;
    return { active: false, held: false, anyUnknown };
  }

  mergeValue(active) {
    const command = this.spec.command;
    if (command === 'on_off') return true;
    if (command === 'setpoint_kw') {
      let max = null;
      for (const r of active) {
        const v = numeric(r.value);
        if (v !== null && (max === null || v > max)) max = v;
      }
      return max;
    }
    // mode: document order decides (deterministic).
    return active[0].value;
  }
}

module.exports = {
  Engine,
  evalWindows,
  evalLeaf,
  kleeneAll,
  kleeneAny,
  kleeneNot,
  TRUE,
  FALSE,
  UNKNOWN,
};
