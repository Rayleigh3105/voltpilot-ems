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
const sharedBus = require('./measurements/shared-bus-arbiter');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// --- harness -----------------------------------------------------------------

// Run a function-node body with a Node-RED-like context. `flowLog` (optional)
// records every flow.set as {k, v} so a test can prove a key was NEVER set.
async function runFunctionNode(func, {
  msg = {}, flow = {}, sends = [], warns = [], logs = [], ctx = {}, flowLog = null,
  clock = Date,
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
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    // The node's clock is INJECTED (default: the real Date). Every flow test
    // already hands the vm context its own `Date` binding - that existing seam
    // is what lets a test state an elapsed-budget fact instead of racing a
    // timer for it; see testClock() and the HANG-path test.
    Buffer, Date: clock, Math, isFinite, Number, Array, Object, JSON, Promise, Map,
    setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

// testClock - a Date the node reads, offset from the real one by an amount the
// test controls. REAL durations are untouched: every timer, socket timeout and
// wall-clock assertion in this file keeps using the real Date; only the clock
// INSIDE the vm sandbox jumps.
//
// WHY (measured, 2026-08-26): the executor caps a hung op to the REMAINING
// cycle budget, so against a never-answering gateway the op expires EXACTLY on
// the deadline - and whether the NEXT unit then sees `Date.now() > deadlineAt`
// is a sub-millisecond coin flip (a libuv timer may fire a hair before
// `Date.now()` reaches its due time). Under CPU load it loses: the next unit
// slips past the budget check and does a second op on the OP_TIMEOUT_MIN_MS
// floor, so the "Zeitbudget erschoepft" cause never appears. Widening the
// budget only moves the tie; stating the elapsed time removes it.
function testClock() {
  let offset = 0;
  class ShiftedDate extends Date {
    constructor(...args) { if (args.length === 0) super(Date.now() + offset); else super(...args); }
    static now() { return Date.now() + offset; }
  }
  return { Date: ShiftedDate, advance(ms) { offset += ms; } };
}

// A Modbus-TCP gateway over per-unit register images: FC3 reads + FC6 writes
// (writes update the image, so a readback sees the written value). Counts
// accepted connections and FC6 writes; the failure modes are the ones measured
// live on the Pilsting Fronius Datamanager (2026-08-06):
//
//   hang     accept the TCP connection and never answer (the half-dead
//            Datamanager whose Modbus service is restarting).
//   swallow  answer every FC6 with a correct echo and NOT change the register
//            ("Schlucker": live at 10:51 the commanded 2593 was answered OK
//            while the register read 10000 for 105 s straight).
//   revert   the vendor dead-man: `revertMs` after a write, the addresses in
//            `revert` snap back to their given values ("Reverter": the native
//            WMaxLimPct_RvrtTms lifting a cap that is not refreshed).
//   enaQuirk writes to the enable register ALWAYS store 1, whatever was
//            commanded (this Datamanager answers a commanded 0 with 1 for
//            ever).
//   transactionalOnly  a single-register (FC6) write is ACKed and stored, but
//            only a BLOCK write (FC16) is ADOPTED as the active limit - the
//            live Pilsting Datamanager behaviour (09.08.2026).
//   fc16     'refuse' answers every FC16 with Modbus exception 0x01 (a firmware
//            that only speaks FC6), so the flip-back has something to fail on.
function startGateway(imgByUnit, {
  hang = false, swallow = false, revertMs = 0, revert = {}, enaQuirk = 0,
  transactionalOnly = false, fc16 = 'accept', onRequest = null,
} = {}) {
  return new Promise((resolve) => {
    let connections = 0;
    let writes = 0;
    const timers = [];
    const applied = new Map(); // what the device actually ENFORCES
    const blockWrites = [];
    const server = net.createServer((sock) => {
      connections++;
      if (hang) {
        // Accept, DRAIN, never answer - a half-dead Datamanager still reads
        // its socket. Draining is inert for the reply path (there is none) and
        // gives a test the one causal hook it needs: "the request is on the
        // wire". `onRequest` is optional; every hang test without it behaves
        // exactly as before.
        sock.on('error', () => {});
        if (onRequest) sock.on('data', () => { onRequest(); });
        return;
      }
      let acc = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        // Length-aware framing: an fn-0x10 request is 13 + 2*n bytes, so a
        // fixed 12-byte slice would desynchronise the stream.
        while (acc.length >= 6) {
          const need = 6 + acc.readUInt16BE(4);
          if (acc.length < need) break;
          const req = acc.slice(0, need); acc = acc.slice(need);
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
          const store = (a, v) => {
            img.set(a, (enaQuirk && a === enaQuirk) ? 1 : (v & 0xffff));
            if (revertMs > 0 && Object.prototype.hasOwnProperty.call(revert, a)) {
              timers.push(setTimeout(() => img.set(a, revert[a] & 0xffff), revertMs));
            }
          };
          if (fc === 0x06) {
            if (!img.has(addr)) { ex(0x02); continue; }
            writes++;
            // The device ACKNOWLEDGES either way - that is what makes the
            // swallowing so hard to see without a readback.
            if (!swallow) store(addr, arg);
            // transactionalOnly reproduces the LIVE Pilsting Datamanager: a
            // single-register write is acknowledged AND lands in the register
            // (so a readback confirms it!) but never becomes the ACTIVE limit.
            if (!transactionalOnly && !swallow) applied.set(addr, arg & 0xffff);
            const resp = Buffer.alloc(12);
            req.copy(resp, 0, 0, 12); resp.writeUInt16BE(6, 4);
            sock.write(resp);
            continue;
          }
          if (fc === 0x10) {
            if (fc16 === 'refuse') { ex(0x01); continue; } // firmware without FC16
            const count = arg;
            const bc = req[12];
            if (bc !== count * 2 || req.length < 13 + bc) { ex(0x03); continue; }
            let okBlk = true;
            for (let i = 0; i < count; i++) if (!img.has(addr + i)) { okBlk = false; break; }
            if (!okBlk) { ex(0x02); continue; }
            writes++;
            blockWrites.push({ unit, addr, values: Array.from({ length: count }, (_, i) => req.readUInt16BE(13 + i * 2)) });
            if (!swallow) {
              for (let i = 0; i < count; i++) {
                const v = req.readUInt16BE(13 + i * 2);
                store(addr + i, v);
                applied.set(addr + i, v); // the SET is what the device adopts
              }
            }
            const resp = Buffer.alloc(12);
            resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(6, 4); resp[6] = unit; resp[7] = 0x10;
            resp.writeUInt16BE(addr, 8); resp.writeUInt16BE(count, 10);
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
      server,
      port: server.address().port,
      connections: () => connections,
      writes: () => writes,
      applied: (a) => (applied.has(a) ? applied.get(a) : null),
      blockWrites: () => blockWrites.slice(),
      close: () => { timers.forEach(clearTimeout); server.close(); },
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
async function runExec({ sources, setpoint, flow, ctx, flowLog, clock = Date }) {
  const sends = [];
  const warns = [];
  const logs = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: sources }, flow, sends: [], warns: [], logs: [], clock });
  const planned = await runFunctionNode(byId['sources-curtail-plan'].func, {
    msg: { setpoint }, flow, sends: [], warns: [], logs: [], clock,
  });
  assert.ok(planned && planned.curtailFleet, 'the plan node produced a fleet');
  await runFunctionNode(byId['sources-curtail-exec'].func, {
    msg: planned, flow, sends, warns, logs, ctx, flowLog, clock,
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

test('PILSTING: a transactional Datamanager ADOPTS the block write - the legacy single writes it did not', async () => {
  // THE regression test for the live failure of 09.08.2026. Two supervised
  // tests on a real 2x Fronius Eco 27 behind one Datamanager: our WMaxLimPct
  // value stood in the register for the full 120 s (register_confirmed: true)
  // and the inverter kept producing far above the cap, while the RvrtTms write
  // never took at all (commanded 60, read 12000 - the previous controller's
  // value). That is a device that ACKNOWLEDGES and STORES a single-register
  // write but only ADOPTS a complete parameter SET.
  //
  // The gateway below models exactly that (transactionalOnly). `applied` is what
  // the device would actually enforce; the register image is what a readback
  // sees - and the whole point is that the two can disagree.
  const img = unitImage(25);
  const gw = await startGateway({ 1: img }, { transactionalOnly: true });
  try {
    const disc = discOver(img);
    const c = disc.controls;
    const flow = { ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc } };
    const { sends } = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint: curtailSetpoint(gw.port, ['src-a']),
      flow, ctx: {}, flowLog: [],
    });

    // ONE transaction over the five contiguous registers, starting at WMaxLimPct.
    const blocks = gw.blockWrites();
    assert.strictEqual(blocks.length, 1, 'exactly one block write per applied cap');
    assert.strictEqual(blocks[0].addr, c.wMaxLimPctAddr);
    assert.deepStrictEqual(blocks[0].values, [4000, 0, 60, 0, 1],
      'pct 40 %, window 0, the 60 s dead-man, ramp 0, enable last');

    // ADOPTED, not merely stored: this is what the FC6 path never achieved.
    assert.strictEqual(gw.applied(c.wMaxLimPctAddr), 4000, 'the cap is in force');
    assert.strictEqual(gw.applied(c.wMaxLimEnaAddr), 1, 'the limit is enabled');
    // And the revert timer landed - the register that never moved in the field.
    assert.strictEqual(img.get(c.wMaxLimPctRvrtTmsAddr), 60);
    assert.strictEqual(gw.applied(c.wMaxLimPctRvrtTmsAddr), 60);
    assert.strictEqual(sends[0].all_match, true);
  } finally { gw.server.close(); }
});

test('PILSTING: the FC6 flip-back reproduces the field symptom - registers confirm, nothing is adopted', async () => {
  // The same gateway, with the source flipped back to the legacy per-register
  // form. This is NOT a test of a feature we want; it PINS the failure the new
  // default fixes, so a future change back to single writes cannot look green.
  const img = unitImage(25);
  const gw = await startGateway({ 1: img }, { transactionalOnly: true });
  try {
    const disc = discOver(img);
    const c = disc.controls;
    // Seed the register with a foreign controller's revert timer, exactly as the
    // Loxone had left it (12000 s = 3.3 h).
    img.set(c.wMaxLimPctRvrtTmsAddr, 12000);
    const src = froniusSource('src-a', gw.port, 1);
    src.connection.curtail_write_fc = 6;
    const flow = { ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc } };
    const { sends } = await runExec({
      sources: [src],
      setpoint: curtailSetpoint(gw.port, ['src-a']),
      flow, ctx: {}, flowLog: [],
    });
    assert.strictEqual(gw.blockWrites().length, 0, 'the flip-back writes no block');
    // The register HOLDS our value - the readback is honestly "confirmed" ...
    assert.strictEqual(img.get(c.wMaxLimPctAddr), 4000);
    assert.strictEqual(sends[0].all_match, true, 'the field symptom: the readback agrees');
    // ... and the device adopts NOTHING. Register confirmation alone never
    // proved enforcement - which is why the clamp/plateau evidence exists.
    assert.strictEqual(gw.applied(c.wMaxLimPctAddr), null, 'the cap was never adopted');
    assert.strictEqual(gw.applied(c.wMaxLimEnaAddr), null);
  } finally { gw.server.close(); }
});

test('a firmware that REFUSES FC16 surfaces the exception instead of silently doing nothing', async () => {
  const img = unitImage(25);
  const gw = await startGateway({ 1: img }, { fc16: 'refuse' });
  try {
    const flow = { ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: discOver(img) } };
    const { sends } = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint: curtailSetpoint(gw.port, ['src-a']),
      flow, ctx: {}, flowLog: [],
    });
    assert.strictEqual(sends.length, 1);
    assert.notStrictEqual(sends[0].all_match, true, 'a refused write never claims a match');
    const said = JSON.stringify(sends[0]);
    assert.ok(/Ausnahme|Modbus/i.test(said), 'the refusal names a Modbus cause: ' + said);
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
  // Unit 2's refusal must be a FACT, not a race. The executor caps a hung op to
  // the remaining budget, so unit 1's write expires exactly ON the deadline and
  // unit 2's `Date.now() > deadlineAt` decides on a hair (measured under CPU
  // load: it loses, unit 2 then does a second floor-timeout op and the exhausted
  // budget never gets named). So the node's clock jumps once the hung write is
  // on the wire - AFTER unit 1's op timeout was computed and armed, so unit 1
  // still burns its full real 1200 ms and still fails with the socket 'Timeout'.
  // Real time is untouched; the `took` bound below still measures the wall clock.
  // Any jump larger than the remaining budget makes unit 2's refusal
  // unambiguous; 5 s leaves ~4 s of slack over the 1.2 s budget.
  const CLOCK_JUMP_MS = 5000;
  const clock = testClock();
  let bumped = false;
  const gw = await startGateway({ 1: img1, 2: img2 }, {
    hang: true,
    onRequest: () => { if (!bumped) { bumped = true; clock.advance(CLOCK_JUMP_MS); } },
  });
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
      flow, ctx: {}, flowLog, clock: clock.Date,
    });
    const took = Date.now() - started;
    assert.ok(bumped, 'the hung write reached the gateway (the clock hook fired)');
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

// --- the First-Light hardening (live Pilsting findings, 2026-08-06) ---------
//
// Three device behaviours, all measured on the captain's real Datamanager,
// driven through the ACTUAL flow nodes: the SWALLOWER, the REVERTER and the
// CLAMPER. Plus the Ena firmware quirk on the release path.

// A curtailment setup: one certified Fronius unit with a discovered image.
async function curtailRun(gw, img, { flow, ctx, over, sourceId = 'src-a' } = {}) {
  return runExec({
    sources: [froniusSource(sourceId, gw.port, 1)],
    setpoint: curtailSetpoint(gw.port, [sourceId], over),
    flow, ctx: ctx || {}, flowLog: [],
  });
}

test('SCHLUCKER: a write the device acknowledges but discards is retried, bounded, then NAMED - and never claims a match', async () => {
  const img = unitImage(25);
  const disc = discOver(img);
  const gw = await startGateway({ 1: img }, { swallow: true });
  try {
    const flow = {
      ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: disc },
      curtail_refresh_ms: 0, // every tick is a refresh tick (test seam)
    };
    const ctx = {};
    const rounds = [];
    for (let i = 0; i < 5; i++) {
      ctx.curtail_busy_since = 0;
      rounds.push(await curtailRun(gw, img, { flow, ctx }));
    }
    const pubs = rounds.flatMap((r) => r.sends);

    // The register never took the command - so nothing ever claims it did.
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), 0, 'the swallower kept its register');
    assert.ok(pubs.every((p) => p.all_match !== true), 'no publish may claim a match: ' + JSON.stringify(pubs.map((p) => p.all_match)));
    assert.ok(pubs.some((p) => (p.mismatch_roles || []).includes('pv_limit_pct')),
      'the BINDING register is named as the mismatch');

    // Bounded: the ladder stops. The in-tick retry makes the first tick write
    // twice, so counting rounds is not the bound - the bound is that the
    // writes STOP while the ticks continue.
    const before = gw.writes();
    ctx.curtail_busy_since = 0;
    const cooling = await curtailRun(gw, img, { flow, ctx });
    assert.strictEqual(gw.writes(), before, 'the cooldown writes NOTHING - never a hot loop');

    // ... and the CAUSE is on the card, not a silent giving-up.
    const last = cooling.sends[cooling.sends.length - 1];
    assert.strictEqual(last.blocked, true);
    assert.ok(last.reason.includes('EVU-Editor'), 'the honest cause names the lever: ' + last.reason);
    assert.ok(rounds.flatMap((r) => r.warns).some((w) => w.includes('nicht uebernommen')),
      'the discarded command is warned, never silent');
  } finally { gw.close(); }
});

