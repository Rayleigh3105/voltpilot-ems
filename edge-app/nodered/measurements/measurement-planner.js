'use strict';

const { catalogDocument, resolvePoint, derivedAddresses } = require('./measurement-driver');

const LIMITS = Object.freeze({ samplesPerMinute: 600, requestsPerMinute: 30, dutyPercent: 20 });
const COST_MS = Object.freeze({ modbus_holding: 400, modbus_input: 400,
  sunspec_model: 400, http_api_key: 250,
  rest_json: 250, rpc_json: 250, ocpp_sampled_value: 0 });

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

function groupModbus(points, discovery) {
  const grouped = new Map();
  for (const selected of points) {
    const key = `${selected.point.family}:${selected.point.source_kind}:${selected.cadence_s}`;
    const list = grouped.get(key) || [];
    const address = addressFor(selected.point, discovery);
    const registers = selected.point.address && selected.point.address.registers;
    if (address && Array.isArray(registers)) {
      // A vendor decoder may combine physically non-contiguous words. Put
      // every declared register on the wire; never turn [616,705] into
      // the invented contiguous range 616..617.
      for (const start of [...new Set(registers)]) list.push({ selected, start, count: 1 });
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
      if (!block || item.start > block.start + block.count + 1 || end - block.start > 120) {
        block = { key, start: item.start, count: item.count, cadence_s: item.selected.cadence_s,
          source_kind:item.selected.point.source_kind, points: [] };
        blocks.push(block);
      } else block.count = Math.max(block.count, end - block.start);
      if (!block.points.includes(item.selected.point.point_key)) block.points.push(item.selected.point.point_key);
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
    seen.add(s.point_key); const p = resolvePoint(s.point_key, options.discovery, s.definition);
    if (!p || !p.readable) { rejected.push({ point_key:s.point_key,reason:'unknown_point' }); continue; }
    if (!Number.isInteger(s.cadence_s) || s.cadence_s < (p.min_cadence_s || 1) || s.cadence_s > 86400) {
      rejected.push({ point_key:s.point_key,reason:'invalid_cadence' }); continue;
    }
    if (['modbus_holding','modbus_input','sunspec_model'].includes(p.source_kind)
        && !p.address && derivedAddresses(p).length === 0) {
      rejected.push({ point_key:s.point_key,reason:'driver_unavailable' }); continue;
    }
    if (p.point_key.includes('[*]') && p.family === 'sunspec.model_160') {
      const n = Number(options.discovery && options.discovery.models
        && options.discovery.models[160] && options.discovery.models[160].moduleCount);
      if (!Number.isInteger(n) || n < 1) {
        rejected.push({ point_key:s.point_key, reason:'driver_unavailable' }); continue;
      }
      for (let index = 0; index < n; index++) {
        const key = s.point_key.replace('[*]', `[${index}]`);
        const concrete = resolvePoint(key, options.discovery);
        if (concrete) valid.push({ point:concrete,cadence_s:s.cadence_s,requested_key:s.point_key });
      }
    } else valid.push({ point:p,cadence_s:s.cadence_s,requested_key:s.point_key });
  }
  const ocpp = valid.filter((x) => x.point.source_kind === 'ocpp_sampled_value');
  const choreography = compatibleOcpp(ocpp, options.ocppCapability);
  if (!choreography.ok) {
    for (const x of ocpp) rejected.push({ point_key:x.requested_key,reason:'ocpp_configuration_incompatible' });
  }
  const acceptedCandidates = valid.filter((x) => choreography.ok || x.point.source_kind !== 'ocpp_sampled_value');
  const blocks = groupModbus(acceptedCandidates, options.discovery);
  const nonModbusGroups = new Map();
  for (const x of acceptedCandidates.filter((v) => !['modbus_holding','modbus_input','sunspec_model','ocpp_sampled_value'].includes(v.point.source_kind))) {
    const key = `${x.point.poll_group}:${x.cadence_s}`; nonModbusGroups.set(key, x);
  }
  const samples = acceptedCandidates.reduce((n,x) => n + 60/x.cadence_s, 0);
  const requests = blocks.reduce((n,b) => n + 60/b.cadence_s, 0)
    + [...nonModbusGroups.values()].reduce((n,x) => n + 60/x.cadence_s, 0);
  const dutyMs = blocks.reduce((n,b) => n + 60/b.cadence_s*400, 0)
    + [...nonModbusGroups.values()].reduce((n,x) => n + 60/x.cadence_s*(COST_MS[x.point.source_kind]||250), 0);
  const duty = dutyMs/600;
  const warning = samples > 120 ? 'budget_warning_samples' : null;
  let budgetReason = samples > LIMITS.samplesPerMinute ? 'budget_samples'
    : requests > LIMITS.requestsPerMinute ? 'budget_requests'
    : duty > LIMITS.dutyPercent ? 'budget_duty_cycle' : null;
  if (budgetReason) {
    return { applied:false, accepted:[], rejected:acceptedCandidates.map((x)=>({point_key:x.requested_key,reason:budgetReason})).concat(rejected), metrics:{samplesPerMinute:samples,requestsPerMinute:requests,dutyPercent:duty,warning} };
  }
  const accepted = [...new Set(acceptedCandidates.map((x)=>x.requested_key))];
  return { applied:true, revision:config.revision, catalog_version:config.catalog_version,
    accepted, rejected, selections:acceptedCandidates,
    blocks, httpGroups:[...nonModbusGroups.keys()], ocppConfiguration:choreography.changes,
    metrics:{samplesPerMinute:samples,requestsPerMinute:requests,dutyPercent:duty,warning} };
}

// Scheduler is deliberately tiny: control work always drains before a poll.
class Scheduler {
  constructor(){this.control=[];this.poll=[];}
  enqueueControl(task){this.control.push(task);}
  enqueuePoll(task){this.poll.push(task);}
  next(){return this.control.length?this.control.shift():this.poll.shift();}
}

module.exports = { LIMITS, COST_MS, buildPlan, groupModbus, compatibleOcpp, Scheduler };
