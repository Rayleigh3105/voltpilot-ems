'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildPlan, requestCostMs, requestsForUnits, estimateSources } = require('./measurement-planner');
const { MeasurementRuntime } = require('./measurement-runtime');
const { catalogDocument } = require('./measurement-driver');
const contractPath = path.resolve(__dirname, '../../..', 'docs/contracts/v2/measurement-budget-vectors.json');
const contract = JSON.parse(fs.readFileSync(contractPath));

test('packaged budget contract is byte-identical to the canonical contract', () => {
  assert.deepEqual(fs.readFileSync(path.join(__dirname, 'measurement-budget-vectors.json')),
    fs.readFileSync(contractPath));
});

for (const c of contract.cases) {
  test(`shared A16 budget vector: ${c.id}`, () => {
    const result = estimateSources(c.sources.map((s) => ({ channels:s.channels, cadenceS:s.cadence_s,
      requests:s.blocks.map((b) => ({ requestsPerCadence:requestsForUnits(b.family, b.source_kind, b.units),
        requestCostMs:requestCostMs(b.family, b.source_kind) })) })));
    assert.deepEqual({ samples_per_minute:result.metrics.samplesPerMinute,
      requests_per_minute:result.metrics.requestsPerMinute, duty_cycle_percent:result.metrics.dutyPercent,
      soft_warning:result.metrics.warning !== null, hard_rejected:result.reason !== null }, c.expected);
  });
}

test('new box accepts todays cloud config and returns todays status shape', () => {
  const config = require('../../../docs/contracts/v2/examples/mqtt-measurement-config.valid.json');
  assert.equal(config.catalog_version, catalogDocument.catalog_version);
  const statuses = [];
  const runtime = new MeasurementRuntime({}, (...args) => statuses.push(args),
    () => new Date('2026-09-18T00:00:00Z'));
  const plan = runtime.apply(config);
  assert.equal(plan.applied, true);
  assert.deepEqual(statuses, [['edge/measurements/config-status', {
    revision:7, applied_at:'2026-09-18T00:00:00.000Z',
    accepted:['deye.hybrid_1p.battery.battery'], rejected:[],
  }, true]]);
  assert.equal(plan.metrics.requestsPerMinute, 6);
  assert.equal(plan.metrics.dutyPercent, 4);
});

function customConfig(count, cadence) {
  return { revision:1, catalog_version:catalogDocument.catalog_version,
    selections:Array.from({length:count}, (_, i) => ({point_key:`custom.${i}`, cadence_s:cadence,
      definition:{sourceKind:'modbus_holding', address:42+i, widthBits:16,
        valueType:'uint16', signed:false, endian:'big', scale:1}})) };
}

test('unbenched registers use 2000 ms each, closing the proven cloud/box divergence', () => {
  const fast = buildPlan(customConfig(1, 5));
  assert.equal(fast.applied, false);
  assert.equal(fast.metrics.dutyPercent, 40); // old box: 8%; cloud already: 40%
  assert.equal(fast.rejected[0].reason, 'budget_duty_cycle');
  const adjacent = buildPlan(customConfig(6, 60));
  assert.equal(adjacent.applied, true);
  assert.equal(adjacent.blocks.length, 6);
  assert.equal(adjacent.metrics.requestsPerMinute, 6);
  assert.equal(adjacent.metrics.dutyPercent, 20);
  const over = buildPlan(customConfig(7, 60));
  assert.equal(over.applied, false);
  assert.ok(over.metrics.dutyPercent > 20);
});

test('all runtime catalog source kinds retain their previous costs', () => {
  for (const p of catalogDocument.points) {
    // The WAGO cards reached the box with runtime 2026.09.23.3 (UEMS AP-05 IP-6b): no previous
    // cost exists, the shared contract names it.
    const oldCost = p.source_kind === 'wago_registerbild'
      ? contract.families.wago_registerbild.request_cost_ms
      : p.source_kind === 'ocpp_sampled_value' ? 0
      : ['modbus_holding','modbus_input','sunspec_model'].includes(p.source_kind) ? 400 : 250;
    assert.equal(requestCostMs(p.family, p.source_kind), oldCost, p.point_key);
  }
});