test('REVERTER: the native dead-man lifts an un-refreshed cap - the refresh puts it back', async () => {
  const img = unitImage(25);
  const disc = discOver(img);
  const pctAddr = disc.controls.wMaxLimPctAddr;
  // The vendor dead-man, compressed: 150 ms instead of 60 s, reverting the
  // limit register to 100 % exactly like WMaxLimPct_RvrtTms does.
  const gw = await startGateway({ 1: img }, { revertMs: 150, revert: { [pctAddr]: 10000 } });
  try {
    const flow = {
      ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: disc },
      curtail_refresh_ms: 0,
    };
    const ctx = {};
    const t1 = await curtailRun(gw, img, { flow, ctx });
    assert.strictEqual(t1.sends[0].all_match, true, 'the first write lands');
    assert.strictEqual(img.get(pctAddr), 4000, 'cap 10/25 = 40 % at SF -2');

    // THE LIVE DEFECT: without a refresh the inverter takes the cap back.
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(img.get(pctAddr), 10000, 'the dead-man lifted the un-refreshed cap');

    // The next executor tick re-applies it - inside the revert window in
    // production (REFRESH_MS 20 s < RvrtTms 60 s).
    ctx.curtail_busy_since = 0;
    const t2 = await curtailRun(gw, img, { flow, ctx });
    assert.strictEqual(img.get(pctAddr), 4000, 'the refresh put the cap back');
    assert.strictEqual(t2.sends[0].applied, true, 'the tick really WROTE, it did not just look');
    assert.strictEqual(t2.sends[0].all_match, true);
  } finally { gw.close(); }
});

