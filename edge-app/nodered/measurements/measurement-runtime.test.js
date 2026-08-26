'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const os = require('os');
const path = require('path');
const { catalogDocument, resolvePoint, decodeJSON } = require('./measurement-driver');
const { MeasurementRuntime } = require('./measurement-runtime');
const { discoverSunSpec, shapeShellyStatus, getJSON, inverterJSONEndpoint } = require('../vp-palette/nodes/vp-measurements');

const config = (selections, revision = 1) => ({
  revision, catalog_version: catalogDocument.catalog_version, selections,
});

test('API-produced current catalog plan is accepted and executed by the Edge runtime', async () => {
  // MeasurementContractsTest byte-pins this shared fixture to the real API publisher output.
  const fixture = path.resolve(
    __dirname, '../../../docs/contracts/v2/examples/mqtt-measurement-config.valid.json',
  );
  const payload = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.equal(payload.catalog_version, '2026.08.26.3');
  const runtime = new MeasurementRuntime(
    {readModbus: async () => [50]}, () => {}, () => new Date('2026-08-25T12:00:00Z'),
  );
  const plan = runtime.apply(payload);
  assert.equal(plan.applied, true);
  assert.deepEqual(plan.accepted, ['deye.hybrid_1p.battery.battery']);
  const samples = await runtime.tick();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].decoded, 50);
});

test('production image and reseed layouts package every settings dependency', () => {
  const root = path.resolve(__dirname, '..');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const reseed = fs.readFileSync(path.join(root, 'reseed-entrypoint.sh'), 'utf8');
  assert.match(dockerfile, /COPY deye \/opt\/vp-template\/deye/);
  assert.match(reseed, /for d in vp-palette measurements deye node_modules/);

  // Recreate only the production /data files produced by the image template
  // and reseed loop. Requiring settings from the source tree would hide a
  // missing packaged relative dependency.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-image-layout-'));
  try {
    fs.copyFileSync(path.join(root, 'settings.js'), path.join(data, 'settings.js'));
    for (const directory of ['measurements', 'vp-palette', 'deye']) {
      fs.cpSync(path.join(root, directory), path.join(data, directory), { recursive:true,
        filter:(source)=>path.basename(source)!=='node_modules' });
    }
    const originalLoad = Module._load;
    const originalPassword = process.env.VP_NODERED_PASSWORD;
    process.env.VP_NODERED_PASSWORD = 'image-layout-probe';
    Module._load = function (request, parent, isMain) {
      if (request === 'bcryptjs') return { hashSync:()=> 'hash', compareSync:()=> true };
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      assert.doesNotThrow(() => require(path.join(data, 'settings.js')));
    } finally {
      Module._load = originalLoad;
      if (originalPassword === undefined) delete process.env.VP_NODERED_PASSWORD;
      else process.env.VP_NODERED_PASSWORD = originalPassword;
    }
  } finally {
    fs.rmSync(data, { recursive:true, force:true });
  }
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

test('KOSTAL runtime reads register 5 and decodes the detected big-word layout', async () => {
  const reads=[];
  const runtime=new MeasurementRuntime({readModbus:async ({start,count})=>{
    reads.push([start,count]);
    if(start===5)return [1];
    if(start===252)return [0x42c8,0x0000];
    return Array(count).fill(0);
  }},()=>{},()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'kostal_plenticore.grid-power',cadence_s:60}]));
  const samples=await runtime.tick();
  assert.deepEqual(reads,[[5,1],[252,2]]);
  assert.equal(samples[0].decoded,100);
});

test('Deye validation lookup reads its referenced point and invalidate-all drops the tick', async () => {
  const reads=[]; const published=[];
  const runtime=new MeasurementRuntime({readModbus:async ({start,count})=>{
    reads.push([start,count]);
    if(start===16)return [1000,0]; // pinned rated-power rule 4 => 100 W
    if(start===175)return [111]; // exceeds the referenced 100 W * 1.1
    return Array(count).fill(0);
  }},(topic,payload)=>published.push({topic,payload}),()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'deye.hybrid_1p.load.power',cadence_s:60}]));
  assert.deepEqual(await runtime.tick(),[]);
  assert.deepEqual(reads,[[16,2],[175,1]]);
  assert.equal(published.some((entry)=>entry.topic==='edge/measurements/samples'),false);
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

test('duty budget reconciles reservations to real monotonic bus occupancy', async () => {
  let mono=0, runs=0;
  const runtime=new MeasurementRuntime({monotonicNow:()=>mono},()=>{},()=>new Date('2026-08-25T12:00:00Z'));
  for(let i=0;i<10;i++) {
    const result=await runtime.runMeasuredRequest('modbus_holding',async()=>{
      runs++; mono+=3000; return 'ok';
    });
    if(i<3) assert.equal(result,'ok');
    else assert.equal(result,MeasurementRuntime.BUDGET_BLOCKED);
  }
  // The fourth request is conservatively withheld because its 4 s timeout
  // reservation would exceed the hard window, even though the first three
  // completed in 3 s each.
  assert.equal(runs,3);
  assert.equal(runtime.requestWindow.reduce((sum,entry)=>sum+entry.cost,0),9000);

  let timeoutMono=0, attempts=0;
  const timeouts=new MeasurementRuntime({monotonicNow:()=>timeoutMono},()=>{});
  for(let i=0;i<4;i++) await timeouts.runMeasuredRequest('modbus_holding',async()=>{
    attempts++; timeoutMono+=4000; throw new Error('timeout');
  }).catch(()=>{});
  assert.equal(attempts,3); // timeout reservations fill the same hard 20% window.
});

