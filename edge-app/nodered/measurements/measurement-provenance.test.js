'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MeasurementRuntime } = require('./measurement-runtime');
const { catalogDocument } = require('./measurement-driver');
const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000b2';
const at = () => new Date('2026-08-25T12:00:00Z');
const config = (selections, revision = 7) => ({
  catalog_version:catalogDocument.catalog_version, revision, selections,
});
const definition = { label:'Voltage', sourceKind:'modbus_holding', address:616,
  selector:'s', valueType:'uint16', widthBits:16, signed:false, endian:'big', scale:1,
  unit:'V', cadenceS:30, retentionClass:'power', readOnly:true, requestCostMs:400 };
const selection = (key, entity = A) => ({ point_key:key, cadence_s:30,
  ...(entity ? { entity_id:entity } : {}), definition });
const binding = { entities:{
  [A]:{ entity_type:'battery-hybrid' }, [B]:{ entity_type:'grid-meter' },
}, sources:{} };
const options = { binding };
const capture = (batches) => (topic, payload) => {
  if (topic === 'edge/measurements/samples') batches.push(payload);
};

test('provenance preserves shared Modbus read budget and emits each explicit component', async () => {
  for (const bound of [false, true]) {
    let reads = 0; const batches = [];
    const runtime = new MeasurementRuntime({ readModbus:async () => { reads++; return [230]; } },
      capture(batches), at);
    const plan = runtime.apply(config([
      selection('custom.a', bound ? A : null), selection('custom.b', bound ? B : null),
    ]), options);
    assert.equal(plan.applied, true);
    assert.equal(plan.blocks.length, 1);
    assert.equal(plan.metrics.requestsPerMinute, 2);
    const samples = await runtime.tick();
    assert.equal(reads, 1, 'the same target/register is still read exactly once');
    assert.equal(samples.length, 2);
    assert.deepEqual(samples.map((s) => s.entity_id), bound ? [A, B] : [undefined, undefined]);
    assert.deepEqual(samples.map((s) => s.raw), [230, 230]);
    assert.equal(batches[0].applied_revision, 7);
  }
});

test('a plan replaced during a Modbus read cannot relabel its samples', async () => {
  let finish; const batches = [];
  const runtime = new MeasurementRuntime({ readModbus:() => new Promise((r) => { finish = r; }) },
    capture(batches), at);
  runtime.apply(config([selection('custom.a', A)], 7), options);
  const reading = runtime.tick();
  runtime.apply(config([selection('custom.a', B)], 8), options);
  finish([230]);
  assert.equal((await reading)[0].entity_id, A);
  assert.equal(batches[0].applied_revision, 7);
  const next = runtime.tick(); finish([231]);
  assert.equal((await next)[0].entity_id, B);
  assert.equal(batches[1].applied_revision, 8);
});

test('rejected plan leaves the previously applied provenance active', async () => {
  const batches = [];
  const runtime = new MeasurementRuntime({ readModbus:async () => [230] }, capture(batches), at);
  runtime.apply(config([selection('custom.a')], 7), options);
  assert.equal(runtime.apply({ ...config([], 8), catalog_version:'unknown' }).applied, false);
  await runtime.tick();
  assert.equal(batches[0].applied_revision, 7);
  assert.equal(batches[0].samples[0].entity_id, A);
});

test('HTTP wildcard expansion keeps its binding and in-flight plan revision', async () => {
  const point = catalogDocument.points.find((p) => p.selector === 'EM.GetStatus?id=*#a_act_power');
  let finish; const batches = [];
  const runtime = new MeasurementRuntime({ readJSON:() => new Promise((r) => { finish = r; }) },
    capture(batches), at);
  runtime.apply(config([{ point_key:point.point_key, cadence_s:60, entity_id:A }]), options);
  const reading = runtime.tick();
  runtime.apply(config([], 8), options);
  finish({ __vpResponses:[{id:0, a_act_power:41}, {id:2, a_act_power:73}] });
  const samples = await reading;
  assert.deepEqual(samples.map((s) => s.point_key),
    [point.point_key.replace('[*]', '[0]'), point.point_key.replace('[*]', '[2]')]);
  assert.deepEqual(samples.map((s) => s.entity_id), [A, A]);
  assert.equal(batches[0].applied_revision, 7);
});

test('SunSpec wildcard values carry their explicit bindings', async () => {
  const runtime = new MeasurementRuntime({
    discovery:{ models:{160:{base:40000, moduleCount:2}} },
    readModbus:async ({count}) => Array(count).fill(10),
  }, () => {}, at);
  const plan = runtime.apply(config([
    { point_key:'sunspec.model_160.module[*].dcw', cadence_s:60, entity_id:A },
  ]), options);
  assert.equal(plan.applied, true);
  const samples = await runtime.tick();
  assert.equal(samples.length, 2);
  assert.deepEqual(samples.map((s) => s.entity_id), [A, A]);
});

test('derived Modbus values carry their explicit binding without extra reads', async () => {
  const reads = [];
  const runtime = new MeasurementRuntime({ readModbus:async ({start}) => {
    reads.push(start); return [start === 616 ? 0xfffe : 0xffff];
  } }, () => {}, at);
  runtime.apply(config([{point_key:'deye.hybrid_3p.grid.external-ct1-power',
    cadence_s:60, entity_id:A}]), options);
  const samples = await runtime.tick();
  assert.deepEqual(reads, [616, 705]);
  assert.equal(samples[0].entity_id, A);
  assert.equal(samples[0].decoded, -2);
});

test('OCPP provenance changes only after the pending plan is confirmed', async () => {
  const batches = []; let confirm;
  const runtime = new MeasurementRuntime({ ocppCapability:{supported:true, maxLength:100},
    applyOcppConfiguration:() => new Promise((r) => { confirm = r; }),
  }, capture(batches), at);
  const point_key = 'ocpp.1_6.metervalues.voltage.context[*].format[*].phase[*].location[*].unit[*]';
  const value = { measurand:'Voltage', context:'Sample.Periodic', format:'Raw', phase:'L1-N',
    location:'Outlet', unit:'V', value:'231.2' };
  runtime.apply(config([{ point_key, cadence_s:60, entity_id:A }], 7));
  assert.deepEqual(runtime.onMeterValues([value], at()), []);
  confirm({applied:true}); await new Promise(setImmediate);
  assert.equal(runtime.onMeterValues([value], at())[0].entity_id, A);
  runtime.apply(config([{ point_key, cadence_s:60, entity_id:B }], 8));
  assert.equal(runtime.onMeterValues([value], new Date(at().getTime() + 60000))[0].entity_id, A);
  assert.equal(batches.at(-1).applied_revision, 7);
  confirm({applied:true}); await new Promise(setImmediate);
  assert.equal(runtime.onMeterValues([value], new Date(at().getTime() + 120000))[0].entity_id, B);
  assert.equal(batches.at(-1).applied_revision, 8);
});
