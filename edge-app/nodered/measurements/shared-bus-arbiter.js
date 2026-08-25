'use strict';

// Process-wide per-target lease. Unlike flow context this module instance is
// shared by every tab and every palette node in one Node-RED process.
const targets = new Map();

function state(target) {
  const key=String(target||'primary');
  let value=targets.get(key);
  if(!value){value={active:false,controls:[],polls:[]};targets.set(key,value);}
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
  const job=current.controls.shift()||current.polls.shift();
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

function resetForTest(){targets.clear();}

module.exports={runPoll,runControl,acquirePoll,acquireControl,targetKey,resetForTest};
