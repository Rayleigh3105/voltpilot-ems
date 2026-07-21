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
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const sunspec = require('./sunspec/sunspec-live');
const solarman = require('./deye/solarman-v5');
const deyeDecode = require('./deye/deye-decode');
// The REAL palette node the flow's config path runs through (its parse() is the
// exact message handler the retained edge/sources/config payload hits first).
const vpSourcesConfig = require('./vp-palette/nodes/vp-sources-config.js');

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
  // header + body read. extraModels mimics that longer linked list. Model 124
  // (Storage) is deliberately NOT among the padding ids: its presence MEANS the
  // device is a hybrid, and the decode then reads DC power instead of AC W
  // (sunspec-live.js decodeInverter) - padding must not fake a battery.
  const PAD = [120, 121, 122, 123, 126, 129, 130, 131];
  for (let m = 0; m < extraModels; m++) model(PAD[m % PAD.length], new Array(30).fill(0));
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

// A Modbus-TCP server over a register image; Modbus exception past the image
// end. `img` is one Map (every unit id answers it) or a per-unit-id object
// {1: MapA, 2: MapB} - a Fronius Datamanager exposing several inverters on one
// IP, one Modbus unit id per inverter; an unknown unit id answers exception
// 0x0B (gateway target device failed to respond).
function startModbusServer(img) {
  const imgFor = (unit) => (img instanceof Map ? img : img[unit]);
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
          const unitImg = imgFor(req[6]);
          const ex = (code) => {
            const e = Buffer.alloc(9);
            e.writeUInt16BE(txid, 0); e.writeUInt16BE(3, 4); e[6] = req[6]; e[7] = 0x83; e[8] = code;
            sock.write(e);
          };
          if (!unitImg) { ex(0x0b); continue; }
          let ok = true;
          for (let i = 0; i < count; i++) if (!unitImg.has(addr + i)) { ok = false; break; }
          if (!ok) { ex(0x02); continue; }
          const bc = count * 2;
          const resp = Buffer.alloc(9 + bc);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4); resp[6] = req[6]; resp[7] = 0x03; resp[8] = bc;
          for (let i = 0; i < count; i++) resp.writeUInt16BE((unitImg.get(addr + i) || 0) & 0xffff, 9 + i * 2);
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
async function runFunctionNode(func, { msg = {}, flow = {}, sends = [], warns = [], logs = [], ctx = {}, netStub = null, fakeTimers = null } = {}) {
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn(w) { warns.push(String(w)); }, log(l) { logs.push(String(l)); }, send(m) { sends.push(JSON.parse(JSON.stringify(m))); } },
    context: { get: (k) => ctx[k], set: (k, v) => { ctx[k] = v; } },
    flow: { get: (k) => flow[k], set: (k, v) => { flow[k] = v; } },
    global: { get: (k) => (k === 'net' ? (netStub || net) : (k === 'http' ? http : (k === 'https' ? https : undefined))) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map,
    setTimeout: fakeTimers ? fakeTimers.setTimeout : setTimeout,
    clearTimeout: fakeTimers ? fakeTimers.clearTimeout : clearTimeout,
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
  const imgFor = (unit) => (img instanceof Map ? img : img[unit]);
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
            const unitImg = imgFor(req[6]);
            const ex = (code) => {
              const e = Buffer.alloc(9);
              e.writeUInt16BE(txid, 0); e.writeUInt16BE(3, 4); e[6] = req[6]; e[7] = 0x83; e[8] = code;
              sock.write(e);
            };
            if (!unitImg) { ex(0x0b); return; }
            let ok = true;
            for (let i = 0; i < count; i++) if (!unitImg.has(addr + i)) { ok = false; break; }
            if (!ok) { ex(0x02); return; }
            const bc = count * 2;
            const resp = Buffer.alloc(9 + bc);
            resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4); resp[6] = req[6]; resp[7] = 0x03; resp[8] = bc;
            for (let i = 0; i < count; i++) resp.writeUInt16BE((unitImg.get(addr + i) || 0) & 0xffff, 9 + i * 2);
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
  const logs = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: sourceList }, flow, sends, warns, logs });
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns, logs });
  return { flow, sends, warns, logs };
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