test('KLEMMER: a holding register plus power AT the cap reports a confirmed, enforced limit', async () => {
  const img = unitImage(25);
  const disc = discOver(img);
  const gw = await startGateway({ 1: img });
  try {
    const key = '127.0.0.1:' + gw.port + '#1';
    const flow = {
      ['curtail_disc:' + key]: { at: Date.now(), disc: disc },
      // The plant is CLAMPED at the cap (10 kW) while it could deliver ~22 kW;
      // the settle window is already over, so the effect check has a verdict.
      ['src_last:src-a']: { pv_kw: 10.0, at: Date.now() },
      ['curtail_enf:' + key]: { activeSince: Date.now() - 120000, capKw: 10 },
    };
    const r = await curtailRun(gw, img, { flow, ctx: {} });
    const p = r.sends[0];
    assert.strictEqual(p.applied, true);
    assert.strictEqual(p.all_match, true, 'the register holds the commanded value');
    assert.strictEqual(p.enforcement.status, 'ok');
    assert.strictEqual(p.enforcement.possible_override, false);
    assert.strictEqual(p.enforcement.measured_kw, 10.0);
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), 4000);
  } finally { gw.close(); }
});

test('ENA-QUIRK: a commanded 0 answered with 1 does NOT make the release look broken', async () => {
  const img = unitImage(25);
  const disc = discOver(img);
  const gw = await startGateway({ 1: img }, { enaQuirk: disc.controls.wMaxLimEnaAddr });
  try {
    const key = '127.0.0.1:' + gw.port + '#1';
    const flow = {
      ['curtail_disc:' + key]: { at: Date.now(), disc: disc },
      ['curtail_was:' + key]: 1, // the unit WAS curtailed, so a release is due
    };
    // No pv_limit_kw -> release: WMaxLimPct back to 100 %, Ena commanded 0.
    const r = await curtailRun(gw, img, { flow, ctx: {}, over: { pv_limit_kw: undefined } });
    const p = r.sends[0];
    assert.strictEqual(img.get(disc.controls.wMaxLimEnaAddr), 1, 'the firmware kept its 1');
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), 10000, 'but the BINDING register is released');
    assert.strictEqual(p.all_match, true, 'the release is confirmed - a 100 % limit throttles nothing');
    assert.deepStrictEqual(p.mismatch_roles, [], 'the quirk is not a mismatch');
    assert.deepStrictEqual(p.quirk_roles, ['pv_limit_enable']);
    assert.ok(p.quirk_note.includes('WMaxLimPct'), 'the note names the register that binds');
    assert.notStrictEqual(p.blocked, true, 'a known quirk is never a fault');
  } finally { gw.close(); }
});

