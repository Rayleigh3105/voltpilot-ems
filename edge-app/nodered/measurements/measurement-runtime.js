'use strict';

const { buildPlan, Scheduler } = require('./measurement-planner');
const { resolvePoint, decodeRegisters, decodeDerived, derivedAddresses,
  decodeJSON, decodeOcppSampledValue, templateKey } = require('./measurement-driver');

/**
 * Read-only runtime. Every I/O primitive is injected for bench simulation;
 * there is deliberately no write-register primitive in this module.
 */
class MeasurementRuntime {
  constructor(io, publish, now) {
    this.io = io || {}; this.publish = publish || (() => {}); this.now = now || (() => new Date());
    this.active = null; this.scheduler = new Scheduler(); this.due = new Map();
  }

  apply(config, options) {
    const planning = Object.assign({ discovery:this.io.discovery,
      ocppCapability:this.io.ocppCapability }, options || {});
    const candidate = buildPlan(config, planning);
    if (candidate.applied) {
      // One pointer swap is the atomic cutover. No timer from the previous
      // plan survives because due is replaced together with active.
      const due = new Map(candidate.selections.map((s) => [s.point.point_key, 0]));
      this.active = candidate; this.due = due;
    }
    this.publish('edge/measurements/config-status', {
      revision: config.revision, applied_at: this.now().toISOString(),
      accepted: candidate.accepted, rejected: candidate.rejected,
    }, true);
    return candidate;
  }

  enqueueControl(run) { this.scheduler.enqueueControl({ kind:'control', run }); }

  async tick() {
    if (!this.active) return [];
    const now = this.now(); const ms = now.getTime(); const dueKeys = new Set();
    for (const s of this.active.selections) if ((this.due.get(s.point.point_key) || 0) <= ms) dueKeys.add(s.point.point_key);
    if (!dueKeys.size) return [];
    const blocks = this.active.blocks.filter((b) => b.points.some((p) => dueKeys.has(p)));
    for (const block of blocks) this.scheduler.enqueuePoll({ kind: 'modbus', block });
    for (const group of this.active.httpGroups) this.scheduler.enqueuePoll({ kind: 'json', group });
    const samples = []; const wireWords = new Map();
    for (let task; (task = this.scheduler.next());) {
      if (task.kind === 'control') { await task.run(); continue; }
      if (task.kind === 'modbus') samples.push(...await this.readBlock(task.block, dueKeys, wireWords));
      else if (task.kind === 'json') samples.push(...await this.readJSON(task.group, dueKeys));
    }
    for (const selected of this.active.selections) {
      if (!dueKeys.has(selected.point.point_key) || selected.point.address
          || !derivedAddresses(selected.point).length) continue;
      const sample = decodeDerived(selected.point, wireWords);
      if (sample) samples.push(sample);
    }
    for (const s of this.active.selections) if (dueKeys.has(s.point.point_key)) this.due.set(s.point.point_key, ms + s.cadence_s * 1000);
    if (samples.length) this.publish('edge/measurements/samples', {
      catalog_version: this.active.catalog_version, observed_at: now.toISOString(), samples,
    }, false);
    return samples;
  }

  async readBlock(block, dueKeys, wireWords) {
    if (typeof this.io.readModbus !== 'function') return [];
    let words;
    try { words = await this.io.readModbus({ start:block.start, count:block.count, priority:'measurement' }); }
    catch (_) { return []; } // silence is a gap in time, never a synthetic zero sample.
    if (!Array.isArray(words) || words.length < block.count) return [];
    for (let i = 0; i < block.count; i++) wireWords.set(block.start + i, words[i]);
    const out = [];
    for (const key of block.points) {
      if (!dueKeys.has(key)) continue;
      const point = resolvePoint(key, this.io.discovery);
      if (!point || !point.address) continue;
      const absolute = point.address.kind === 'sunspec_relative'
        ? this.io.discovery.models[point.address.model_id].base + point.address.offset_words
        : Math.min(...point.address.registers);
      const offset = absolute - block.start;
      const sample = decodeRegisters(point, words.slice(offset, offset + point.address.width_words), this.io.scaleFactors);
      if (sample) out.push(sample);
    }
    return out;
  }

  async readJSON(group, dueKeys) {
    if (typeof this.io.readJSON !== 'function') return [];
    const selected = this.active.selections.filter((x) => dueKeys.has(x.point.point_key)
      && `${x.point.poll_group}:${x.cadence_s}` === group);
    if (!selected.length) return [];
    // go-e filter combines every selected API key into one request. Shelly RPC
    // groups by component/method through poll_group and one status response.
    const filter = selected.filter((x) => x.point.source_kind === 'http_api_key')
      .map((x) => x.point.selector.split('filter=')[1]).filter(Boolean).join(',');
    let payload;
    try { payload = await this.io.readJSON({ group, filter, points:selected.map((x)=>x.point) }); }
    catch (_) { return []; }
    return selected.map((x) => decodeJSON(x.point, payload)).filter(Boolean);
  }

  /** OCPP MeterValues is event-driven; it never enters the polling queue. */
  onMeterValues(values, observedAt) {
    if (!this.active || !Array.isArray(values)) return [];
    const accepted = new Set(this.active.accepted); const samples = values.map(decodeOcppSampledValue)
      .filter((s) => s && accepted.has(templateKey(s.point_key)));
    if (samples.length) this.publish('edge/measurements/samples', {
      catalog_version:this.active.catalog_version,
      observed_at:(observedAt || this.now()).toISOString(), samples,
    }, false);
    return samples;
  }
}

module.exports = { MeasurementRuntime };
