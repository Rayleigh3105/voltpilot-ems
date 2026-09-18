'use strict';

const { catalogDocument, resolvePoint, derivedAddresses } = require('./measurement-driver');
const { TARGET_PRIMARY, resolveTarget } = require('./measurement-binding');

// Generated verbatim by package_edge_runtime.py from docs/contracts/v2.
const budgetContract = require('./measurement-budget-vectors.json');
const LIMITS = Object.freeze({ samplesPerMinute: budgetContract.limits.samples_hard,
  requestsPerMinute: budgetContract.limits.requests, dutyPercent: budgetContract.limits.duty_pct });
function costFamily(family, sourceKind) {
  const key = Object.hasOwn(budgetContract.family_overrides, family)
    ? budgetContract.family_overrides[family]
    : Object.hasOwn(budgetContract.aliases, sourceKind) ? budgetContract.aliases[sourceKind]
    : typeof sourceKind === 'string' && sourceKind.startsWith('modbus') ? 'modbus'
    : budgetContract.default_family;
  return budgetContract.families[key];
}
function requestCostMs(family, sourceKind) {
  return costFamily(family, sourceKind).request_cost_ms;
}
function requestsForUnits(family, sourceKind, units) {
  if (!Number.isInteger(units) || units < 0) throw new Error('Invalid block size');
  const row = costFamily(family, sourceKind);
  return row.inbound ? 0 : Math.ceil(units / row.units_per_request);
}
const COST_MS = Object.freeze(Object.fromEntries(Object.keys(budgetContract.aliases)
  .map((kind) => [kind, requestCostMs(null, kind)])));

function budgetMetrics(samples, requests, dutyMs) {
  const duty = dutyMs / 600;
  const warning = samples >= budgetContract.limits.samples_soft - 1e-9 ? 'budget_warning_samples' : null;
  const reason = samples > LIMITS.samplesPerMinute + 1e-9 ? 'budget_samples'
    : requests > LIMITS.requestsPerMinute + 1e-9 ? 'budget_requests'
    : duty > LIMITS.dutyPercent + 1e-9 ? 'budget_duty_cycle' : null;
  return { reason, metrics: { samplesPerMinute:samples, requestsPerMinute:requests,
    dutyPercent:duty, warning } };
}

/** The same source/box arithmetic as MeasurementBudget.estimateSources. No I/O. */
function estimateSources(sources) {
  let samples = 0; let requests = 0; let dutyMs = 0;
  for (const source of sources) {
    if (!Number.isInteger(source.channels) || source.channels < 0
        || !Number.isInteger(source.cadenceS) || source.cadenceS < 1 || source.cadenceS > 86400) {
      throw new Error('Invalid budget source');
    }
    const cycles = 60 / source.cadenceS;
    samples += source.channels * cycles;
    for (const request of source.requests) {
      if (!Number.isInteger(request.requestsPerCadence) || request.requestsPerCadence < 0
          || !Number.isInteger(request.requestCostMs) || request.requestCostMs < 0
          || request.requestCostMs > 60000) throw new Error('Invalid budget request');
      requests += request.requestsPerCadence * cycles;
      dutyMs += request.requestsPerCadence * cycles * request.requestCostMs;
    }
  }
  const result = budgetMetrics(samples, requests, dutyMs);
  for (const key of ['samplesPerMinute', 'requestsPerMinute', 'dutyPercent']) {
    result.metrics[key] = Math.round(result.metrics[key] * 1000) / 1000;
  }
  return result;
}

/**
 * Per-target lookups (Stufe 3c). `discovery`/`byteOrder` stay the PRIMARY
 * inverter's values - every pre-3c caller keeps working unchanged - while
 * `discoveries`/`byteOrders` carry the same facts for a bound source. A target
 * with no entry has no discovery: a `sunspec_relative` point on it is then
 * refused as `driver_unavailable` instead of being read at the PRIMARY's model
 * base, which would be a wrong address on the right device.
 */