// MULTI-INVERTER AT ONE DATAMANAGER (the captain's site "Asbeck Büro Isaraue"):
// TWO Fronius Eco 27.0-3-S behind ONE Datamanager IP (192.168.210.40), exposed
// as Modbus unit ids 1 ("(1) ost") and 2 ("(2) west"). Two fronius_sunspec
// sources with the same IP and different unit_ids must BOTH be read through the
// sequential per-source loop - each publishing its own value on its own topic -
// and NEVER overlap each other on the slow single-session device (a second
// concurrent connection would displace the running walk, see the 2026-07-13
// device-down). The live figures are the fixture: ost 22.11 kW, west 26.14 kW.
test('two fronius_sunspec sources at ONE Datamanager IP (unit ids 1+2) are both read, serialized', async () => {
  const srv = await startSlowSingleSessionServer({
    1: sunspecImage(40000, { wWatts: 22110, extraModels: 2 }),
    2: sunspecImage(40000, { wWatts: 26140, extraModels: 2 }),
  }, { latencyMs: 25 });
  try {
    const { flow, sends } = await storeAndRead([
      froniusSource(srv.port, { id: 'src-ost', connection: { ip: '127.0.0.1', port: srv.port, unit_id: 1, model_type: 'auto', invert_grid_sign: false } }),
      froniusSource(srv.port, { id: 'src-west', connection: { ip: '127.0.0.1', port: srv.port, unit_id: 2, model_type: 'auto', invert_grid_sign: false } }),
    ]);
    assert.equal(flow.source_plans.length, 2, 'both same-IP sources planned');
    assert.equal(sends.length, 2, 'each source publishes its own reading');
    assert.equal(sends[0][0].source_id, 'src-ost');
    assert.equal(sends[0][0].payload.pv_power_kw, 22.11);
    assert.equal(sends[1][0].source_id, 'src-west');
    assert.equal(sends[1][0].payload.pv_power_kw, 26.14);
    assert.equal(srv.maxConcurrent(), 1, 'never more than ONE concurrent connection to the Datamanager');
  } finally {
    srv.server.close();
  }
});

