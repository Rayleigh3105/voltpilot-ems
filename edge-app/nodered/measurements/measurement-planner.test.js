'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {buildPlan,Scheduler,compatibleOcpp}=require('./measurement-planner');
const {catalogDocument,resolvePoint,decodeRegisters,decodeDerived,decodeJSON,decodeJSONSamples,decodeOcppSampledValue}=require('./measurement-driver');

const cfg=(selections)=>({revision:3,catalog_version:catalogDocument.catalog_version,selections});
test('all complete driver families are packaged',()=>{const f=new Set(catalogDocument.points.map(p=>p.family));for(const x of ['string','hybrid_1p','hybrid_3p','micro','fronius_solar_api','kaco_http','kaco_http_hybrid','kostal_plenticore','sunspec.model_160','goe.api_v2','shelly.gen1','shelly.gen2plus','ocpp.1_6'])assert.ok(f.has(x));assert.equal(catalogDocument.points.length,2341)});
test('contiguous Deye points share one request',()=>{const p=buildPlan(cfg([{point_key:'deye.hybrid_1p.battery.battery-temperature',cadence_s:60},{point_key:'deye.hybrid_1p.battery.battery-voltage',cadence_s:60},{point_key:'deye.hybrid_1p.battery.battery',cadence_s:60}]));assert.equal(p.applied,true);assert.equal(p.blocks.length,1);assert.equal(p.blocks[0].start,182);assert.equal(p.blocks[0].count,3);assert.equal(p.metrics.requestsPerMinute,1)});
test('D5 sample request and duty budgets hard-reject atomically',()=>{const many=catalogDocument.points.filter(p=>p.address&&p.source_kind==='modbus_holding'&&p.min_cadence_s<=5).slice(0,80).map(p=>({point_key:p.point_key,cadence_s:5}));const p=buildPlan(cfg(many));assert.equal(p.applied,false);assert.equal(p.accepted.length,0);assert.ok(p.rejected.some(r=>r.reason.startsWith('budget_')))});
test('full concrete catalog load stays bounded and fails closed on D5', { timeout: 2000 },()=>{const selections=catalogDocument.points.filter(p=>!p.point_key.includes('*')).map(p=>({point_key:p.point_key,cadence_s:Math.max(60,p.min_cadence_s||1)}));const started=Date.now();const p=buildPlan(cfg(selections),{discovery:{models:{}}});assert.equal(p.applied,false);assert.ok(p.rejected.some(r=>r.reason.startsWith('budget_')));assert.ok(Date.now()-started<1500)});
test('D5 soft warning does not reject an otherwise safe grouped plan',()=>{const points=catalogDocument.points.filter(p=>p.address&&p.min_cadence_s<=60&&(p.family==='hybrid_3p'||p.family==='hybrid_1p')).slice(0,121);const p=buildPlan(cfg(points.map(p=>({point_key:p.point_key,cadence_s:60}))));assert.equal(p.applied,true);assert.equal(p.metrics.samplesPerMinute,121);assert.equal(p.metrics.warning,'budget_warning_samples')});
test('control queue always precedes poll work',()=>{const s=new Scheduler();s.enqueuePoll('poll');s.enqueueControl('control');assert.equal(s.next(),'control');assert.equal(s.next(),'poll')});
test('SunSpec 160 modules use discovered base and live N',()=>{const d={models:{160:{base:41000,moduleCount:2}}};const p=resolvePoint('sunspec.model_160.module[1].dcw',d);assert.equal(p.address.offset_words,41);assert.equal(resolvePoint('sunspec.model_160.module[2].dcw',d),null)});
test('raw is wire-derived and unknown conditional scale is not guessed',()=>{const p=resolvePoint('deye.hybrid_1p.battery.battery-current');const s=decodeRegisters(p,[1234]);assert.equal(s.raw,1234);assert.equal('decoded'in s,false)});
test('derived Deye values use only actually read wire words',()=>{const p=resolvePoint('deye.hybrid_1p.pv.pv-power');const words=new Map([[186,100],[187,200],[188,300],[189,400]]);const s=decodeDerived(p,words);assert.equal(s.raw,'00ba=0064,00bb=00c8,00bc=012c,00bd=0190');assert.equal(s.decoded,1000);words.delete(189);assert.equal(decodeDerived(p,words),null)});
test('attribute-only vendor points reject explicitly instead of inventing a read',()=>{const p=buildPlan(cfg([{point_key:'deye.hybrid_1p.battery.battery-state',cadence_s:60}]));assert.equal(p.applied,true);assert.deepEqual(p.accepted,[]);assert.deepEqual(p.rejected,[{point_key:'deye.hybrid_1p.battery.battery-state',reason:'driver_unavailable'}])});
test('go-e filters and Shelly selectors read only existing fields',()=>{const g=resolvePoint('goe.api_v2.alw');assert.equal(decodeJSON(g,{alw:false}).raw,false);const sh=resolvePoint('shelly.gen1.device_info.fw');assert.equal(decodeJSON(sh,{fw:'1.14'}).raw,'1.14');assert.equal(decodeJSON(sh,{}),null)});
test('OCPP configuration is station-checked and samples stay dimensioned',()=>{const p=resolvePoint('ocpp.1_6.metervalues.voltage.context[*].format[*].phase[*].location[*].unit[*]');assert.equal(compatibleOcpp([{point:p}],{supported:true,maxLength:100}).ok,true);assert.equal(compatibleOcpp([{point:p}],{supported:false,maxLength:100}).ok,false);const s=decodeOcppSampledValue({measurand:'Voltage',context:'Sample.Periodic',format:'Raw',phase:'L1-N',location:'Outlet',unit:'V',value:'231.2'});assert.match(s.point_key,/phase\[l1-n\]/);assert.equal(s.raw,'231.2');assert.equal(s.decoded,231.2)});
test('OCPP 2^53+1 stays exact raw and never creates a rounded decoded value',()=>{const value={measurand:'Energy.Active.Import.Register',context:'Sample.Periodic',format:'Raw',location:'Outlet',unit:'Wh',value:'9007199254740993'};const s=decodeOcppSampledValue(value);assert.equal(s.raw,'9007199254740993');assert.equal('decoded' in s,false);assert.equal(decodeOcppSampledValue({...value,value:9007199254740992}),null)});
test('wildcard catalog selections become executable concrete points',()=>{const discovery={models:{160:{base:41000,moduleCount:2}}};const p=buildPlan(cfg([{point_key:'sunspec.model_160.module[*].dcw',cadence_s:60}]),{discovery});assert.equal(p.applied,true);assert.deepEqual(p.blocks.map(b=>b.start),[41021,41041]);assert.deepEqual(p.accepted,['sunspec.model_160.module[*].dcw']);const shelly=resolvePoint('shelly.gen1.emeter[*].emeters[*].power');const samples=decodeJSONSamples(shelly,{emeters:[{power:17},{power:23}]});assert.deepEqual(samples.map(s=>s.point_key),['shelly.gen1.emeter[0].emeters[0].power','shelly.gen1.emeter[1].emeters[1].power']);assert.deepEqual(decodeJSONSamples(resolvePoint('shelly.gen1.system.actions_stats'),{actions_stats:{mode:'eco'}})[0],{point_key:'shelly.gen1.system.actions_stats',raw:'{"mode":"eco"}',quality:'good'})});
test('custom desired definition resolves into a read-only input-register point',()=>{const definition={sourceKind:'modbus_input',address:42,widthBits:16,valueType:'uint16',signed:false,endian:'big',scale:1};const p=buildPlan(cfg([{point_key:'custom.abc',cadence_s:30,definition}]));assert.equal(p.applied,true);assert.equal(p.blocks[0].start,42);assert.equal(p.blocks[0].source_kind,'modbus_input')});

