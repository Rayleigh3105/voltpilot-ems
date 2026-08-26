'use strict';

// Process-wide per-target lease. Unlike flow context this module instance is
// shared by every tab and every palette node in one Node-RED process.
const targets = new Map();
// One already-waiting poll yields to the next control lease, preserving the
// safety-critical priority. It is then guaranteed one lease before another
// control may run, so an endless control producer cannot starve telemetry.
const MAX_CONTROL_BURST_WITH_WAITING_POLL = 1;

function state(target) {
  const key=canonicalTarget(target);
  let value=targets.get(key);
  if(!value){value={active:false,controls:[],polls:[],controlBurst:0};targets.set(key,value);}
  return value;
}

function enqueue(target,kind,run) {
  if(typeof run!=='function') return Promise.reject(new Error('bus lease without operation'));
  return new Promise((resolve,reject)=>{
    const current=state(target);
    current[kind==='control'?'controls':'polls'].push({run,resolve,reject});
    pump(current);
  });
}

function pump(current) {
  if(current.active) return;
  let job;
  if(current.controls.length && (!current.polls.length
      || current.controlBurst < MAX_CONTROL_BURST_WITH_WAITING_POLL)) {
    job=current.controls.shift();
    // Controls which ran before a poll existed do not spend its fairness
    // allowance. A newly waiting poll still yields to exactly the next control.
    current.controlBurst=current.polls.length ? current.controlBurst+1 : 0;
  } else if(current.polls.length) {
    job=current.polls.shift();
    current.controlBurst=0;
  }
  if(!job) return;
  current.active=true;
  Promise.resolve().then(job.run).then(job.resolve,job.reject).finally(()=>{
    // Socket.destroy() completes asynchronously. Keep the process-wide lease
    // through one event-loop turn so the peer's close is observed before the
    // next queued poll/control opens a replacement connection. Releasing in
    // this microtask reproduced two simultaneous sessions on single-client
    // Solarman loggers even though write + readback had already resolved.
    setTimeout(()=>{current.active=false;pump(current);},0);
  });
}

function runPoll(target,run){return enqueue(target,'poll',run);}
function runControl(target,run){return enqueue(target,'control',run);}
function acquire(target,kind) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  return new Promise((resolve, reject) => {
    enqueue(target, kind, () => {
      let released = false;
      resolve({ release:() => { if (!released) { released=true; release(); } } });
      return held;
    }).catch(reject);
  });
}
function acquirePoll(target){return acquire(target,'poll');}
function acquireControl(target){return acquire(target,'control');}
function targetKey(connection,defaultPort){
  const value=connection||{};
  return String(value.ip||value.host||'primary')+':'+String(Number(value.port)||defaultPort||502);
}

function canonicalTarget(target){
  // Palette poll nodes pass their connection plan directly, while generated
  // control paths pass the already-rendered host:port string. Both forms must
  // identify one physical lane; String(object) would create "[object Object]"
  // and let a control overlap the palette read on the same device.
  if(target&&typeof target==='object') return targetKey(target,502);
  return String(target||'primary');
}

function resetForTest(){targets.clear();}

module.exports={runPoll,runControl,acquirePoll,acquireControl,targetKey,resetForTest,
  MAX_CONTROL_BURST_WITH_WAITING_POLL};