test('a wrong unit id on a Datamanager fails loudly while the right one keeps delivering', async () => {
  // Only unit 1 exists; the second source asks unit 5 -> Modbus exception 0x0B
  // per request, the walk finds no SunSpec device, the source is warned - and
  // the healthy unit is unaffected.
  const { server, port } = await startModbusServer({ 1: sunspecImage(40000, { wWatts: 22110 }) });
  try {
    const { sends, warns } = await storeAndRead([
      froniusSource(port, { id: 'src-ok', connection: { ip: '127.0.0.1', port, unit_id: 1, model_type: 'auto', invert_grid_sign: false } }),
      froniusSource(port, { id: 'src-wrong', connection: { ip: '127.0.0.1', port, unit_id: 5, model_type: 'auto', invert_grid_sign: false } }),
    ]);
    assert.equal(sends.length, 1, 'only the correct unit publishes');
    assert.equal(sends[0][0].source_id, 'src-ok');
    assert.equal(sends[0][0].payload.pv_power_kw, 22.11);
    assert.ok(warns.some((w) => w.includes('src-wrong')), 'the wrong-unit source is named in a warn: ' + JSON.stringify(warns));
  } finally {
    server.close();
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

// THE FAITHFUL REPRO of the real device (captain's Fronius Eco, second round
// 2026-07-13): the ongoing poll delivered NEITHER data NOR a warn although the
// source was configured correctly and "Verbindung testen" worked. Root cause:
// vp-sources-config's parse() carried a STALE communication whitelist
// (solarman_v5 + modbus_tcp only) and silently dropped the fronius_sunspec
// source BEFORE the flow ever saw it -> the store planned nothing -> the read
// node idled with "keine Quellen" (no read, no warn). The earlier e2e tests
// here fed msg.payload straight into the store node, BYPASSING that parse -
// which is exactly why they stayed green over the bug. This test starts from
// the retained edge/sources/config BYTES the core actually publishes
// (sources.go BusConfig()/busEntry() for a fronius_sunspec source - field set
// verified against the Go source) and runs them through the REAL palette
// parse() + the REAL store + read nodes.
function retainedBusConfigBytes(port) {
  return Buffer.from(JSON.stringify({
    schema_version: '1.0',
    sources: [{
      id: 'src-eco',
      role: 'pv-generation',
      brand: 'fronius_sunspec',
      model: 'fronius-eco-27-3-s',
      family: 'sunspec_live',
      communication: 'fronius_sunspec',
      connection: { ip: '127.0.0.1', port, unit_id: 1, model_type: 'auto', invert_grid_sign: false },
      interval_s: 5,
      capacity_kwp: 70,
    }],
  }));
}

test('REGRESSION: the retained core config (busEntry bytes) passes vp-sources-config and the whole chain publishes', async () => {
  const { server, port } = await startModbusServer(sunspecImage(40000, { wWatts: 26500 }));
  try {
    const list = vpSourcesConfig.parse(retainedBusConfigBytes(port));
    assert.ok(Array.isArray(list), 'the retained payload is structurally valid, never null');
    assert.equal(
      list.length, 1,
      'vp-sources-config must NOT drop a fronius_sunspec source (the stale-whitelist bug that made the real device deliver neither data nor a warn)',
    );
    const { flow, sends } = await storeAndRead(list);
    assert.equal(flow.source_plans.length, 1, 'the parsed source is planned');
    assert.equal(sends.length, 1, 'the poll publishes the reading');
    assert.equal(sends[0][0].source_id, 'src-eco');
    assert.equal(sends[0][0].payload.pv_power_kw, 26.5);
  } finally {
    server.close();
  }
});

test('TRACE: one poll cycle logs config receipt, routing, read start, result and publish', async () => {
  const { server, port } = await startModbusServer(sunspecImage(40000, { wWatts: 26500 }));
  try {
    const list = vpSourcesConfig.parse(retainedBusConfigBytes(port));
    const { logs } = await storeAndRead(list);
    const all = logs.join('\n');
    assert.ok(all.includes('Quellen-Konfiguration: 1 Eintrag/Eintraege -> 1 Leseplan/-plaene'), 'store logs the plan count, got: ' + all);
    assert.ok(all.includes('Quelle src-eco (pv-generation): fronius_sunspec 127.0.0.1:' + port + ' -> Leseplan sunspec_live'), 'store names the routed adapter per source');
    assert.ok(all.includes('Lese Quelle src-eco (sunspec_live 127.0.0.1:' + port + ')'), 'read start is logged');
    assert.ok(all.includes('Quelle src-eco: pv_power_kw=26.5 -> veroeffentlicht auf edge/sources/src-eco/telemetry'), 'result + publish are logged');
    assert.ok(all.includes('Quellen-Zyklus: 1 gelesen, 0 fehlgeschlagen'), 'cycle summary is logged');
  } finally {
    server.close();
  }
});

test('TRACE: an unroutable communication is loudly NOT-ROUTED instead of silently invisible', async () => {
  const warns = [];
  const logs = [];
  const flow = {};
  await runFunctionNode(byId['sources-store'].func, {
    msg: { payload: [{ id: 'src-x', role: 'pv-generation', brand: 'x', family: 'y',
      communication: 'zigbee_wtf', connection: { ip: '10.0.0.9' } }] },
    flow, warns, logs,
  });
  assert.equal((flow.source_plans || []).length, 0);
  assert.ok(
    warns.some((w) => w.includes('src-x') && w.includes('NICHT VERDRAHTET') && w.includes('zigbee_wtf')),
    'the unwired source is named in a warn, got: ' + JSON.stringify(warns),
  );
  // The read node then says WHY nothing is read (rate-limited, but the first
  // tick always logs).
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, warns, logs });
  assert.ok(
    logs.some((l) => l.includes('keine Leseplaene')),
    'an empty plan list is a logged decision, not silence: ' + JSON.stringify(logs),
  );
});

test('TRACE: a tick skipped by the overlap guard logs the skip (rate-limited)', async () => {
  const flow = { source_plans: [{ id: 'src-eco', role: 'pv-generation', adapter: 'sunspec_live', conn: { ip: '127.0.0.1', port: 1 } }] };
  const logs = [];
  const ctx = { src_busy_since: Date.now() - 7000 };
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, logs, ctx });
  assert.ok(
    logs.some((l) => l.includes('Tick uebersprungen') && l.includes('7 s')),
    'the busy skip is logged with its age, got: ' + JSON.stringify(logs),
  );
});