// --- the DELIVERY half of the dynamic feed-in limitation ---------------------
//
// The control LOOP lives in the core (guards.ExportLimiter); it hands its plant
// cap to the executor through the SAME sp.pv_limit_kw the plan uses, so nothing
// here changed. What these cases prove is that the delivery is fast and honest
// enough for a COMPLIANCE limit:
//
//   - a FALLING cap (the unplugged wallbox) is written on the very tick it
//     arrives - it must never wait out the 20-s refresh interval;
//   - the plant cap is SPLIT across the units, minus the share the path cannot
//     control (the Deye hybrid), which is what makes the cap a plant-level
//     quantity rather than a per-inverter one;
//   - an UNRELEASED unit is not written, and says so - the watchdog is
//     provably ineffective there, which is exactly what the core states.

test('EINSPEISE-WACHE: a falling cap is written on the tick it arrives, not one refresh later', async () => {
  const img = unitImage(27);
  const disc = discOver(img);
  const gw = await startGateway({ 1: img });
  try {
    const key = '127.0.0.1:' + gw.port + '#1';
    const flow = { ['curtail_disc:' + key]: { at: Date.now(), disc: disc } };
    const ctx = {};

    // Roomy: a charging car leaves headroom, so the watchdog's cap is above the
    // unit's own rating and nothing is held back.
    await curtailRun(gw, img, { flow, ctx, over: { pv_limit_kw: 27 } });
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), 10000, '100 % - not held back');

    // The car is unplugged: the core's next setpoint carries a much lower cap.
    // The command SIGNATURE changed, so this tick writes - no refresh wait.
    ctx.curtail_busy_since = 0;
    const r = await curtailRun(gw, img, { flow, ctx, over: { pv_limit_kw: 11.7 } });
    assert.strictEqual(r.sends[0].applied, true, 'the tighter cap was WRITTEN, not just observed');
    assert.strictEqual(r.sends[0].all_match, true);
    // 11,7 / 27 = 43,33 % -> 4333 at SF -2.
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), 4333);
  } finally { gw.close(); }
});