function discoveryFor(options, targetKey) {
  if (options && options.discoveries
      && Object.prototype.hasOwnProperty.call(options.discoveries, targetKey)) {
    return options.discoveries[targetKey];
  }
  return targetKey === TARGET_PRIMARY ? (options && options.discovery) : null;
}

function byteOrderFor(options, targetKey) {
  if (options && options.byteOrders
      && Object.prototype.hasOwnProperty.call(options.byteOrders, targetKey)) {
    return options.byteOrders[targetKey];
  }
  return targetKey === TARGET_PRIMARY ? (options && options.byteOrder) : undefined;
}

function addressFor(point, discovery) {
  if (!point.address) return null;
  if (['modbus_holding', 'modbus_input'].includes(point.address.kind)) {
    const registers = point.address.registers;
    if (!Array.isArray(registers) || !registers.every(Number.isInteger)) return null;
    return { start: Math.min(...registers), count: point.address.width_words };
  }
  if (point.address.kind === 'sunspec_relative') {
    const model = discovery && discovery.models && discovery.models[point.address.model_id];
    if (!model || !Number.isInteger(model.base)) return null;
    if (!Number.isInteger(point.address.offset_words)) return null;
    return { start: model.base + point.address.offset_words, count: point.address.width_words };
  }
  return null;
}

function decoderDependencies(point, options, targetKey) {
  const decoder = point.decoder || {};
  const dependencies = [];
  if (decoder.variant && Number.isInteger(decoder.variant.register)) {
    dependencies.push(decoder.variant.register);
  }
  const byteOrder = decoder.byte_order;
  const configured = byteOrderFor(options, targetKey || TARGET_PRIMARY);
  if (byteOrder && Number.isInteger(byteOrder.register)
      && !['big', 'little', 'word_little_byte_big'].includes(configured)) {
    dependencies.push(byteOrder.register);
  }
  return dependencies;
}

function groupModbus(points, options) {
  const grouped = new Map();
  const targets = new Map();
  for (const selected of points) {
    // ⚠ The TARGET is part of the grouping key. Two devices behind one box can
    // carry the same family and the same register; merging them into one block
    // would read one device's addresses over the other's connection.
    const target = selected.target || { key:TARGET_PRIMARY, sourceId:null };
    const unbenched = selected.point.family === 'custom' ? `:${selected.point.poll_group}` : '';
    const key = `${target.key}:${selected.point.family}:${selected.point.source_kind}:${selected.cadence_s}${unbenched}`;
    targets.set(key, target);
    const list = grouped.get(key) || [];
    const address = addressFor(selected.point, discoveryFor(options, target.key));
    const registers = selected.point.address && selected.point.address.registers;
    if (address && Array.isArray(registers)) {
      // A vendor decoder may combine physically non-contiguous words. Put
      // every declared register on the wire; never turn [616,705] into
      // the invented contiguous range 616..617.
      for (const start of [...new Set(registers.concat(
        decoderDependencies(selected.point, options, target.key)))]) {
        list.push({ selected, start, count: 1 });
      }
    } else if (address) list.push(Object.assign({ selected }, address));
    else for (const start of derivedAddresses(selected.point)) list.push({ selected, start, count: 1 });
    grouped.set(key, list);
  }
  const blocks = [];
  for (const [key, list] of grouped) {
    list.sort((a, b) => a.start - b.start);
    let block = null;
    for (const item of list) {
      const end = item.start + item.count;
      if (!block || item.start > block.start + block.count + 1
          || end - block.start > costFamily(null, 'modbus_holding').units_per_request) {
        block = { key, start: item.start, count: item.count, cadence_s: item.selected.cadence_s,
          source_kind:item.selected.point.source_kind, target:targets.get(key), points: [],
          requestCostMs:requestCostMs(item.selected.point.family, item.selected.point.source_kind) };
        blocks.push(block);
      } else block.count = Math.max(block.count, end - block.start);
      const triggerKey = item.selected.trigger_key || item.selected.point.point_key;
      if (!block.points.includes(triggerKey)) block.points.push(triggerKey);
    }
  }
  return blocks;
}

