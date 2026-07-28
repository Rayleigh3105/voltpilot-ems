'use strict';

/**
 * curtail-lease.e2e.test.js - drives the ACTUAL flow node bodies from
 * flows.json (sources-store + sources-read + sources-curtail-plan +
 * sources-curtail-exec) against in-process Modbus-TCP gateways to prove the
 * BOUNDED write-priority lease (sunspec/curtail-lease.js).
 *
 * This is the regression proof for the live Pilsting incident (2026-07-28):
 * after ONE curtailment test attempt against a half-dead Fronius Datamanager,
 * the executor re-claimed `curtail_want` on every ~10 s setpoint tick (walk
 * retries with no backoff, observe-only readbacks claiming too, no cycle
 * deadline), the read poll yielded unconditionally, and BOTH sources starved
 * for 15+ minutes - the rare free window always fell to the FIRST source, so
 * unit 2 was never read again. The lease rules under test:
 *
 *   - the claim is released on EVERY executor exit (success, refusal, hang);
 *   - one executor cycle is bounded by a hard time budget;
 *   - a failed discovery walk is cached with a backoff (no per-tick retry);
 *   - observe-only ticks take NO claim and are throttled;
 *   - the poll expires an orphaned claim (dead holder) with a warning;
 *   - the poll yields at most MAX_CLAIM_SKIPS ticks per source, then FORCES
 *     the read with a warning - and rotates its start source each cycle, so
 *     no source monopolizes the free windows.
 *
 * No Docker, no hardware.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const D = require('./sunspec/model-discovery');
const lease = require('./sunspec/curtail-lease');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// --- harness -----------------------------------------------------------------

// Run a function-node body with a Node-RED-like context. `flowLog` (optional)
// records every flow.set as {k, v} so a test can prove a key was NEVER set.
async function runFunctionNode(func, {
  msg = {}, flow = {}, sends = [], warns = [], logs = [], ctx = {}, flowLog = null,
} = {}) {
  const sandbox = {
    msg,
    node: {
      status() {},
      error() {},
      warn(w) { warns.push(String(w)); },
      log(l) { logs.push(String(l)); },
      send(m) { sends.push(JSON.parse(JSON.stringify(m))); },
    },
    context: { get: (k) => ctx[k], set: (k, v) => { ctx[k] = v; } },
    flow: {
      get: (k) => flow[k],
      set: (k, v) => { if (flowLog) flowLog.push({ k, v }); flow[k] = v; },
    },
    global: { get: (k) => (k === 'net' ? net : undefined) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map,
    setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

// A Modbus-TCP gateway over per-unit register images: FC3 reads + FC6 writes
// (writes update the image, so a readback sees the written value). Counts
// accepted connections; `hang: true` accepts and never answers (the half-dead
// Datamanager whose Modbus service is restarting).
function startGateway(imgByUnit, { hang = false } = {}) {
  return new Promise((resolve) => {
    let connections = 0;
    const server = net.createServer((sock) => {
      connections++;
      if (hang) return; // accept, never answer
      let acc = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 12) {
          const req = acc.slice(0, 12); acc = acc.slice(12);
          const txid = req.readUInt16BE(0);
          const unit = req[6];
          const fc = req[7];
          const addr = req.readUInt16BE(8);
          const arg = req.readUInt16BE(10);
          const img = imgByUnit[unit];
          const ex = (code) => {
            const e = Buffer.alloc(9);
            e.writeUInt16BE(txid, 0); e.writeUInt16BE(3, 4); e[6] = unit; e[7] = fc | 0x80; e[8] = code;
            sock.write(e);
          };
          if (!img) { ex(0x0b); continue; }
          if (fc === 0x06) {
            if (!img.has(addr)) { ex(0x02); continue; }
            img.set(addr, arg & 0xffff);
            const resp = Buffer.alloc(12);
            req.copy(resp); resp.writeUInt16BE(6, 4);
            sock.write(resp);
            continue;
          }
          if (fc !== 0x03) { ex(0x01); continue; }
          let ok = true;
          for (let i = 0; i < arg; i++) if (!img.has(addr + i)) { ok = false; break; }
          if (!ok) { ex(0x02); continue; }
          const bc = arg * 2;
          const resp = Buffer.alloc(9 + bc);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4); resp[6] = unit; resp[7] = 0x03; resp[8] = bc;
          for (let i = 0; i < arg; i++) resp.writeUInt16BE((img.get(addr + i) || 0) & 0xffff, 9 + i * 2);
          sock.write(resp);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: server.address().port, connections: () => connections,
    }));
  });
}

// A SunSpec image (int+SF dialect) for ONE Fronius unit: Common + Nameplate
// (WRtg = ratedKw) + inverter 103 + Immediate Controls 123 (SF -2). The SAME
// Map is served by the gateway AND walked offline for the discovery cache, so
// discovered write addresses hit real registers.
function unitImage(ratedKw) {
  const img = new Map();
  img.set(40000, (D.SID >>> 16) & 0xffff);
  img.set(40001, D.SID & 0xffff);
  const nameplate = new Array(26).fill(0);
  nameplate[D.M120.WRtg] = Math.round(ratedKw * 100) & 0xffff;
  nameplate[D.M120.WRtg_SF] = 1;
  const controls = new Array(D.M123.LENGTH).fill(0);
  controls[D.M123.WMaxLimPct_SF] = 0xfffe;
  let addr = 40002;
  for (const m of [
    { id: 1, body: new Array(66).fill(0) },
    { id: D.MODEL.NAMEPLATE, body: nameplate },
    { id: 103, body: new Array(50).fill(0) },
    { id: D.MODEL.IMMEDIATE_CONTROLS, body: controls },
  ]) {
    img.set(addr, m.id & 0xffff);
    img.set(addr + 1, m.body.length & 0xffff);
    for (let i = 0; i < m.body.length; i++) img.set(addr + 2 + i, m.body[i] & 0xffff);
    addr += 2 + m.body.length;
  }
  img.set(addr, D.END_MODEL_ID);
  img.set(addr + 1, 0);
  return img;
}

function discOver(img) {
  const reader = (a, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const w = img.get(a + i);
      if (w === undefined) break;
      out.push(w);
    }
    return out;
  };
  return D.discover(reader, { base: 40000 });
}

function froniusSource(id, port, unitId) {
  return {
    id,
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'fronius-eco-25-3-s',
    family: 'sunspec_live',
    communication: 'fronius_sunspec',
    connection: { ip: '127.0.0.1', port, unit_id: unitId, model_type: 'auto', invert_grid_sign: false },
    interval_s: 5,
    capacity_kwp: 25,
  };
}

function curtailSetpoint(port, sourceIds, over) {
  return Object.assign({
    battery_setpoint_kw: 0,
    ts: new Date().toISOString(),
    pv_limit_kw: 10,
    curtail: {
      control_enabled: true,
      pv_uncontrolled_kw: 0,
      sources: sourceIds.map((id) => ({ id, certified: true, capacity_kwp: 25, label: id })),
    },
  }, over || {});
}

// Run the real chain: sources-store over the source list, then
// sources-curtail-plan over the setpoint (its returned msg carries the fleet,
// exactly what the wire delivers), then sources-curtail-exec.
async function runExec({ sources, setpoint, flow, ctx, flowLog }) {
  const sends = [];
  const warns = [];
  const logs = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: sources }, flow, sends: [], warns: [], logs: [] });
  const planned = await runFunctionNode(byId['sources-curtail-plan'].func, {
    msg: { setpoint }, flow, sends: [], warns: [], logs: [],
  });
  assert.ok(planned && planned.curtailFleet, 'the plan node produced a fleet');
  await runFunctionNode(byId['sources-curtail-exec'].func, {
    msg: planned, flow, sends, warns, logs, ctx, flowLog,
  });
  return { sends: sends.map((m) => m.payload), warns, logs };
}

const claimKey = (port) => 'curtail_want:127.0.0.1:' + port;
const claimSets = (flowLog, port) => flowLog.filter((e) => e.k === claimKey(port));

// --- executor: the claim can never outlive its work --------------------------

test('SUCCESS path: the exec writes, reads back, and the claim is released', async () => {
  const img = unitImage(25);
  const gw = await startGateway({ 1: img });
  try {
    const flow = {
      ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: discOver(img) },
    };
    const flowLog = [];
    const { sends } = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint: curtailSetpoint(gw.port, ['src-a']),
      flow, ctx: {}, flowLog,
    });
    const sets = claimSets(flowLog, gw.port);
    assert.ok(sets.some((e) => e.v > 0), 'the write tick ANNOUNCED the lease');
    assert.strictEqual(sets[sets.length - 1].v, 0, 'the last lease action is the release');
    assert.strictEqual(flow[claimKey(gw.port)], 0, 'claim released after the cycle');
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].applied, true);
    assert.strictEqual(sends[0].all_match, true, 'write landed and read back');
    // The write really hit the served registers: pct = 10/25*100 = 40 %, SF -2.
    const disc = discOver(img);
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), 4000);
  } finally { gw.server.close(); }
});

test('REFUSAL path: gateway unreachable - blocked publish, claim still released', async () => {
  const probe = await startGateway({});
  const deadPort = probe.port;
  await new Promise((res) => probe.server.close(res));
  const img = unitImage(25);
  const flow = {
    ['curtail_disc:127.0.0.1:' + deadPort + '#1']: { at: Date.now(), disc: discOver(img) },
  };
  const flowLog = [];
  const { sends, warns } = await runExec({
    sources: [froniusSource('src-a', deadPort, 1)],
    setpoint: curtailSetpoint(deadPort, ['src-a']),
    flow, ctx: {}, flowLog,
  });
  assert.strictEqual(flow[claimKey(deadPort)], 0, 'claim released on the refusal path');
  assert.ok(sends.some((p) => p.blocked && p.reason.includes('Gateway nicht erreichbar')),
    'German cause published: ' + JSON.stringify(sends));
  assert.ok(warns.some((w) => w.includes('nicht erreichbar')), 'refusal warned');
});

test('HANG path: a never-answering gateway ends inside the time budget, claim released, causes published', async () => {
  const img1 = unitImage(25);
  const img2 = unitImage(30);
  const gw = await startGateway({ 1: img1, 2: img2 }, { hang: true });
  try {
    const flow = {
      curtail_deadline_ms: 1200, // test-only override (sv5_acquire_ms precedent)
      ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: discOver(img1) },
      ['curtail_disc:127.0.0.1:' + gw.port + '#2']: { at: Date.now(), disc: discOver(img2) },
    };
    const flowLog = [];
    const started = Date.now();
    const { sends, warns } = await runExec({
      sources: [froniusSource('src-a', gw.port, 1), froniusSource('src-b', gw.port, 2)],
      setpoint: curtailSetpoint(gw.port, ['src-a', 'src-b']),
      flow, ctx: {}, flowLog,
    });
    const took = Date.now() - started;
    assert.ok(took < 6000, 'the cycle is bounded by the budget (took ' + took + ' ms)');
    assert.strictEqual(flow[claimKey(gw.port)], 0, 'claim released on the hang path');
    assert.ok(sends.some((p) => p.blocked && p.reason.includes('Schreiben fehlgeschlagen')),
      'unit 1: the hung write is a named cause: ' + JSON.stringify(sends));
    assert.ok(sends.some((p) => p.blocked && p.reason.includes('Zeitbudget erschoepft')),
      'unit 2: the exhausted budget is a named cause');
    assert.ok(warns.some((w) => w.includes('Zeitbudget') && w.includes('Lease wird freigegeben')),
      'the budget abort is warned loudly: ' + JSON.stringify(warns));
  } finally { gw.server.close(); }
});

test('FAILED discovery is cached with a backoff - the next tick does NO I/O and takes NO claim', async () => {
  const gw = await startGateway({}, { hang: true });
  try {
    const flow = { curtail_deadline_ms: 1200 };
    const ctx = {};
    const r1 = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint: curtailSetpoint(gw.port, ['src-a']),
      flow, ctx, flowLog: [],
    });
    assert.strictEqual(gw.connections(), 1, 'run 1 walked (one connection)');
    assert.ok(r1.sends.some((p) => p.blocked && p.reason.includes('SunSpec-Modelle nicht lesbar')),
      'run 1 publishes the walk failure: ' + JSON.stringify(r1.sends));
    const cached = flow['curtail_disc:127.0.0.1:' + gw.port + '#1'];
    assert.ok(cached && cached.failed === true && cached.reason, 'failure cached with a reason');
    assert.ok(r1.warns.some((w) => w.includes('naechster Versuch')), 'backoff named in the warn');

    const flowLog2 = [];
    const r2 = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint: curtailSetpoint(gw.port, ['src-a']),
      flow, ctx, flowLog: flowLog2,
    });
    assert.strictEqual(gw.connections(), 1, 'run 2 does NOT reconnect (backoff)');
    assert.strictEqual(claimSets(flowLog2, gw.port).length, 0, 'run 2 takes NO claim');
    assert.ok(r2.sends.some((p) => p.blocked && p.reason.includes('SunSpec-Modelle nicht lesbar')),
      'run 2 still publishes the cached cause (the card never goes blank)');
  } finally { gw.server.close(); }
});

test('OBSERVE-only ticks take NO claim and are throttled to one pass per window', async () => {
  const img = unitImage(25);
  const gw = await startGateway({ 1: img });
  try {
    // Uncertified + kill-switch on: plan.ok with readbacks but writes:[] -
    // the executor may only observe.
    const setpoint = curtailSetpoint(gw.port, ['src-a']);
    setpoint.curtail.sources[0].certified = false;
    const flow = {
      ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: discOver(img) },
    };
    const ctx = {};
    const flowLog1 = [];
    const r1 = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint, flow, ctx, flowLog: flowLog1,
    });
    assert.strictEqual(claimSets(flowLog1, gw.port).length, 0, 'observing claims NOTHING');
    assert.strictEqual(gw.connections(), 1);
    assert.strictEqual(r1.sends.length, 1, 'the readback is published');
    assert.strictEqual(r1.sends[0].applied, false);
    assert.strictEqual(r1.sends[0].registers.length, 3, 'actual register state on the card');

    const r2 = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint, flow, ctx, flowLog: [],
    });
    assert.strictEqual(gw.connections(), 1, 'the second observe inside the window does NO I/O');
    assert.strictEqual(r2.sends.length, 0, 'throttled tick publishes nothing new');
  } finally { gw.server.close(); }
});

// --- poll: bounded yields, forced reads, expiry, rotation --------------------

// A compact-sim image for the modbus_tcp `sunspec` PROFILE (9 registers).
function simImage(pvKw, gridKw) {
  const img = new Map();
  const s16w = (kw) => Math.round(kw * 100) & 0xffff;
  for (let i = 0; i < 9; i++) img.set(i, 0);
  img.set(0, s16w(gridKw));
  img.set(1, s16w(pvKw));
  return img;
}

function simSource(id, port) {
  return {
    id,
    role: 'pv-generation',
    brand: 'generic_modbus',
    model: 'sunspec',
    family: 'sunspec',
    communication: 'modbus_tcp',
    connection: { ip: '127.0.0.1', port, unit_id: 1, profile: 'sunspec' },
    interval_s: 5,
  };
}

async function pollTick(flow, ctx) {
  const sends = [];
  const warns = [];
  const logs = [];
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns, logs, ctx });
  return { sends: sends.map((m) => m[0]).filter(Boolean), warns, logs };
}

test('POLL: an orphaned claim (dead holder) is expired with a warning and reads resume', async () => {
  const gw = await startGateway({ 1: simImage(7, 0) });
  try {
    const flow = {};
    const ctx = {};
    await runFunctionNode(byId['sources-store'].func, { msg: { payload: [simSource('src-a', gw.port)] }, flow });
    flow[claimKey(gw.port)] = Date.now() - lease.CLAIM_TTL_MS - 5000; // holder died
    const t1 = await pollTick(flow, ctx);
    assert.strictEqual(flow[claimKey(gw.port)], 0, 'the orphaned claim is cleared');
    assert.ok(t1.warns.some((w) => w.includes('ohne Freigabe') && w.includes('verworfen')),
      'the dead claim is warned, never silent: ' + JSON.stringify(t1.warns));
    assert.strictEqual(t1.sends.length, 1, 'the source is read the SAME tick');
    assert.strictEqual(t1.sends[0].payload.pv_power_kw, 7);
  } finally { gw.server.close(); }
});

test('POLL: reads resume within one cycle after a normal release', async () => {
  const gw = await startGateway({ 1: simImage(5, 0) });
  try {
    const flow = {};
    const ctx = {};
    await runFunctionNode(byId['sources-store'].func, { msg: { payload: [simSource('src-a', gw.port)] }, flow });
    flow[claimKey(gw.port)] = Date.now(); // live claim
    const t1 = await pollTick(flow, ctx);
    assert.strictEqual(t1.sends.length, 0, 'a live claim is honored');
    flow[claimKey(gw.port)] = 0; // executor released
    const t2 = await pollTick(flow, ctx);
    assert.strictEqual(t2.sends.length, 1, 'the very next tick reads again');
  } finally { gw.server.close(); }
});

test('POLL: under sustained claim churn every source is force-read after the skip budget - unit 2 never starves', async () => {
  const gw = await startGateway({ 1: simImage(9, 0) });
  try {
    const flow = {};
    const ctx = {};
    await runFunctionNode(byId['sources-store'].func, {
      msg: { payload: [simSource('src-a', gw.port), simSource('src-b', gw.port)] }, flow,
    });
    const perTick = [];
    let warns = [];
    for (let i = 0; i < lease.MAX_CLAIM_SKIPS + 1; i++) {
      // The churn: the executor re-stamps the claim before every poll tick
      // (the live incident's shape - each ~10 s setpoint tick re-claimed).
      flow[claimKey(gw.port)] = Date.now();
      const t = await pollTick(flow, ctx);
      perTick.push(t.sends.map((s) => s.source_id));
      warns = warns.concat(t.warns);
    }
    for (let i = 0; i < lease.MAX_CLAIM_SKIPS; i++) {
      assert.deepStrictEqual(perTick[i], [], 'tick ' + (i + 1) + ' yields to the live claim');
    }
    const forced = perTick[lease.MAX_CLAIM_SKIPS];
    assert.ok(forced.includes('src-a') && forced.includes('src-b'),
      'past the budget BOTH sources are read despite the live claim: ' + JSON.stringify(perTick));
    assert.ok(warns.some((w) => w.includes('erzwungen') && w.includes('verhungern')),
      'the forced read warns about the starvation cause: ' + JSON.stringify(warns));
  } finally { gw.server.close(); }
});

test('POLL: the cycle start rotates across sources - a free window is not always spent on source #1', async () => {
  const gw = await startGateway({ 1: simImage(4, 0) });
  try {
    const flow = {};
    const ctx = {};
    await runFunctionNode(byId['sources-store'].func, {
      msg: { payload: [simSource('src-a', gw.port), simSource('src-b', gw.port)] }, flow,
    });
    const t1 = await pollTick(flow, ctx);
    const t2 = await pollTick(flow, ctx);
    assert.deepStrictEqual(t1.sends.map((s) => s.source_id), ['src-a', 'src-b'], 'tick 1 starts at source 1');
    assert.deepStrictEqual(t2.sends.map((s) => s.source_id), ['src-b', 'src-a'], 'tick 2 starts at source 2');
  } finally { gw.server.close(); }
});
