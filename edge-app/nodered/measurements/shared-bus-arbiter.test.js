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
