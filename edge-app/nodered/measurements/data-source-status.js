'use strict';
const TOPIC = 'edge/data-sources/poll';
const boot = Math.random().toString(36).slice(2);
let sequence = 0;
const ERRORS = Object.freeze(['unreachable', 'no_answer', 'invalid_response', 'implausible',
  'fronius_api', 'timeout', 'layout_changed', 'budget']);
function errorClass(error) {
  const value = error && (error.error_class || error.error_code || error.vpCode || error.code);
  if (ERRORS.includes(value)) return value;
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ECONNRESET'].includes(value)) return 'unreachable';
  if (value === 'ETIMEDOUT') return 'no_answer';
  return '';
}
// A local event contains only evidence. The Core resolves identity from the registry.
function event(input, now = new Date()) {
  if (!input || (!input.id && !input.entity_id && !input.source_id)) return null;
  const requests = input.requests ?? 0, samples = input.samples ?? 0;
  if (![requests, samples].every(n => Number.isInteger(n) && n >= 0 && n <= 10000)) return null;
  return { ...(input.id ? { id:input.id } : {}), ...(input.entity_id ? { entity_id:input.entity_id } : {}),
    ...(input.source_id ? { source_id:input.source_id } : {}), ts:now.toISOString(), event_id:boot + '-' + (++sequence),
    ...(input.requests !== undefined ? {requests} : {}), samples, ...(input.failed ? { failed:true } : {}),
    ...(ERRORS.includes(input.error_class) ? { error_class:input.error_class } : {}) };
}
module.exports = { TOPIC, ERRORS, errorClass, event };

// One scope per poll: callbacks from an expired socket cannot taint the next source.
function pollEvidence() {
  const evidence = { requests:0, error_class:'' };
  const failure = error => { const cls = errorClass(error); if (cls) evidence.error_class = cls; };
  const instrument = (socket, connecting) => {
    let writes = 0;
    if (connecting) evidence.requests++;
    const connect = socket.connect;
    // net.Socket replaces its provisional write method while connecting.
    socket.once('connect', () => {
      const write = socket.write;
      socket.write = function (...args) { if (writes++ > 0) evidence.requests++; return write.apply(this, args); };
    });
    if (connect) socket.connect = function (...args) { evidence.requests++; return connect.apply(this, args); };
    socket.on('error', failure);
    return socket;
  };
  return {
    evidence, failure,
    net: raw => raw && Object.assign({}, raw, {
      Socket:function (...args) { return instrument(new raw.Socket(...args), false); },
      createConnection:(...args) => instrument(raw.createConnection(...args), true),
    }),
    http: raw => raw && Object.assign({}, raw, {
      request:(...args) => { evidence.requests++; const req=raw.request(...args); req.on('error',failure); return req; },
      get:(...args) => { evidence.requests++; const req=raw.get(...args); req.on('error',failure); return req; },
    }),
    timeout: (promise, ms) => {
      let timer;
      return Promise.race([promise,new Promise(resolve => {
        timer=setTimeout(()=>{ evidence.error_class='timeout';resolve({__overall_timeout:true}); },ms);
      })]).finally(()=>clearTimeout(timer));
    },
  };
}
module.exports.pollEvidence = pollEvidence;