test('a read that outlives its own timeouts ends as a LOGGED Gesamt-Timeout - busy is always cleared, never a permanent silent skip', async () => {
  // The pathological hang the overall Promise.race cap exists for: a socket
  // that never connects, never errors, and whose reader-internal 8 s timers
  // never fire (a hang no inner timeout catches). Fake timers suppress every
  // timer below the 30 s overall cap and fire the cap itself after 30 ms real
  // time - so ONLY the overall race can end the read, deterministically.
  const hangSocket = { setNoDelay() {}, once() {}, on() {}, connect() {}, destroy() {}, write() {}, end() {} };
  const netStub = { Socket: function () { return hangSocket; } };
  const pendingFakes = [];
  const fakeTimers = {
    setTimeout: (fn, ms) => {
      if (ms >= 30000) { const h = setTimeout(fn, 30); pendingFakes.push(h); return h; }
      return { __suppressed: true };
    },
    clearTimeout: (h) => { if (h && h.__suppressed) return; clearTimeout(h); },
  };
  const flow = { source_plans: [{ id: 'src-hang', role: 'pv-generation', adapter: 'sunspec_live', conn: { ip: '203.0.113.1', port: 502, unit_id: 1, model_type: 'auto' } }] };
  const warns = [];
  const logs = [];
  const ctx = {};
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, warns, logs, ctx, netStub, fakeTimers });
  assert.equal(ctx.src_busy_since, 0, 'src_busy_since is ALWAYS cleared - a hang can never cause a permanent silent skip');
  assert.ok(
    warns.some((w) => w.includes('src-hang') && w.includes('Gesamt-Timeout')),
    'the hang ends as a named Gesamt-Timeout warn, got: ' + JSON.stringify(warns),
  );
  assert.ok(
    logs.some((l) => l.includes('Quellen-Zyklus: 0 gelesen, 1 fehlgeschlagen')),
    'the cycle outcome is logged, got: ' + JSON.stringify(logs),
  );
});

test('a mixed source list plans Fronius SunSpec + modbus + a Deye solarman source (all wired)', async () => {
  const { server, port } = await startModbusServer(sunspecImage(40000, { wWatts: 8000 }));
  const deadDeye = await startModbusServer(new Map());
  const deadDeyePort = deadDeye.port;
  await new Promise((res) => deadDeye.server.close(res));
  try {
    const { flow, sends } = await storeAndRead([
      froniusSource(port),
      { id: 'src-deye', role: 'pv-generation', brand: 'deye', family: 'hybrid_3p',
        communication: 'solarman_v5', connection: { ip: '127.0.0.1', port: deadDeyePort, serial: '2985159064', mb_slave_id: 1 } },
    ]);
    // The Deye source IS planned now (executor wired); it simply fails to read
    // here (no logger listening) and is error-isolated, so only the Fronius
    // publishes.
    assert.equal(flow.source_plans.length, 2, 'both sources are planned - solarman is no longer deferred');
    assert.ok(flow.source_plans.some((p) => p.id === 'src-deye' && p.adapter === 'solarman_v5'));
    assert.equal(sends.length, 1);
    assert.equal(sends[0][0].source_id, 'src-eco');
    assert.equal(sends[0][0].payload.pv_power_kw, 8);
  } finally {
    server.close();
  }
});