test('EINSPEISE-WACHE: the plant cap splits across the units minus the share we cannot control', async () => {
  const img1 = unitImage(27);
  const img2 = unitImage(27);
  const gw = await startGateway({ 1: img1, 2: img2 });
  try {
    const d1 = discOver(img1);
    const d2 = discOver(img2);
    const flow = {
      ['curtail_disc:127.0.0.1:' + gw.port + '#1']: { at: Date.now(), disc: d1 },
      ['curtail_disc:127.0.0.1:' + gw.port + '#2']: { at: Date.now(), disc: d2 },
    };
    // The Pilsting shape: a 33,4 kW plant cap from the watchdog, of which the
    // uncurtailable Deye already occupies 10 kW -> 23,4 kW for the two Fronius.
    const setpoint = curtailSetpoint(gw.port, ['src-a', 'src-b'], {
      pv_limit_kw: 33.4,
      curtail: {
        control_enabled: true,
        pv_uncontrolled_kw: 10,
        sources: [
          { id: 'src-a', certified: true, capacity_kwp: 27, label: 'WR1' },
          { id: 'src-b', certified: true, capacity_kwp: 27, label: 'WR2' },
        ],
      },
    });
    const { sends } = await runExec({
      sources: [froniusSource('src-a', gw.port, 1), froniusSource('src-b', gw.port, 2)],
      setpoint, flow, ctx: {}, flowLog: [],
    });
    const caps = sends.map((p) => p.cap_kw).sort();
    assert.deepStrictEqual(caps, [11.7, 11.7], 'the 23,4 kW budget split evenly: ' + JSON.stringify(sends));
    // And the SUM of what the plant may now produce holds the plant cap.
    assert.ok(caps[0] + caps[1] + 10 <= 33.4 + 1e-9, 'split + uncontrolled must stay inside the plant cap');
    assert.strictEqual(img1.get(d1.controls.wMaxLimPctAddr), 4333);
    assert.strictEqual(img2.get(d2.controls.wMaxLimPctAddr), 4333);
  } finally { gw.close(); }
});

