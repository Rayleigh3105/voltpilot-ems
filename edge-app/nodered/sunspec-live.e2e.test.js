'use strict';

/**
 * sunspec-live.e2e.test.js - drives the ACTUAL "Fronius SunSpec lesen"
 * (auto-sunspec) function-node body from flows.json against a real in-process
 * Modbus-TCP server serving a SunSpec float-113 image. This is the piece the pure
 * decode/reader unit tests can't cover: the flow node's embedded modules + the
 * net socket walk running exactly as Node-RED runs them at runtime. No Docker, no
 * hardware.
 */

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const sharedBus = require('./measurements/shared-bus-arbiter');
const fs = require('node:fs');
const path = require('node:path');

const sunspec = require('./sunspec/sunspec-live');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// Build a SunSpec float-113 image (Map addr->word): SID + Common(1) + inverter(113).
function ecoImage(base, wWatts, st = 4) {
  const img = new Map();
  img.set(base, (0x53756e53 >>> 16) & 0xffff); // "SunS"
  img.set(base + 1, 0x53756e53 & 0xffff);
  let addr = base + 2;
  const model = (id, body) => {
    img.set(addr, id & 0xffff); img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  };
  model(1, new Array(66).fill(0)); // Common
  const inv = new Array(60).fill(0);
  const w = Buffer.alloc(4); w.writeFloatBE(wWatts, 0);
  inv[sunspec.INV_FLOAT.W] = w.readUInt16BE(0);
  inv[sunspec.INV_FLOAT.W + 1] = w.readUInt16BE(2);
  const hz = Buffer.alloc(4); hz.writeFloatBE(49.98, 0);
  inv[sunspec.INV_FLOAT.Hz] = hz.readUInt16BE(0);
  inv[sunspec.INV_FLOAT.Hz + 1] = hz.readUInt16BE(2);
  inv[sunspec.INV_FLOAT.St] = st & 0xffff;
  model(113, inv);
  img.set(addr, 0xffff); img.set(addr + 1, 0);
  return img;
}

// A Modbus-TCP server over a SunSpec image; Modbus exception past the image end.
function startSunspecServer(img) {
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

// Run a function-node body with a Node-RED-like context (awaits a Promise result).
async function runFunctionNode(func, msg) {
  const ctxStore = {};
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get() {}, set() {} },
    global: { get: (k) => (k === 'net' ? net : (k === 'vpSharedBusArbiter' ? sharedBus : undefined)) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

test('auto-sunspec flow node walks a live SunSpec inverter and publishes pv_power_kw', async () => {
  const { server, port } = await startSunspecServer(ecoImage(40000, 26500));
  try {
    const msg = { sunspec: { conn: { ip: '127.0.0.1', port, unit_id: 1, invert_grid_sign: false, model_type: 'auto' } } };
    const out = await runFunctionNode(byId['auto-sunspec'].func, msg);
    assert.ok(Array.isArray(out), 'node published to its two outputs');
    const reading = out[0].payload;
    assert.strictEqual(reading.pv_power_kw, 26.5);
    assert.ok(typeof reading.ts === 'string', 'flow node stamps ts');
    assert.strictEqual('power_kw' in reading, false); // PV-only inverter, no meter
    assert.strictEqual(out[1].payload, true); // link lifebeat
  } finally {
    server.close();
  }
});

test('auto-sunspec flow node finds a device at a non-default base (50000)', async () => {
  const { server, port } = await startSunspecServer(ecoImage(50000, 12000));
  try {
    const msg = { sunspec: { conn: { ip: '127.0.0.1', port, unit_id: 1 } } };
    const out = await runFunctionNode(byId['auto-sunspec'].func, msg);
    assert.strictEqual(out[0].payload.pv_power_kw, 12);
  } finally {
    server.close();
  }
});

test('auto-sunspec flow node returns null (idle-safe) on a connection error', async () => {
  const msg = { sunspec: { conn: { ip: '127.0.0.1', port: 1, unit_id: 1 } } };
  const out = await runFunctionNode(byId['auto-sunspec'].func, msg);
  assert.strictEqual(out, null);
});

// --- KACO blueplanet TL1: the SINGLE-PHASE device that reports model 102 -------
//
// ⚠ DER BELEGTE FALLSTRICK DER GANZEN TL1-REIHE (Scout data/vp-kaco-palette-y6
// §0.6/§2.6): die EINPHASIGEN KACO TL1 melden das SunSpec-Modell **102
// (Split-Phase)**, nicht 101 - KACOs eigene App Note listet fuer die
// Tx1/Tx3-Serie „001, 102, 103". evcc fiel genau daran auf die Nase
// („sunspec model not found: 101/111/103/113", Issue #19222) und musste 102
// nachruesten. Unser Walker kennt 102 seit dem Bau; DIESER Test ist der Beweis,
// dass ein 102-Geraet ueber genau denselben Weg vollstaendig gelesen wird - mit
// echtem Socket, echtem Walk und echter Integer+Skalierungs-Decodierung.
//
// ⚠ UND DIE ZWEITE HAELFTE: `phases: 'split'` beschreibt das MODELL, nie das
// GERAET. Ein TL1 ist ein Einphaser. Wer die Klassifikation je als „zwei
// Phasen" liest, erfindet eine Aussage ueber eine Kundenanlage.

// Build a SunSpec INT+SF image with inverter model 102 (split-phase, the KACO
// TL1 case): SID + Common(1) + inverter(102). W rides W_SF, so the scaling path
// is exercised too (register 460 with SF 1 = 4600 W).
function kacoTl1Image(base, wRegister, wSf) {
  const img = new Map();
  img.set(base, (0x53756e53 >>> 16) & 0xffff);
  img.set(base + 1, 0x53756e53 & 0xffff);
  let addr = base + 2;
  const model = (id, body) => {
    img.set(addr, id & 0xffff); img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  };
  model(1, new Array(66).fill(0)); // Common
  const inv = new Array(50).fill(0);
  inv[sunspec.INV_INT.W] = wRegister & 0xffff;
  inv[sunspec.INV_INT.W_SF] = wSf & 0xffff;
  inv[sunspec.INV_INT.Hz] = 4998;
  inv[sunspec.INV_INT.Hz_SF] = 0xfffe; // -2 -> 49.98 Hz
  inv[sunspec.INV_INT.St] = 4; // MPPT
  // DC power NOT implemented (the TL1 is a batteryless string inverter, so the
  // AC output IS its PV - the pvSource 'ac' path).
  inv[sunspec.INV_INT.DCW] = 0x8000; // int16 not-implemented sentinel
  inv[sunspec.INV_INT.DCW_SF] = 0x8000;
  model(102, inv);
  img.set(addr, 0xffff); img.set(addr + 1, 0);
  return img;
}

test('KACO TL1 (SunSpec model 102, split-phase id on a SINGLE-phase device) reads through the shared path', async () => {
  // 4,6 kW on a blueplanet 4.6 TL1: register 460 with W_SF = 1 -> 4600 W.
  const { server, port } = await startSunspecServer(kacoTl1Image(40000, 460, 1));
  try {
    const msg = { sunspec: { conn: { ip: '127.0.0.1', port, unit_id: 1, model_type: 'auto' } } };
    const out = await runFunctionNode(byId['auto-sunspec'].func, msg);
    assert.ok(Array.isArray(out), 'the 102 device is read, not skipped (the evcc failure)');
    assert.strictEqual(out[0].payload.pv_power_kw, 4.6);
    // A string inverter publishes NO grid channel (no meter model).
    assert.strictEqual('power_kw' in out[0].payload, false);
  } finally {
    server.close();
  }
});