// A go-e wallbox added as a CONSUMER source (communication goe_http_api) is read
// over its local HTTP /api/status on the ongoing poll and published as
// {source_id, payload:{load_kw}} on the THIRD output (vp-verbraucher). This
// drives the ACTUAL flow node bodies from flows.json against a real in-process
// HTTP server - the acceptance proof that a go-e source publishes load_kw on
// edge/sources/<id>/telemetry. No hardware.
function goeSource(port, overrides = {}) {
  return Object.assign({
    id: 'src-goe',
    role: 'consumer',
    brand: 'go-e',
    model: 'goe_http_api',
    family: 'goe_http_api',
    communication: 'goe_http_api',
    connection: { ip: '127.0.0.1', port },
    interval_s: 5,
  }, overrides);
}

test('a go-e consumer source (goe_http_api) is read over HTTP and publishes load_kw on output 3', async () => {
  const body = JSON.stringify({
    car: 2, alw: true, amp: 16,
    nrg: [232, 231, 232, 0, 16, 16, 16, 3680, 3700, 3660, 0, 11040, 99, 99, 99, 0],
  });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const { flow, sends } = await storeAndRead([goeSource(port)]);
    assert.equal(flow.source_plans.length, 1, 'the go-e consumer source is planned');
    assert.equal(flow.source_plans[0].adapter, 'goe_http_api');
    assert.equal(sends.length, 1, 'exactly one publish for the one source');
    const [erzeuger, netz, verbraucher] = sends[0];
    assert.equal(erzeuger, null, 'nothing on the Erzeuger output');
    assert.equal(netz, null, 'nothing on the Netz output');
    assert.ok(verbraucher, 'the Consumer (output 3) carries the reading');
    assert.equal(verbraucher.source_id, 'src-goe');
    assert.equal(verbraucher.payload.load_kw, 11.04, '11040 W -> 11.04 kW');
    assert.ok(typeof verbraucher.payload.ts === 'string', 'reading is stamped');
    assert.equal('pv_power_kw' in verbraucher.payload, false, 'a consumer publishes ONLY load');
    assert.equal('power_kw' in verbraucher.payload, false);
  } finally {
    server.close();
  }
});

test('a not-charging go-e consumer publishes a real load_kw 0 (kept, not dropped)', async () => {
  const body = JSON.stringify({ car: 4, nrg: new Array(16).fill(0) });
  const server = http.createServer((req, res) => res.end(body));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const { sends } = await storeAndRead([goeSource(port)]);
    assert.equal(sends.length, 1);
    assert.equal(sends[0][2].payload.load_kw, 0, 'a real 0 (idle) is a valid consumer reading');
  } finally {
    server.close();
  }
});

test('a dead go-e consumer source is skipped (no send) and named via node.warn', async () => {
  // Port 1 on loopback refuses immediately -> the read fails, nothing published,
  // and the failure is NOT swallowed silently (rate-limited node.warn).
  const flow = {};
  const sends = [];
  const warns = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: [goeSource(1)] }, flow });
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns });
  assert.equal(sends.length, 0, 'a dead source publishes nothing (error isolation)');
  assert.ok(warns.some((w) => /src-goe/.test(w)), 'the failed read is named, never silent');
});

// A Deye added as a SOURCE (communication solarman_v5) is read over its
// Solarman-V5 logger (TCP 8899) on the ongoing poll and published on
// edge/sources/<id>/telemetry. This drives the ACTUAL flow node bodies from
// flows.json against a real in-process Solarman-V5 server. The per-source
// Solarman executor was the deferred gap this closes (parity with the
// fronius_sunspec "planned-but-not-read" fix, 2026-07-13). No hardware.

