'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDocument } = require('./measurement-driver');
const { MeasurementRuntime } = require('./measurement-runtime');
const { discoverSunSpec, shapeShellyStatus } = require('../vp-palette/nodes/vp-measurements');

const config = (selections, revision = 1) => ({
  revision, catalog_version: catalogDocument.catalog_version, selections,
});

test('Deye bench groups a block, runs control first and emits exact raw words', async () => {
  const order = []; const published = [];
  const io = { discovery:{}, readModbus: async ({ start, count }) => {
    order.push(`read:${start}:${count}`); return [250, 5200, 61];
  }};
  const runtime = new MeasurementRuntime(io, (topic, payload, retained) => published.push({ topic, payload, retained }),
    () => new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([
    { point_key:'deye.hybrid_1p.battery.battery-temperature', cadence_s:60 },
    { point_key:'deye.hybrid_1p.battery.battery-voltage', cadence_s:60 },
    { point_key:'deye.hybrid_1p.battery.battery', cadence_s:60 },
  ]));
  runtime.enqueueControl(async () => order.push('control'));
  const samples = await runtime.tick();
  assert.deepEqual(order, ['control', 'read:182:3']);
  assert.equal(samples.length, 3);
  assert.equal(samples[0].raw, 250);
  assert.equal(published.at(-1).topic, 'edge/measurements/samples');
  assert.equal(published.at(-1).retained, false);
});

test('silent/read-error bench emits no synthetic zero sample', async () => {
  const published = [];
  const runtime = new MeasurementRuntime({ discovery:{}, readModbus: async () => { throw new Error('offline'); } },
    (topic, payload) => published.push({ topic, payload }), () => new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:60 }]));
  assert.deepEqual(await runtime.tick(), []);
  assert.equal(published.filter((x) => x.topic === 'edge/measurements/samples').length, 0);
});

test('failed candidate never replaces the previously active poll plan', async () => {
  let reads = 0;
  const runtime = new MeasurementRuntime({ discovery:{}, readModbus: async () => { reads++; return [42]; } },
    () => {}, () => new Date('2026-08-25T12:00:00Z'));
  assert.equal(runtime.apply(config([{ point_key:'deye.hybrid_1p.battery.battery', cadence_s:60 }], 1)).applied, true);
  const overload = Array.from({ length:601 }, (_, i) => ({ point_key:`missing.${i}`, cadence_s:1 }));
  const rejected = runtime.apply(config(overload, 2));
  // Unknown points are individually rejected, but the empty candidate is an
  // atomic valid plan. A hard budget failure, by contrast, keeps the old one.
  assert.equal(rejected.applied, true);
  const many = catalogDocument.points.filter((p) => p.address && p.source_kind === 'modbus_holding'
    && p.min_cadence_s <= 5).slice(0, 80).map((p) => ({ point_key:p.point_key, cadence_s:5 }));
  const hard = runtime.apply(config(many, 3));
  assert.equal(hard.applied, false);
  // Revision 2's deliberately empty plan is still active, not a half-applied
  // subset of revision 3.
  assert.deepEqual(await runtime.tick(), []);
  assert.equal(reads, 0);
});

test('SunSpec Model 160 bench uses discovery N and module-relative base', async () => {
  let request;
  const discovery = { models:{ 160:{ base:41000, moduleCount:2 } } };
  const runtime = new MeasurementRuntime({ discovery, readModbus: async (r) => { request=r; return [123]; } },
    () => {}, () => new Date('2026-08-25T12:00:00Z'));
  const result = runtime.apply(config([{ point_key:'sunspec.model_160.module[1].dcw', cadence_s:60 }]));
  assert.equal(result.applied, true);
  const samples = await runtime.tick();
  assert.equal(request.start, 41041);
  assert.equal(samples[0].raw, 123);
});