function compatibleOcpp(points, capability) {
  const measurands = [...new Set(points.map((x) => {
    const match = x.point.selector.match(/measurand=([^,\]]+)/);
    return match ? match[1] : '';
  }).filter(Boolean))];
  if (!measurands.length) return { ok: true, changes: {} };
  if (!capability || capability.readonly || capability.supported === false) return { ok: false };
  // OCPP 1.6 exposes the currently configured sampled-data CSV, not a complete
  // vocabulary. Treating already-arriving measurands as capability creates a
  // deadlock: a desired key could never be enabled. The station's
  // ChangeConfiguration response + targeted GetConfiguration readback is the
  // compatibility proof.
  if (Array.isArray(capability.supportedMeasurands)) {
    const supported = new Set(capability.supportedMeasurands);
    if (measurands.some((m) => !supported.has(m))) return { ok: false };
  }
  const csv = measurands.join(',');
  if (capability.maxLength && csv.length > capability.maxLength) return { ok: false };
  return { ok: true, changes: { MeterValuesSampledData: csv, StopTxnSampledData: csv } };
}

/** Pure atomic apply. Caller swaps active plan only when this returns applied=true. */
function buildPlan(config, options) {
  options = options || {}; const rejected = []; const valid = [];
  if (!config || config.catalog_version !== catalogDocument.catalog_version) {
    return { applied: false, accepted: [], rejected: (config.selections || []).map((s) => ({ point_key:s.point_key, reason:'unsupported_catalog' })) };
  }
  const seen = new Set();
  for (const s of config.selections || []) {
    if (seen.has(s.point_key)) { rejected.push({ point_key:s.point_key,reason:'unknown_point' }); continue; }
    seen.add(s.point_key);
    // Resolve once against the PRIMARY's discovery to learn what kind of point
    // this is (a sunspec wildcard TEMPLATE and every non-sunspec point resolve
    // discovery-free), bind it, then resolve again with the bound target's own
    // discovery where that differs.
    let p = resolvePoint(s.point_key, options.discovery, s.definition);
    if (!p || !p.readable) { rejected.push({ point_key:s.point_key,reason:'unknown_point' }); continue; }
    if (!Number.isInteger(s.cadence_s) || s.cadence_s < (p.min_cadence_s || 1) || s.cadence_s > 86400) {
      rejected.push({ point_key:s.point_key,reason:'invalid_cadence' }); continue;
    }
    // ⚠ Stufe 3c: an unresolvable component binding is REFUSED here, never read
    // against the primary inverter's connection.
    const target = resolveTarget(s, p, options.binding);
    if (target.reason) { rejected.push({ point_key:s.point_key,reason:target.reason }); continue; }
    const discovery = discoveryFor(options, target.key);
    if (discovery !== options.discovery) {
      p = resolvePoint(s.point_key, discovery, s.definition);
      if (!p || !p.readable) { rejected.push({ point_key:s.point_key,reason:'unknown_point' }); continue; }
    }
    if (['modbus_holding','modbus_input','sunspec_model'].includes(p.source_kind)
        && !p.address && derivedAddresses(p).length === 0) {
      rejected.push({ point_key:s.point_key,reason:'driver_unavailable' }); continue;
    }
    if (p.point_key.includes('[*]') && p.family === 'sunspec.model_160') {
      const n = Number(discovery && discovery.models
        && discovery.models[160] && discovery.models[160].moduleCount);
      if (!Number.isInteger(n) || n < 1) {
        rejected.push({ point_key:s.point_key, reason:'driver_unavailable' }); continue;
      }
      for (let index = 0; index < n; index++) {
        const key = s.point_key.replace('[*]', `[${index}]`);
        const concrete = resolvePoint(key, discovery);
        if (concrete) valid.push({ point:concrete,cadence_s:s.cadence_s,requested_key:s.point_key,target });
      }
    } else valid.push({ point:p,cadence_s:s.cadence_s,requested_key:s.point_key,target });
  }
  const ocpp = valid.filter((x) => x.point.source_kind === 'ocpp_sampled_value');
  const choreography = compatibleOcpp(ocpp, options.ocppCapability);
  if (!choreography.ok) {
    for (const x of ocpp) rejected.push({ point_key:x.requested_key,reason:'ocpp_configuration_incompatible' });
  }
  const acceptedCandidates = valid.filter((x) => choreography.ok || x.point.source_kind !== 'ocpp_sampled_value');
  const prerequisites = acceptedCandidates.flatMap((selected) => {
    const lookup = selected.point.decoder && selected.point.decoder.validation
      && selected.point.decoder.validation.lookup;
    if (!lookup) return [];
    const point = catalogDocument.points.find((candidate) => candidate.family === selected.point.family
      && candidate.decoder && candidate.decoder.source_key === lookup && candidate.address);
    return point ? [{ point, cadence_s:selected.cadence_s, target:selected.target,
      requested_key:selected.requested_key, trigger_key:selected.point.point_key }] : [];
  });
  const uniquePrerequisites = [...new Map(prerequisites.map((item) =>
    [`${item.target.key}:${item.point.point_key}:${item.cadence_s}:${item.trigger_key}`, item])).values()];
  const blocks = groupModbus(acceptedCandidates.concat(uniquePrerequisites), options);
  const nonModbusGroups = new Map();
  for (const x of acceptedCandidates.filter((v) => !['modbus_holding','modbus_input','sunspec_model','ocpp_sampled_value'].includes(v.point.source_kind))) {
    // Same rule as the modbus blocks: one HTTP request per (target, group).
    const key = `${x.target.key}:${x.point.poll_group}:${x.cadence_s}`; nonModbusGroups.set(key, x);
  }
  const samples = acceptedCandidates.reduce((n,x) => n + 60/x.cadence_s, 0);
  const requests = blocks.reduce((n,b) => n + 60/b.cadence_s, 0)
    + [...nonModbusGroups.values()].reduce((n,x) => n + 60/x.cadence_s, 0);
  const dutyMs = blocks.reduce((n,b) => n + 60/b.cadence_s*b.requestCostMs, 0)
    + [...nonModbusGroups.values()].reduce((n,x) => n + 60/x.cadence_s
      *requestCostMs(x.point.family, x.point.source_kind), 0);
  const { reason:budgetReason, metrics } = budgetMetrics(samples, requests, dutyMs);
  if (budgetReason) {
    return { applied:false, accepted:[], rejected:acceptedCandidates.map((x)=>({point_key:x.requested_key,reason:budgetReason})).concat(rejected), metrics };
  }
  const accepted = [...new Set(acceptedCandidates.map((x)=>x.requested_key))];
  return { applied:true, revision:config.revision, catalog_version:config.catalog_version,
    accepted, rejected, selections:acceptedCandidates,
    decoderPrerequisites:uniquePrerequisites,
    byteOrder:options.byteOrder, byteOrders:options.byteOrders,
    blocks, httpGroups:[...nonModbusGroups.entries()].map(([key, x]) => ({ key, target:x.target })),
    ocppConfiguration:choreography.changes,
    metrics };
}

// Scheduler is deliberately tiny: control work always drains before a poll.
class Scheduler {
  constructor(){this.control=[];this.poll=[];}
  enqueueControl(task){this.control.push(task);}
  enqueuePoll(task){this.poll.push(task);}
  next(){return this.control.length?this.control.shift():this.poll.shift();}
}

module.exports = { LIMITS, COST_MS, buildPlan, groupModbus, compatibleOcpp, Scheduler,
  decoderDependencies, discoveryFor, byteOrderFor, requestCostMs, requestsForUnits, estimateSources };
