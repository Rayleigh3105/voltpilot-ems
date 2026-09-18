'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {errorClass,event}=require('./data-source-status');
const {MeasurementRuntime}=require('./measurement-runtime');
const {catalogDocument}=require('./measurement-driver');
const {parseEntityConfig}=require('./measurement-binding');

test('source evidence uses the closed vocabulary and never reports cloud silence',()=>{
 assert.equal(errorClass({code:'ECONNREFUSED'}),'unreachable');
 assert.equal(errorClass({code:'ETIMEDOUT'}),'no_answer');
 assert.equal(errorClass({error_class:'box_meldet_sich_nicht'}),'');
 assert.equal(event({id:'DQ-4',samples:-1}),null);
 const e=event({id:'DQ-4',samples:2,error_class:'invented'},new Date('2026-11-03T14:00:00Z'));
 assert.equal(typeof e.event_id,'string'); delete e.event_id;
 assert.deepEqual(e,{id:'DQ-4',ts:'2026-11-03T14:00:00.000Z',samples:2});
});
test('opaque registry metadata does not change the old source binding',()=>{
 const value={entity_id:'a',entity_type:'producer',edge_source_id:'src-a',driver:{data_source_id:'DQ-4'}};
 assert.deepEqual(parseEntityConfig(Buffer.from(JSON.stringify(value))),{entity_id:'a',entity_type:'producer',edge_source_id:'src-a',data_source_id:'DQ-4'});
});
test('actual polls report requests, decoded samples, failure and budget separately',async()=>{
 const observed=[]; let failed=false;
 const runtime=new MeasurementRuntime({sourceStatus:e=>observed.push(e),readModbus:async()=>{
  if(failed) throw Object.assign(new Error('refused'),{code:'ECONNREFUSED'}); return [50];
 }},()=>{},()=>new Date('2026-11-03T14:00:00Z'));
 const selection={point_key:'deye.hybrid_1p.battery.battery',cadence_s:5};
 assert.equal(runtime.apply({revision:1,catalog_version:catalogDocument.catalog_version,selections:[selection]}).applied,true);
 await runtime.tick();
 assert.equal(observed.filter(e=>e.requests===1).length,1);
 assert.equal(observed.filter(e=>e.samples===1).length,1);
 failed=true;runtime.due.clear();await runtime.tick();
 assert.equal(observed.at(-1).error_class,'unreachable');
 runtime.beginRequest=()=>null;runtime.due.clear();await runtime.tick();
 assert.equal(observed.at(-1).error_class,'budget');
 assert.equal(observed.at(-1).requests,undefined);
});

test('a completed poll cancels its timeout and cannot alter a later source',async()=>{
 const {pollEvidence}=require('./data-source-status');
 const first=pollEvidence(), next=pollEvidence();
 assert.equal(await first.timeout(Promise.resolve('read'),5),'read');
 await new Promise(resolve=>setTimeout(resolve,15));
 assert.equal(first.evidence.error_class,'');assert.equal(next.evidence.error_class,'');
 assert.deepEqual(await next.timeout(new Promise(()=>{}),1),{__overall_timeout:true});
 assert.equal(next.evidence.error_class,'timeout');assert.equal(first.evidence.error_class,'');
});

test('a planned source identity survives a later registry rebinding',()=>{
 const {resolveTarget}=require('./measurement-binding');
 const binding={entities:{a:{entity_id:'a',edge_source_id:'src-a',data_source_id:'DQ-4'}},sources:{'src-a':{}}};
 const target=resolveTarget({entity_id:'a'},{source_kind:'modbus_holding'},binding);
 binding.entities.a.data_source_id='DQ-9';
 assert.equal(target.dataSourceId,'DQ-4');
});