test('EINSPEISE-WACHE: an unreleased unit is NOT written - the watchdog is provably ineffective there', async () => {
  const img = unitImage(27);
  const disc = discOver(img);
  const gw = await startGateway({ 1: img });
  try {
    const key = '127.0.0.1:' + gw.port + '#1';
    const flow = { ['curtail_disc:' + key]: { at: Date.now(), disc: disc } };
    const before = img.get(disc.controls.wMaxLimPctAddr);
    const { sends } = await runExec({
      sources: [froniusSource('src-a', gw.port, 1)],
      setpoint: curtailSetpoint(gw.port, ['src-a'], {
        pv_limit_kw: 11.7,
        curtail: {
          control_enabled: true,
          pv_uncontrolled_kw: 0,
          sources: [{ id: 'src-a', certified: false, capacity_kwp: 27, label: 'WR1' }],
        },
      }),
      flow, ctx: {}, flowLog: [],
    });
    assert.strictEqual(sends[0].applied, false, 'nothing may be written to an unreleased unit');
    assert.strictEqual(img.get(disc.controls.wMaxLimPctAddr), before, 'the register is untouched');
    assert.match(sends[0].reason, /noch nicht freigegeben/,
      'and the refusal names its cause: ' + JSON.stringify(sends[0]));
  } finally { gw.close(); }
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
