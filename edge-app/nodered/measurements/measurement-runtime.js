'use strict';

const { buildPlan, Scheduler } = require('./measurement-planner');
const { resolvePoint, decodeRegisters, decodeDerived, derivedAddresses,
  decodeJSONSamples, decodeOcppSampledValue, templateKey } = require('./measurement-driver');
const { LIMITS, COST_MS } = require('./measurement-planner');

/**
 * Read-only runtime. Every I/O primitive is injected for bench simulation;
 * there is deliberately no write-register primitive in this module.
 */
class MeasurementRuntime {
  constructor(io, publish, now) {
    this.io = io || {}; this.publish = publish || (() => {}); this.now = now || (() => new Date());
    this.active = null; this.scheduler = new Scheduler(); this.due = new Map();
    this.tickPromise = null; this.requestWindow = []; this.sampleWindow = [];
    this.ocppDue = new Map();
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

  tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this._tick().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }

  async _tick() {
    if (!this.active) return [];
    const now = this.now(); const ms = now.getTime(); const dueKeys = new Set();
    for (const s of this.active.selections) if ((this.due.get(s.point.point_key) || 0) <= ms) dueKeys.add(s.point.point_key);
    if (!dueKeys.size) return [];
    // Claim due work before the first await. Concurrent/re-entrant ticks can
    // now only join this run and can never issue a second physical read.
    for (const s of this.active.selections) if (dueKeys.has(s.point.point_key)) {
      this.due.set(s.point.point_key, ms + s.cadence_s * 1000);
    }
    const blocks = this.active.blocks.filter((b) => b.points.some((p) => dueKeys.has(p)));
    for (const block of blocks) this.scheduler.enqueuePoll({ kind: 'modbus', block });
    for (const group of this.active.httpGroups) this.scheduler.enqueuePoll({ kind: 'json', group });
    const samples = []; const wireWords = new Map();
    for (let task; (task = this.scheduler.next());) {
      if (task.kind === 'control') { await task.run(); continue; }
      if (task.kind === 'modbus') await this.readBlock(task.block, dueKeys, wireWords);
      else if (task.kind === 'json') samples.push(...await this.readJSON(task.group, dueKeys));
    }
    for (const selected of this.active.selections) {
      if (!dueKeys.has(selected.point.point_key)) continue;
      let sample = null;
      if (selected.point.address) {
        const addresses = this.addresses(selected.point);
        if (addresses.length && addresses.every((address) => wireWords.has(address))) {
          sample = decodeRegisters(selected.point, addresses.map((address) => wireWords.get(address)),
            this.io.scaleFactors, addresses);
        }
      } else if (derivedAddresses(selected.point).length) sample = decodeDerived(selected.point, wireWords);
      if (sample) samples.push(sample);
    }
    return this.publishSamples(samples, now);
  }

  async readBlock(block, dueKeys, wireWords) {
    if (typeof this.io.readModbus !== 'function') return [];
    let words;
    if (!this.consumeRequest(block.source_kind || 'modbus_holding')) return [];
    try { words = await this.runBusTask(() => this.io.readModbus({ start:block.start,
      count:block.count, source_kind:block.source_kind, priority:'measurement' })); }
    catch (_) { return []; } // silence is a gap in time, never a synthetic zero sample.
    if (!Array.isArray(words) || words.length < block.count) return [];
    for (let i = 0; i < block.count; i++) wireWords.set(block.start + i, words[i]);
    return [];
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
    if (!this.consumeRequest(selected[0].point.source_kind)) return [];
    try { payload = await this.io.readJSON({ group, filter, points:selected.map((x)=>x.point) }); }
    catch (_) { return []; }
    const payloads = payload && Array.isArray(payload.__vpResponses)
      ? payload.__vpResponses : [payload];
    return selected.flatMap((x) => payloads.flatMap((value) => decodeJSONSamples(x.point, value)));
  }

  /** OCPP MeterValues is event-driven; it never enters the polling queue. */
  onMeterValues(values, observedAt) {
    if (!this.active || !Array.isArray(values)) return [];
    const accepted = new Set(this.active.accepted); const at = observedAt || this.now();
    const samples = values.map(decodeOcppSampledValue).filter((s) => {
      if (!s || !accepted.has(templateKey(s.point_key))) return false;
      const selection = this.active.selections.find((x) => x.requested_key === templateKey(s.point_key));
      const due = this.ocppDue.get(s.point_key) || 0;
      if (!selection || at.getTime() < due) return false;
      this.ocppDue.set(s.point_key, at.getTime() + selection.cadence_s * 1000);
      return true;
    });
    return this.publishSamples(samples, at);
  }

  addresses(point) {
    if (Array.isArray(point.address.registers)) return point.address.registers;
    if (point.address.kind !== 'sunspec_relative') return [];
    const model = this.io.discovery && this.io.discovery.models[point.address.model_id];
    if (!model || !Number.isInteger(model.base) || !Number.isInteger(point.address.offset_words)) return [];
    const start = model.base + point.address.offset_words;
    return Array.from({ length:point.address.width_words }, (_, i) => start + i);
  }

  runBusTask(run) {
    return typeof this.io.runBusTask === 'function' ? this.io.runBusTask('measurement', run) : run();
  }

  trimWindow(window, ms) {
    while (window.length && (typeof window[0] === 'number' ? window[0] : window[0].at) <= ms - 60000) window.shift();
  }

  consumeRequest(kind) {
    const ms = this.now().getTime(); this.trimWindow(this.requestWindow, ms);
    if (this.requestWindow.length >= LIMITS.requestsPerMinute) return false;
    const cost = COST_MS[kind] || 250;
    const duty = this.requestWindow.reduce((sum, x) => sum + (x.cost || 0), 0);
    if ((duty + cost) / 600 > LIMITS.dutyPercent) return false;
    this.requestWindow.push({ at:ms, cost });
    return true;
  }

  publishSamples(samples, at) {
    const ms = at.getTime(); this.trimWindow(this.sampleWindow, ms);
    const room = Math.max(0, LIMITS.samplesPerMinute - this.sampleWindow.length);
    const kept = samples.slice(0, room); const dropped = samples.length - kept.length;
    for (let i = 0; i < kept.length; i++) this.sampleWindow.push(ms);
    if (kept.length || dropped) this.publish('edge/measurements/samples', {
      catalog_version:this.active.catalog_version, observed_at:at.toISOString(), samples:kept,
      ...(dropped ? { gap:true, dropped_samples:dropped } : {}),
    }, false);
    return kept;
  }
}

module.exports = { MeasurementRuntime };
