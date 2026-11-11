/**
 * consumer-policy-runtime - the I/O-free half of the generated vp-consumer-policy
 * node: signal mapping, evaluation and the publish decision, with the clock as
 * an input. The node wires it to the local bus; Edge Light runs the Go twin
 * (edge-app/core/internal/verbraucherregel) against the SAME vectors
 * (docs/contracts/v2/verbraucherregel-vectors.json), so both box kinds turn one
 * compiled rule into the same desired.
 *
 * Publish rule (unchanged from the node): a compiled interval tick (the TTL
 * renewal cadence) ALWAYS re-publishes while active; a telemetry-driven
 * evaluation publishes only when the desired CHANGED (transition / new value),
 * so a 5-s telemetry loop cannot multiply the renewal rate. Withdrawal is the
 * absence of renewal - there is no release message.
 */
'use strict';

const { Engine } = require('./reactive-eval');
const { shape } = require('../nodes/vp-desired');

/**
 * siteSignals(): map one composite edge/telemetry payload onto the site
 * signal channels. Absent inputs stay absent - the surplus is only computable
 * when BOTH pv and load were measured (never a fabricated 0, §3.3).
 */
function siteSignals(obj) {
  if (obj == null || typeof obj !== 'object') return {};
  const out = {};
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const soc = num(obj.soc_pct);
  if (soc !== null) out.soc_pct = soc;
  const grid = num(obj.power_kw);
  if (grid !== null) out.grid_power_kw = grid;
  const pv = num(obj.pv_power_kw);
  const load = num(obj.load_kw);
  if (pv !== null && load !== null) out.pv_surplus_kw = pv - load;
  return out;
}

/** entitySignals(): numeric channels of one entity telemetry payload. */
function entitySignals(entity, obj) {
  if (obj == null || typeof obj !== 'object') return {};
  if (obj.schema_version !== '1.0' || obj.entity_id !== entity) return {};
  const channels = obj.channels;
  if (channels == null || typeof channels !== 'object') return {};
  const out = {};
  for (const key of Object.keys(channels)) {
    const v = channels[key];
    if (typeof v === 'number' && isFinite(v)) out[key] = v;
  }
  return out;
}

/**
 * Runtime of ONE generated node. `config` is the node's compiled config
 * (entity, command, ttl_s, off_delay_s, requirements, flowId, flowVersion,
 * nodeId|id). Every method returns {result, publish, unusable}: `publish` is the
 * desired payload to send now (or null), `result` the engine verdict and
 * `unusable` true when a publish was due but the value has no desired shape.
 */
class Runtime {
  constructor(config) {
    this.entity = String(config.entity || '');
    this.engine = new Engine({
      command: config.command,
      off_delay_s: Number(config.off_delay_s) || 0,
      requirements: Array.isArray(config.requirements) ? config.requirements : [],
    });
    this.baseCfg = {
      entity: this.entity,
      command: config.command,
      ttl_s: config.ttl_s,
      flowId: config.flowId,
      flowVersion: config.flowVersion,
      nodeId: config.nodeId || config.id,
    };
    this.lastFingerprint = null; // of the last published desired
  }

  shapeAt(result, nowMs) {
    return shape({ ...this.baseCfg, override: result.mustRun === true }, result.value,
      new Date(nowMs).toISOString());
  }

  evaluate(fromTrigger, nowMs) {
    const result = this.engine.evaluate(nowMs);
    let publish = null;
    let unusable = false; // wanted to publish, but the target value has no desired shape
    if (result.active) {
      const payload = this.shapeAt(result, nowMs);
      const fingerprint = payload ? payload.request_id + '|' + (result.mustRun === true) : null;
      if (fromTrigger || fingerprint !== this.lastFingerprint) {
        if (payload) {
          publish = payload;
          this.lastFingerprint = fingerprint;
        } else {
          unusable = true;
        }
      }
    } else {
      this.lastFingerprint = null;
    }
    return { result, publish, unusable };
  }

  /** A composite edge/telemetry message arrived. */
  onSite(obj, nowMs) {
    const signals = siteSignals(obj);
    for (const key of Object.keys(signals)) this.engine.updateSignal('site', key, signals[key], nowMs);
    return this.evaluate(false, nowMs); // react immediately
  }

  /** The entity's own edge/entities/<entity>/telemetry message arrived. */
  onEntity(obj, nowMs) {
    const signals = entitySignals(this.entity, obj);
    for (const key of Object.keys(signals)) this.engine.updateSignal('entity', key, signals[key], nowMs);
    return this.evaluate(false, nowMs); // react immediately (Fahrzeug anstecken -> sofort)
  }

  /** The compiled interval trigger fired (renewal + staleness re-check). */
  onTrigger(nowMs) {
    return this.evaluate(true, nowMs);
  }
}

module.exports = { Runtime, siteSignals, entitySignals };
