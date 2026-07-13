'use strict';

/**
 * sources-read.e2e.test.js - drives the ACTUAL "Energiequellen (automatisch)"
 * flow node bodies from flows.json (sources-store + sources-read) against real
 * in-process Modbus-TCP servers. This is the regression proof for the captain's
 * real symptom: a Fronius added as an Erzeuger SOURCE (communication
 * fronius_sunspec, read over SunSpec-live) stayed "Wartet auf erste Daten"
 * forever because the per-source executor only knew the fixed-block modbus_tcp
 * profile - while "Verbindung testen" (its own full SunSpec read) worked. The
 * fixed flow must discover + decode the SunSpec inverter on the ONGOING poll and
 * publish {source_id, payload:{pv_power_kw}} for vp-quelle. No Docker, no
 * hardware.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const sunspec = require('./sunspec/sunspec-live');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// Build a SunSpec float image (Map addr->word): SID + Common(1) + inverter(113)
// (+ optionally a meter(213) with total power W) - the shape a Fronius Eco
// presents on Modbus TCP 502.
function sunspecImage(base, opts) {
  const { wWatts, meterWatts = null, st = 4, extraModels = 0 } = opts;
  const img = new Map();
  img.set(base, (0x53756e53 >>> 16) & 0xffff); // "SunS"
  img.set(base + 1, 0x53756e53 & 0xffff);
  let addr = base + 2;
  const model = (id, body) => {
    img.set(addr, id & 0xffff); img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); return [b.readUInt16BE(0), b.readUInt16BE(2)]; };
  model(1, new Array(66).fill(0)); // Common
  // A REAL Fronius presents more than Common+inverter: nameplate/settings/
  // status/controls models sit between them, each costing the walk an extra
  // header + body read. extraModels mimics that longer linked list.
  for (let m = 0; m < extraModels; m++) model(120 + m, new Array(30).fill(0));
  const inv = new Array(60).fill(0);
  [inv[sunspec.INV_FLOAT.W], inv[sunspec.INV_FLOAT.W + 1]] = f32(wWatts);
  [inv[sunspec.INV_FLOAT.Hz], inv[sunspec.INV_FLOAT.Hz + 1]] = f32(49.99);
  inv[sunspec.INV_FLOAT.St] = st & 0xffff;
  model(113, inv);
  if (meterWatts !== null) {
    const met = new Array(124).fill(0);
    [met[sunspec.MET_FLOAT.W], met[sunspec.MET_FLOAT.W + 1]] = f32(meterWatts);
    model(213, met);
  }
  img.set(addr, 0xffff); img.set(addr + 1, 0);
  return img;
}

// A compact-sim image for the modbus_tcp `sunspec` PROFILE (FC3 addr 0..8,
// s16 x100): the fixed 9-register block edge/sim serves.
function simImage(pvKw, gridKw) {
  const img = new Map();
  const s16w = (kw) => Math.round(kw * 100) & 0xffff;
  for (let i = 0; i < 9; i++) img.set(i, 0);
  img.set(0, s16w(gridKw));
  img.set(1, s16w(pvKw));
  return img;
}

// A Modbus-TCP server over a register image; Modbus exception past the image end.
function startModbusServer(img) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 12) {
          const req = acc.slice(0, 12); acc = acc.slice(12);
          const txid = req.readUInt16BE(0);
          const addr = req.readUInt16BE(8);
          const count = req.readUInt16BE(10);
          let ok = true;
          for (let i = 0; i < count; i++) if (!img.has(addr + i)) { ok = false; break; }
          if (!ok) {
            const ex = Buffer.alloc(9);
            ex.writeUInt16BE(txid, 0); ex.writeUInt16BE(3, 4); ex[6] = req[6]; ex[7] = 0x83; ex[8] = 0x02;
            sock.write(ex); continue;
          }
          const bc = count * 2;
          const resp = Buffer.alloc(9 + bc);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4); resp[6] = req[6]; resp[7] = 0x03; resp[8] = bc;
          for (let i = 0; i < count; i++) resp.writeUInt16BE((img.get(addr + i) || 0) & 0xffff, 9 + i * 2);
          sock.write(resp);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Run a function-node body with a Node-RED-like context: shared flow store,
// node.send + node.warn capture, real node:net (awaits a Promise result).
// `ctx` may be shared across invocations - a real function node keeps ONE
// context store across poll ticks, which is what the overlap guard relies on.
async function runFunctionNode(func, { msg = {}, flow = {}, sends = [], warns = [], ctx = {} } = {}) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn(w) { warns.push(String(w)); }, send(m) { sends.push(JSON.parse(JSON.stringify(m))); } },
    context: { get: (k) => ctx[k], set: (k, v) => { ctx[k] = v; } },
    flow: { get: (k) => flow[k], set: (k, v) => { flow[k] = v; } },
    global: { get: (k) => (k === 'net' ? net : undefined) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

// A REALISTIC Fronius-shaped Modbus server: per-request latency (a real Eco's
// walk is many sequential FC3 round trips over the LAN, so a full discovery
// takes seconds) and SINGLE-SESSION semantics - a second TCP connection
// displaces the running one (embedded Modbus gateways handle concurrent
// clients this way; the displaced walk dies mid-flight). This is what the
// plain fast server of the older tests could never reproduce: overlapping
// 5-s polls each stacking a fresh connection onto a walk that outlives the
// interval, so NO walk ever completes while the poll keeps running.
function startSlowSingleSessionServer(img, { latencyMs }) {
  return new Promise((resolve) => {
    let active = null;
    let concurrent = 0;
    let maxConcurrent = 0;
    const server = net.createServer((sock) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (active) {
        // kill-oldest: the new connection displaces the in-flight one (RST so
        // the displaced client fails fast instead of waiting for its timeout)
        const old = active;
        if (typeof old.resetAndDestroy === 'function') old.resetAndDestroy(); else old.destroy();
      }
      active = sock;
      sock.on('close', () => { concurrent--; if (active === sock) active = null; });
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 12) {
          const req = acc.slice(0, 12); acc = acc.slice(12);
          const txid = req.readUInt16BE(0);
          const addr = req.readUInt16BE(8);
          const count = req.readUInt16BE(10);
          setTimeout(() => {
            if (sock.destroyed) return;
            let ok = true;
            for (let i = 0; i < count; i++) if (!img.has(addr + i)) { ok = false; break; }
            if (!ok) {
              const ex = Buffer.alloc(9);
              ex.writeUInt16BE(txid, 0); ex.writeUInt16BE(3, 4); ex[6] = req[6]; ex[7] = 0x83; ex[8] = 0x02;
              sock.write(ex); return;
            }
            const bc = count * 2;
            const resp = Buffer.alloc(9 + bc);
            resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4); resp[6] = req[6]; resp[7] = 0x03; resp[8] = bc;
            for (let i = 0; i < count; i++) resp.writeUInt16BE((img.get(addr + i) || 0) & 0xffff, 9 + i * 2);
            sock.write(resp);
          }, latencyMs);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, maxConcurrent: () => maxConcurrent }));
  });
}

// Run the ACTUAL store node over a retained source list, then the ACTUAL read
// node over the resulting plans; return the captured sends.
async function storeAndRead(sourceList) {
  const flow = {};
  const sends = [];
  const warns = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: sourceList }, flow, sends, warns });
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns });
  return { flow, sends, warns };
}

// The captain's real source shape (core busEntry for a fronius_sunspec source).
function froniusSource(port, overrides = {}) {
  return Object.assign({
    id: 'src-eco',
    role: 'pv-generation',
    brand: 'fronius_sunspec',
    model: 'fronius-eco-27-3-s',
    family: 'sunspec_live',
    communication: 'fronius_sunspec',
    connection: { ip: '127.0.0.1', port, unit_id: 1, model_type: 'auto', invert_grid_sign: false },
    interval_s: 5,
    capacity_kwp: 70,
  }, overrides);
}

test('a Fronius Erzeuger source (fronius_sunspec) is discovered + decoded + published on the ongoing poll', async () => {
  const { server, port } = await startModbusServer(sunspecImage(40000, { wWatts: 26500 }));
  try {
    const { flow, sends } = await storeAndRead([froniusSource(port)]);
    assert.equal(flow.source_plans.length, 1, 'the source is planned (the dropped-plan regression)');
    assert.equal(sends.length, 1, 'exactly one publish for the one source');
    const [erzeuger, netz] = sends[0];
    assert.equal(netz, null, 'nothing on the Netz output for an Erzeuger');
    assert.equal(erzeuger.source_id, 'src-eco');
    assert.equal(erzeuger.payload.pv_power_kw, 26.5);
    assert.ok(typeof erzeuger.payload.ts === 'string', 'reading is stamped');
    assert.equal('power_kw' in erzeuger.payload, false, 'Erzeuger publishes ONLY pv (no fabricated grid)');
  } finally {
    server.close();
  }
});

test('a Netz-Zaehler fronius_sunspec source (SunSpec meter model) publishes signed power_kw on output 2', async () => {
  // Image carries an inverter AND a meter model; the Netz role must pick the
  // meter's signed grid power, never the inverter's PV.
  const { server, port } = await startModbusServer(sunspecImage(40000, { wWatts: 26500, meterWatts: -5000 }));
  try {
    const { sends } = await storeAndRead([froniusSource(port, { id: 'src-netz', role: 'grid-meter' })]);
    assert.equal(sends.length, 1);
    const [erzeuger, netz] = sends[0];
    assert.equal(erzeuger, null, 'nothing on the Erzeuger output for a Netz source');
    assert.equal(netz.source_id, 'src-netz');
    assert.equal(netz.payload.power_kw, -5, 'signed grid power (- Einspeisung)');
    assert.equal('pv_power_kw' in netz.payload, false);
  } finally {
    server.close();
  }
});

// The REAL-DEVICE regression (captain's Fronius Eco, 2026-07-13): the source is
// configured correctly and "Verbindung testen" (test-read.js, a one-shot read)
// returns a value, but the ongoing 5-s poll delivers NOTHING - status pending
// forever. Reproduced here faithfully: a slow single-session SunSpec server
// (multi-model walk + per-read latency -> a full walk outlives the poll
// interval; a second connection displaces the first). The PRE-FIX flow stacked
// a fresh connection every tick, each displacing the in-flight walk, so no
// read ever completed while polling continued (verified red against the
// pre-fix flows.json). The fixed flow must (a) skip ticks while a read is in
// flight - never a second concurrent connection to the device - and (b) keep
// publishing pv_power_kw on the ONGOING poll.
test('overlapping polls on a slow single-session Fronius are skipped, reads stay serialized and keep delivering', async () => {
  // walk = SID + (Common,120..124,113) headers+bodies + end header at 80 ms per
  // request -> ~1.3 s per read; poll cadence 400 ms -> without the guard every
  // tick would displace the running walk.
  const img = sunspecImage(40000, { wWatts: 26500, extraModels: 5 });
  const srv = await startSlowSingleSessionServer(img, { latencyMs: 80 });
  try {
    const flow = {};
    const sends = [];
    const warns = [];
    const ctx = {}; // ONE shared node context across ticks, like the real node
    await runFunctionNode(byId['sources-store'].func, { msg: { payload: [froniusSource(srv.port, { interval_s: 5 })] }, flow, sends, warns });
    const ticks = [];
    for (let i = 0; i < 10; i++) {
      ticks.push(runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns, ctx }));
      await new Promise((res) => setTimeout(res, 400));
    }
    await Promise.all(ticks);
    assert.ok(
      sends.length >= 2,
      'ongoing publishes while polling continues, got ' + sends.length + ' (the real-device symptom: every walk displaced, source pending forever)',
    );
    for (const s of sends) {
      assert.equal(s[0].source_id, 'src-eco');
      assert.equal(s[0].payload.pv_power_kw, 26.5);
    }
    assert.equal(srv.maxConcurrent(), 1, 'never more than ONE concurrent connection to the device (serialized polls)');
  } finally {
    srv.server.close();
  }
});

test('a dead Fronius source is skipped (no send) while a live modbus source keeps delivering', async () => {
  // Reserve a port with no listener for the dead SunSpec source.
  const dead = await startModbusServer(new Map());
  const deadPort = dead.port;
  await new Promise((res) => dead.server.close(res));
  const sim = await startModbusServer(simImage(42, -5));
  try {
    const { flow, sends, warns } = await storeAndRead([
      froniusSource(deadPort),
      { id: 'src-sim', role: 'pv-generation', brand: 'generic_modbus', model: 'sunspec', family: 'sunspec',
        communication: 'modbus_tcp', connection: { ip: '127.0.0.1', port: sim.port, unit_id: 1, profile: 'sunspec' } },
    ]);
    assert.equal(flow.source_plans.length, 2, 'both sources planned');
    assert.equal(sends.length, 1, 'the dead source publishes NOTHING (error-isolated, never a fabricated 0)');
    assert.equal(sends[0][0].source_id, 'src-sim');
    assert.equal(sends[0][0].payload.pv_power_kw, 42);
    // The failure is NEVER silent: the dead source is named in a node.warn so
    // the log says WHY a source stays pending (the silent .catch(() => null)
    // that hid the real-device bug is gone).
    assert.ok(warns.some((w) => w.includes('src-eco')), 'the failing source is named in a warn, got: ' + JSON.stringify(warns));
  } finally {
    sim.server.close();
  }
});

test('a mixed source list plans Fronius + modbus and defers a Deye solarman source', async () => {
  const { server, port } = await startModbusServer(sunspecImage(40000, { wWatts: 8000 }));
  try {
    const { flow, sends } = await storeAndRead([
      froniusSource(port),
      { id: 'src-deye', role: 'pv-generation', brand: 'deye', family: 'hybrid_3p',
        communication: 'solarman_v5', connection: { ip: '127.0.0.1', port: 8899, serial: '2985159064', mb_slave_id: 1 } },
    ]);
    assert.equal(flow.source_plans.length, 1, 'solarman executor stays deferred');
    assert.equal(sends.length, 1);
    assert.equal(sends[0][0].source_id, 'src-eco');
    assert.equal(sends[0][0].payload.pv_power_kw, 8);
  } finally {
    server.close();
  }
});