test('KACO hybrid keeps MPPT dimensions, scales JSON and separates physical endpoints',()=>{
  const voltage=resolvePoint('kaco_http_hybrid.pv-voltage[*]');
  const samples=decodeJSONSamples(voltage,{vpv:[4100,4200]});
  assert.deepEqual(samples.map((sample)=>sample.point_key),[
    'kaco_http_hybrid.pv-voltage[0]','kaco_http_hybrid.pv-voltage[1]']);
  assert.deepEqual(samples.map((sample)=>sample.decoded),[410,420]);
  const plan=buildPlan(cfg([
    {point_key:'kaco_http_hybrid.error',cadence_s:60},
    {point_key:'kaco_http_hybrid.charge-state',cadence_s:60},
  ]));
  assert.equal(plan.applied,true);
  assert.equal(plan.httpGroups.length,2);
  assert.ok(plan.httpGroups.some((group)=>group.includes('device=2')));
  assert.ok(plan.httpGroups.some((group)=>group.includes('device=4')));
});

test('word-little floating point applies to KOSTAL and free float64 registers',()=>{
  assert.equal(decodeRegisters(resolvePoint('kostal_plenticore.grid-power'),[0x0000,0x42c8]).decoded,100);
  const custom=resolvePoint('custom.float64',undefined,{sourceKind:'modbus_holding',address:42,
    widthBits:64,valueType:'float64',signed:true,endian:'word_little_byte_big',scale:1});
  assert.equal(decodeRegisters(custom,[0,0,0,0x4059]).decoded,100);
});

test('all directly readable Deye wire types decode without invented registers',()=>{
  assert.equal(decodeRegisters(resolvePoint('deye.hybrid_1p.control.device-fault'),[1,0,0,0]).decoded,'1');
  assert.equal(decodeRegisters(resolvePoint('deye.hybrid_1p.control.date-time'),
    [0x1a08,0x1a0c,0x2238]).decoded,'2026-08-26T12:34:56');
  assert.equal(decodeRegisters(resolvePoint('deye.hybrid_1p.work-mode.program-1-time'),[630]).decoded,'06:30');
  assert.equal(typeof decodeRegisters(resolvePoint('deye.hybrid_1p.info.device-protocol-version'),[0x0123]).decoded,'string');
  assert.equal(decodeRegisters(resolvePoint('deye.hybrid_1p.info.device-serial-number'),
    [0x534e,0x3132,0,0,0]).decoded,'SN12');
});
