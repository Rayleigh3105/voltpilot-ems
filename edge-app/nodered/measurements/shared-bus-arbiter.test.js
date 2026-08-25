'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const arbiter=require('./shared-bus-arbiter');

test('control arriving during an in-flight poll owns the next lease through readback',async()=>{
  arbiter.resetForTest();
  const order=[]; let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const first=arbiter.runPoll('box:502',async()=>{order.push('poll-start');await gate;order.push('poll-end');});
  await new Promise(resolve=>setImmediate(resolve));
  const second=arbiter.runPoll('box:502',async()=>order.push('poll-2'));
  const control=arbiter.runControl('box:502',async()=>{
    order.push('write'); await new Promise(resolve=>setImmediate(resolve)); order.push('readback');
  });
  release();
  await Promise.all([first,second,control]);
  assert.deepEqual(order,['poll-start','poll-end','write','readback','poll-2']);
});

test('a rejected control releases the lease for reconnect work',async()=>{
  arbiter.resetForTest(); const order=[];
  await arbiter.runControl('box:8899',async()=>{order.push('control');throw new Error('timeout');}).catch(()=>{});
  await arbiter.runPoll('box:8899',async()=>order.push('reconnect-poll'));
  assert.deepEqual(order,['control','reconnect-poll']);
});

test('an explicit control lease remains held until readback releases it',async()=>{
  arbiter.resetForTest();
  const lease=await arbiter.acquireControl('inverter:502');
  let polled=false;
  const poll=arbiter.runPoll('inverter:502',async()=>{polled=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(polled,false);
  lease.release();
  await poll;
  assert.equal(polled,true);
});

test('palette object poll and host:port control share one physical bus lane',async()=>{
  arbiter.resetForTest();
  const order=[];
  let active=0;
  let maxActive=0;
  let releasePoll;
  const pollGate=new Promise(resolve=>{releasePoll=resolve;});
  const enter=(label)=>{
    active+=1;
    maxActive=Math.max(maxActive,active);
    order.push(label+'-start');
  };
  const leave=(label)=>{
    order.push(label+'-end');
    active-=1;
  };

  const poll=arbiter.runPoll({host:'logger',port:502,unitId:1},async()=>{
    enter('palette-poll');
    await pollGate;
    leave('palette-poll');
  });
  await new Promise(resolve=>setImmediate(resolve));
  const control=arbiter.runControl(arbiter.targetKey({host:'logger',port:502},502),async()=>{
    enter('control');
    leave('control');
  });
  await new Promise(resolve=>setImmediate(resolve));

  assert.equal(maxActive,1,'one physical host:port must never receive overlapping operations');
  assert.deepEqual(order,['palette-poll-start']);
  releasePoll();
  await Promise.all([poll,control]);
  assert.deepEqual(order,[
    'palette-poll-start','palette-poll-end','control-start','control-end'
  ]);
});