test('in-flight occupancy beyond its reservation blocks another request', async () => {
  let mono=0;
  let runs=0;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const runtime=new MeasurementRuntime({monotonicNow:()=>mono},()=>{});
  const first=runtime.runMeasuredRequest('modbus_holding',async()=>{
    runs+=1;
    await gate;
    return 'first';
  });
  await new Promise(resolve=>setImmediate(resolve));

  // The live request has occupied the bus for 12,001 ms, beyond its 4 s admission
  // reservation. Counting only that stale reservation would admit this second
  // 4 s request: 12,001 + 4,000 = 16,001 ms, beyond the hard 12,000 ms/min
  // (20 %) duty window from the independent boundary probe.
  mono=12001;
  assert.equal(mono+4000,16001);
  assert.ok(mono+4000>12000);
  const second=await runtime.runMeasuredRequest('modbus_holding',async()=>{
    runs+=1;
    return 'second';
  });
  assert.equal(second,MeasurementRuntime.BUDGET_BLOCKED);
  assert.equal(runs,1);
  assert.equal(runtime.requestWindow.reduce((sum,entry)=>sum+entry.cost,0),12001);

  release();
  assert.equal(await first,'first');
  assert.equal(runtime.requestWindow[0].cost,12001);
});

test('event-driven OCPP obeys selected cadence',()=>{
  const sent=[]; const runtime=new MeasurementRuntime({ocppCapability:{supportedMeasurands:['Voltage'],maxLength:100}},(t,p)=>sent.push({t,p}),()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'ocpp.1_6.metervalues.voltage.context[*].format[*].phase[*].location[*].unit[*]',cadence_s:60}]));
  const value={measurand:'Voltage',context:'Sample.Periodic',format:'Raw',phase:'L1-N',location:'Outlet',unit:'V',value:'231.2'};
  assert.equal(runtime.onMeterValues([value],new Date('2026-08-25T12:00:00Z')).length,1);
  assert.equal(runtime.onMeterValues([value],new Date('2026-08-25T12:00:01Z')).length,0);
});

test('event-driven OCPP publishes 2^53+1 as exact raw without rounded decoded',()=>{
  const sent=[];
  const runtime=new MeasurementRuntime({ocppCapability:{supported:true,maxLength:200}},
    (topic,payload)=>sent.push({topic,payload}),()=>new Date('2026-08-25T12:00:00Z'));
  runtime.apply(config([{point_key:'ocpp.1_6.metervalues.energy.active.import.register.context[*].format[*].phase[*].location[*].unit[*]',cadence_s:60}]));
  const samples=runtime.onMeterValues([{measurand:'Energy.Active.Import.Register',
    context:'Sample.Periodic',format:'Raw',location:'Outlet',unit:'Wh',
    value:'9007199254740993'}],new Date('2026-08-25T12:00:00Z'));
  assert.equal(samples.length,1);
  assert.equal(samples[0].raw,'9007199254740993');
  assert.equal('decoded' in samples[0],false);
  const wire=JSON.stringify(sent.find(entry=>entry.topic==='edge/measurements/samples').payload);
  assert.match(wire,/"raw":"9007199254740993"/);
  assert.doesNotMatch(wire,/"decoded":9007199254740992/);
});

test('OCPP desired is not acknowledged until the durable Core applier confirms readback', async () => {
  let calls=0, confirm; const published=[];
  const runtime=new MeasurementRuntime({ocppCapability:{supported:true,maxLength:100},
    applyOcppConfiguration:(desired)=>{ calls++; assert.deepEqual(desired.configuration,
      {MeterValuesSampledData:'Voltage',StopTxnSampledData:'Voltage'});
      return new Promise(resolve=>{confirm=resolve;}); }},
  (topic,payload)=>published.push({topic,payload}),()=>new Date('2026-08-25T12:00:00Z'));
  const plan=runtime.apply(config([{point_key:'ocpp.1_6.metervalues.voltage.context[*].format[*].phase[*].location[*].unit[*]',cadence_s:60}]));
  assert.equal(calls,1);
  assert.equal(plan.pending,true);
  assert.equal(runtime.active,null);
  assert.equal(published.some((entry)=>entry.topic==='edge/measurements/config-status'),false);
  confirm({revision:1,applied:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(runtime.active);
  assert.equal(published.filter((entry)=>entry.topic==='edge/measurements/config-status').length,1);
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

test('production HTTP transport preserves 2^53+1 and uint64 max as decimal raw strings', async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"c0e":9007199254740993,"eto":18446744073709551615}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const payload = await getJSON(new URL(`http://127.0.0.1:${server.address().port}/api/status`));
  assert.equal(payload.c0e, '9007199254740993');
  assert.equal(payload.eto, '18446744073709551615');
  assert.equal(decodeJSON(resolvePoint('goe.api_v2.c0e'), payload).raw, '9007199254740993');
  assert.equal(decodeJSON(resolvePoint('goe.api_v2.eto'), payload).raw, '18446744073709551615');
  assert.match(JSON.stringify(payload), /"c0e":"9007199254740993"/);
});

test('production KACO transport interpolates and URL-escapes the configured serial',()=>{
  assert.equal(inverterJSONEndpoint('/getdevdata.cgi?device=2&sn={serial}#pac','NX 12/34'),
    '/getdevdata.cgi?device=2&sn=NX%2012%2F34');
  assert.throws(()=>inverterJSONEndpoint('/getdevdata.cgi?device=2&sn={serial}#pac',''),
    /Seriennummer/);
});