// An in-process Solarman-V5 logger: answers V5-framed Modbus fn-0x03 reads over
// a register image (Map addr->word), using the repo codec so the framing is
// byte-faithful. Reuses solarman-v5.js for the CRC/checksum + frame length.
function startSolarmanServer(img) {
  const modbusResp = (slave, startReg, count) => {
    const bc = count * 2;
    const body = Buffer.alloc(3 + bc);
    body[0] = slave; body[1] = 0x03; body[2] = bc;
    for (let i = 0; i < count; i++) body.writeUInt16BE((img.get(startReg + i) || 0) & 0xffff, 3 + i * 2);
    const crc = solarman.modbusCrc16(body);
    return Buffer.concat([body, Buffer.from([crc & 0xff, (crc >> 8) & 0xff])]);
  };
  // Wrap a Modbus reply in a V5 RESPONSE frame (control 0x1510, 14-byte preamble
  // -> modbus at offset 25, matching solarman-v5.V5_RESPONSE_MODBUS_OFFSET).
  const wrap = (serial, seq, mb) => {
    const length = 14 + mb.length;
    const h = Buffer.alloc(11);
    h[0] = 0xa5; h.writeUInt16LE(length, 1); h.writeUInt16LE(0x1510, 3);
    h.writeUInt16LE(seq & 0xffff, 5); h.writeUInt32LE(serial >>> 0, 7);
    const pre = Buffer.alloc(14); pre[0] = 0x02;
    const frame = Buffer.concat([h, pre, mb, Buffer.from([0x00, 0x15])]);
    frame[frame.length - 2] = solarman.v5Checksum(frame);
    return frame;
  };
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        for (;;) {
          let need;
          try { need = solarman.expectedFrameLength(acc); } catch (e) { sock.destroy(); return; }
          if (need === null || acc.length < need) return;
          const frame = acc.slice(0, need); acc = acc.slice(need);
          const seq = frame.readUInt16LE(5);
          const serial = frame.readUInt32LE(7);
          // The REQUEST modbus starts after the 11-byte header + 15-byte preamble.
          const mbReq = frame.slice(26, frame.length - 2);
          const slave = mbReq[0];
          const startReg = mbReq.readUInt16BE(2);
          const count = mbReq.readUInt16BE(4);
          sock.write(wrap(serial, seq, modbusResp(slave, startReg, count)));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function deyeSource(port, overrides = {}) {
  return Object.assign({
    id: 'src-deye',
    role: 'pv-generation',
    brand: 'deye',
    model: 'sun-g03',
    family: 'string',
    communication: 'solarman_v5',
    connection: { ip: '127.0.0.1', port, serial: '2985159064', mb_slave_id: 1 },
    interval_s: 5,
  }, overrides);
}

test('a Deye Erzeuger source (solarman_v5) is read over the V5 logger and publishes pv_power_kw', async () => {
  // A `string` Deye reports only its AC output at 0x0050/0x0051 (32-bit
  // low-word-first). Compute the expected reading through the SAME module the
  // flow embeds so the fixture never drifts from the decode.
  const img = new Map();
  img.set(0x0050, 0x3880); // low word
  img.set(0x0051, 0x0001); // high word -> the decode yields the pv output
  const expected = deyeDecode.decode(
    [{ start: 0x0050, regs: [img.get(0x0050), img.get(0x0051)] }],
    { family: 'string' },
  );
  assert.ok(expected.reading.pv_power_kw > 0, 'fixture decodes to a real PV value');
  const { server, port } = await startSolarmanServer(img);
  try {
    const { flow, sends } = await storeAndRead([deyeSource(port)]);
    assert.equal(flow.source_plans.length, 1, 'the Deye source is planned (solarman executor wired)');
    assert.equal(flow.source_plans[0].adapter, 'solarman_v5');
    assert.equal(sends.length, 1, 'exactly one publish for the one source');
    const [erzeuger, netz, verbraucher] = sends[0];
    assert.equal(netz, null, 'nothing on the Netz output for an Erzeuger');
    assert.equal(verbraucher, null, 'nothing on the Consumer output');
    assert.equal(erzeuger.source_id, 'src-deye');
    assert.equal(erzeuger.payload.pv_power_kw, expected.reading.pv_power_kw);
    assert.ok(typeof erzeuger.payload.ts === 'string', 'reading is stamped');
  } finally {
    server.close();
  }
});

test('a dead Deye solarman source is skipped (no send) and named via node.warn', async () => {
  // Reserve a port with no listener for the dead logger.
  const dead = await startSolarmanServer(new Map());
  const deadPort = dead.port;
  await new Promise((res) => dead.server.close(res));
  const flow = {};
  const sends = [];
  const warns = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: [deyeSource(deadPort)] }, flow });
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns });
  assert.equal(sends.length, 0, 'a dead Deye source publishes nothing (error isolation, never a fabricated 0)');
  assert.ok(warns.some((w) => /src-deye/.test(w)), 'the failed read is named, never silent');
});