test('non-contiguous Deye rule reads declared low/high words and decodes word-little', async () => {
  const reads=[];
  const runtime=new MeasurementRuntime({discovery:{},readModbus:async ({start})=>{reads.push(start);return [start===616?0xfffe:0xffff];}},()=>{},()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'deye.hybrid_3p.grid.external-ct1-power',cadence_s:60}]));
  const samples=await runtime.tick();
  assert.deepEqual(reads,[616,705]);
  assert.equal(samples[0].raw,'0268=fffe,02c1=ffff');
  assert.equal(samples[0].decoded,-2);
});

test('concurrent ticks join one physical read and runtime request budget remains hard', async () => {
  let reads=0; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const runtime=new MeasurementRuntime({discovery:{},readModbus:async()=>{reads++;await gate;return [17];}},()=>{},()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'deye.hybrid_1p.battery.battery',cadence_s:60}]));
  const a=runtime.tick(), b=runtime.tick(); release(); await Promise.all([a,b]);
  assert.equal(reads,1);
  const limited=new MeasurementRuntime({},()=>{},()=>new Date('2026-08-25T12:00:00Z'));
  for(let i=0;i<30;i++) assert.equal(limited.consumeRequest('ocpp_sampled_value'),true);
  assert.equal(limited.consumeRequest('ocpp_sampled_value'),false);
});

test('event-driven OCPP obeys selected cadence',()=>{
  const sent=[]; const runtime=new MeasurementRuntime({ocppCapability:{supportedMeasurands:['Voltage'],maxLength:100}},(t,p)=>sent.push({t,p}),()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'ocpp.1_6.metervalues.voltage.context[*].format[*].phase[*].location[*].unit[*]',cadence_s:60}]));
  const value={measurand:'Voltage',context:'Sample.Periodic',format:'Raw',phase:'L1-N',location:'Outlet',unit:'V',value:'231.2'};
  assert.equal(runtime.onMeterValues([value],new Date('2026-08-25T12:00:00Z')).length,1);
  assert.equal(runtime.onMeterValues([value],new Date('2026-08-25T12:00:01Z')).length,0);
});

test('shipped flow instantiates the production measurement node',()=>{
  const flow=require('../flows.json');
  assert.ok(flow.some(node=>node.type==='vp-measurements'&&node.core==='cfg-vp-core'&&!node.disabled));
  const source=require('fs').readFileSync(require('path').join(__dirname,'..','vp-palette','nodes',
    'vp-measurements.js'),'utf8');
  assert.match(source,/runtime\.enqueueControl/);
});

test('production transport discovers Model 160 base and live module count',async()=>{
  const image=new Map([[40000,0x5375],[40001,0x6e53],[40002,160],[40003,50],
    [40012,2],[40054,0xffff],[40055,0]]);
  const discovery=await discoverSunSpec(async ({start,count})=>Array.from({length:count},(_,i)=>image.get(start+i)??0));
  assert.deepEqual(discovery.models[160],{base:40004,length:50,moduleCount:2});
});

test('production Shelly transport expands live component ids into concrete samples',async()=>{
  const point=catalogDocument.points.find((p)=>p.selector==='EM.GetStatus?id=*#a_act_power');
  const payload=shapeShellyStatus([point],{'em:0':{a_act_power:41},'em:2':{a_act_power:73},
    sys:{uptime:9}});
  assert.deepEqual(payload.__vpResponses,[{id:0,a_act_power:41},{id:2,a_act_power:73}]);
  const runtime=new MeasurementRuntime({readJSON:async()=>payload},()=>{},
    ()=>new Date('2026-08-25T12:00:00Z'));
  const plan=runtime.apply(config([{point_key:point.point_key,cadence_s:60}]));
  assert.equal(plan.applied,true);
  const samples=await runtime.tick();
  assert.deepEqual(samples.map((sample)=>sample.point_key),[
    point.point_key.replace('[*]','[0]'),point.point_key.replace('[*]','[2]')]);
});
