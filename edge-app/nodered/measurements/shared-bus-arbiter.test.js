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

test('an already waiting poll cannot starve under a continuously replenished control queue',async()=>{
  arbiter.resetForTest();
  const order=[];
  let active=0;
  let maxActive=0;
  let releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const enter=async(label,run)=>{
    active+=1;
    maxActive=Math.max(maxActive,active);
    order.push(label);
    try{return await run();}finally{active-=1;}
  };
  const first=arbiter.runPoll('busy:502',()=>enter('first-poll',()=>firstGate));
  await new Promise(resolve=>setImmediate(resolve));
  const waiting=arbiter.runPoll('busy:502',()=>enter('waiting-poll',async()=>{}));

  const controls=[];
  let finishControls;
  const controlsDone=new Promise(resolve=>{finishControls=resolve;});
  const enqueueControl=(index)=>{
    const promise=arbiter.runControl('busy:502',()=>enter('control-'+index,async()=>{
      if(index<100) enqueueControl(index+1);
      else finishControls();
    }));
    controls.push(promise);
  };
  enqueueControl(1);
  releaseFirst();
  await waiting;
  await controlsDone;
  await Promise.all([first,...controls]);

  const waitingIndex=order.indexOf('waiting-poll');
  const controlsBefore=order.slice(0,waitingIndex).filter(x=>x.startsWith('control-')).length;
  assert.equal(maxActive,1,'fairness must never create a second active bus operation');
  assert.equal(controlsBefore,arbiter.MAX_CONTROL_BURST_WITH_WAITING_POLL,
    'the waiting poll gets a bounded lease despite continuously appended controls');
  assert.ok(waitingIndex<101,'the old strict-priority failure ran the poll only after 100 controls');
});