// A Fronius added as a SOURCE (communication fronius_solar_api) is read over its
// Solar API v1 HTTP endpoint on the ongoing poll and published on
// edge/sources/<id>/telemetry. Drives the ACTUAL flow node bodies against a real
// in-process HTTP server. This closes the "recognised by routing, executor not
// wired" gap (parity with the same fix for the other transports). No hardware.
const FRONIUS_POWERFLOW_PATH = '/solar_api/v1/GetPowerFlowRealtimeData.fcgi';

function froniusApiServer(bodyObj) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith(FRONIUS_POWERFLOW_PATH)) { res.statusCode = 404; res.end('no'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(bodyObj));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function froniusApiSource(port, overrides = {}) {
  return Object.assign({
    id: 'src-fr',
    role: 'pv-generation',
    brand: 'fronius',
    model: 'fronius_solar_api',
    family: 'fronius_solar_api',
    communication: 'fronius_solar_api',
    connection: { ip: '127.0.0.1', port, invert_grid_sign: false },
    interval_s: 5,
  }, overrides);
}

test('a Fronius Erzeuger source (fronius_solar_api) is read over HTTP and publishes pv_power_kw', async () => {
  const { server, port } = await froniusApiServer({
    Head: { Status: { Code: 0 } },
    Body: { Data: { Site: { P_PV: 5300, P_Grid: -1200, P_Load: -900 }, Inverters: { '1': { SOC: 62 } } } },
  });
  try {
    const { flow, sends } = await storeAndRead([froniusApiSource(port)]);
    assert.equal(flow.source_plans.length, 1, 'the Fronius Solar API source is planned');
    assert.equal(flow.source_plans[0].adapter, 'fronius_solar_api');
    assert.equal(sends.length, 1, 'exactly one publish for the one source');
    const [erzeuger, netz, verbraucher] = sends[0];
    assert.equal(netz, null, 'nothing on the Netz output for an Erzeuger');
    assert.equal(verbraucher, null, 'nothing on the Consumer output');
    assert.equal(erzeuger.source_id, 'src-fr');
    assert.equal(erzeuger.payload.pv_power_kw, 5.3, '5300 W -> 5.3 kW');
    assert.equal('power_kw' in erzeuger.payload, false, 'Erzeuger publishes ONLY pv (no fabricated grid)');
  } finally {
    server.close();
  }
});

test('a Fronius Netz source (fronius_solar_api, grid-meter) publishes signed power_kw from P_Grid', async () => {
  const { server, port } = await froniusApiServer({
    Head: { Status: { Code: 0 } },
    Body: { Data: { Site: { P_PV: 0, P_Grid: -3400, P_Load: -900 } } },
  });
  try {
    const { sends } = await storeAndRead([froniusApiSource(port, { id: 'src-fr-netz', role: 'grid-meter' })]);
    assert.equal(sends.length, 1);
    const [erzeuger, netz] = sends[0];
    assert.equal(erzeuger, null, 'nothing on the Erzeuger output for a Netz source');
    assert.equal(netz.source_id, 'src-fr-netz');
    assert.equal(netz.payload.power_kw, -3.4, '-3400 W -> -3.4 kW (Einspeisung)');
    assert.equal('pv_power_kw' in netz.payload, false);
  } finally {
    server.close();
  }
});

test('a dead Fronius Solar API source is skipped (no send) and named via node.warn', async () => {
  // Port 1 on loopback refuses immediately -> the HTTP read fails, nothing
  // published, and the failure is NOT swallowed silently.
  const flow = {};
  const sends = [];
  const warns = [];
  await runFunctionNode(byId['sources-store'].func, { msg: { payload: [froniusApiSource(1)] }, flow });
  await runFunctionNode(byId['sources-read'].func, { msg: {}, flow, sends, warns });
  assert.equal(sends.length, 0, 'a dead source publishes nothing (error isolation)');
  assert.ok(warns.some((w) => /src-fr/.test(w)), 'the failed read is named, never silent');
});
