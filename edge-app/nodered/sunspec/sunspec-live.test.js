'use strict';

/**
 * Offline tests for the SunSpec live-measurement decoders + the socket reader.
 * No hardware: the decoders run against a fixture SunSpec register image (the
 * same buildImage/readerOver shape model-discovery.test.js uses), and the reader
 * runs against a real in-process Modbus-TCP server serving that image. Proves
 * the W->pv_power_kw arithmetic (float AND int+SF), the St/Evt surfacing, the
 * honest null-vs-zero discipline, and the end-to-end socket walk.
 *
 * Run: node --test edge-app/nodered/sunspec/sunspec-live.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const D = require('./model-discovery.js');
const L = require('./sunspec-live.js');

// --- fixture builder (mirrors model-discovery.test.js) -----------------------

function buildImage(base, models) {
  const img = new Map();
  img.set(base, (D.SID >>> 16) & 0xffff);
  img.set(base + 1, D.SID & 0xffff);
  let addr = base + 2;
  for (const m of models) {
    const body = m.body || [];
    img.set(addr, m.id & 0xffff);
    img.set(addr + 1, body.length & 0xffff);
    for (let i = 0; i < body.length; i++) img.set(addr + 2 + i, body[i] & 0xffff);
    addr += 2 + body.length;
  }
  img.set(addr, D.END_MODEL_ID);
  img.set(addr + 1, 0);
  return img;
}

function readerOver(img) {
  return (addr, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const w = img.get(addr + i);
      if (w === undefined) break;
      out.push(w);
    }
    return out;
  };
}

// Encode an IEEE-754 float into two big-endian 16-bit words [hi, lo].
function f32words(value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(value, 0);
  return [buf.readUInt16BE(0), buf.readUInt16BE(2)];
}

const commonBody = () => new Array(66).fill(0);

// A FLOAT inverter (model 113) body carrying W/Hz/St/Evt1 at the standard offsets.
function invFloatBody({ w = 0, hz = 50, st = 4, evt1 = 0 } = {}) {
  const body = new Array(60).fill(0);
  const [wh, wl] = f32words(w);
  body[L.INV_FLOAT.W] = wh;
  body[L.INV_FLOAT.W + 1] = wl;
  const [hzh, hzl] = f32words(hz);
  body[L.INV_FLOAT.Hz] = hzh;
  body[L.INV_FLOAT.Hz + 1] = hzl;
  body[L.INV_FLOAT.St] = st & 0xffff;
  body[L.INV_FLOAT.Evt1] = (evt1 >>> 16) & 0xffff;
  body[L.INV_FLOAT.Evt1 + 1] = evt1 & 0xffff;
  return body;
}

// An INT+SF inverter (model 103) body: W (int16) scaled by W_SF, plus St/Evt1.
function invIntBody({ wRaw = 0, wSf = 0, hzRaw = 500, hzSf = -1, st = 4, evt1 = 0 } = {}) {
  const body = new Array(50).fill(0);
  body[L.INV_INT.W] = wRaw & 0xffff;
  body[L.INV_INT.W_SF] = wSf & 0xffff;
  body[L.INV_INT.Hz] = hzRaw & 0xffff;
  body[L.INV_INT.Hz_SF] = hzSf & 0xffff;
  body[L.INV_INT.St] = st & 0xffff;
  body[L.INV_INT.Evt1] = (evt1 >>> 16) & 0xffff;
  body[L.INV_INT.Evt1 + 1] = evt1 & 0xffff;
  return body;
}

// A FLOAT meter (model 213) body carrying total real power W at the standard offset.
function meterFloatBody({ w = 0 } = {}) {
  const body = new Array(60).fill(0);
  const [wh, wl] = f32words(w);
  body[L.MET_FLOAT.W] = wh;
  body[L.MET_FLOAT.W + 1] = wl;
  return body;
}

// Build the fixture + return { disc, readBlock } - the decoders need the reader
// to fetch the model BODY (discovery does not retain register values for it).
function discoverImage(img) {
  const readBlock = readerOver(img);
  return { disc: D.discover(readBlock), readBlock };
}

function ecoImage(w) {
  // A realistic Fronius-Eco-shaped float device: Common(1) + inverter(113).
  return buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w, st: 4 }) },
  ]);
}

// --- decodeInverter (float) --------------------------------------------------

test('decodeInverter (float 113) maps W -> pv_power_kw and surfaces St/Hz', () => {
  const { disc, readBlock } = discoverImage(ecoImage(24000)); // 24 kW producing
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.ok(inv);
  assert.strictEqual(inv.pv_power_kw, 24);
  assert.strictEqual(inv.w_kw, 24);
  assert.strictEqual(inv.hz, 50);
  assert.strictEqual(inv.st, 4);
  assert.strictEqual(inv.stLabel, 'MPPT');
});

test('decodeInverter keeps a real 0 W (idle/night) - not fabricated, not dropped', () => {
  const { disc, readBlock } = discoverImage(ecoImage(0));
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.ok(inv);
  assert.strictEqual(inv.pv_power_kw, 0);
});

test('decodeInverter floors a negative W to 0 for the PV channel but keeps signed w_kw', () => {
  const { disc, readBlock } = discoverImage(ecoImage(-350)); // -0.35 kW self-consumption
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.strictEqual(inv.pv_power_kw, 0);
  assert.strictEqual(inv.w_kw, -0.35);
});

test('decodeInverter surfaces the THROTTLED state (curtailment tell-tale)', () => {
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w: 12000, st: 5, evt1: 0x00000002 }) },
  ]));
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.strictEqual(inv.st, 5);
  assert.strictEqual(inv.stLabel, 'THROTTLED');
  assert.strictEqual(inv.evt1, 0x00000002);
});

// --- decodeInverter (int+SF) -------------------------------------------------

test('decodeInverter (int+SF 103) applies the W scale factor', () => {
  // W_raw 1234, W_SF 1 -> 12340 W = 12.34 kW.
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 103, body: invIntBody({ wRaw: 1234, wSf: 1 }) },
  ]));
  assert.strictEqual(disc.inverter.type, 'int_sf');
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.strictEqual(inv.pv_power_kw, 12.34);
  assert.strictEqual(inv.hz, 50); // 500 * 10^-1
});

test('decodeInverter honours a modelType override hint', () => {
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w: 5000 }) },
  ]));
  // Forcing float is a no-op here (already float); forcing int_sf would misread -
  // prove the hint is accepted and float still decodes correctly.
  const inv = L.decodeInverter({ discovery: disc, readBlock, modelType: 'float' });
  assert.strictEqual(inv.pv_power_kw, 5);
});

// --- idle-safe -----------------------------------------------------------------

test('decodeInverter is idle-safe: no discovery / no inverter model -> null', () => {
  assert.strictEqual(L.decodeInverter({ discovery: null }), null);
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: D.MODEL.NAMEPLATE, body: new Array(26).fill(0) },
  ]));
  assert.strictEqual(L.decodeInverter({ discovery: disc, readBlock }), null);
});

test('decodeInverter is idle-safe when the body cannot be fully read', () => {
  // Discovery locates the inverter, but the reader returns short for its body.
  const img = ecoImage(9000);
  const disc = D.discover(readerOver(img));
  const bodyAddr = disc.byId[113].bodyAddr;
  const shortReader = (addr, count) => {
    // Serve everything except the inverter body region -> body read comes back short.
    if (addr >= bodyAddr) return [];
    return readerOver(img)(addr, count);
  };
  assert.strictEqual(L.decodeInverter({ discovery: disc, readBlock: shortReader }), null);
});

// --- decodeMeter (minimal, optional) -----------------------------------------

test('decodeMeter (float 213) maps total W -> power_kw with the sign hatch', () => {
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 213, body: meterFloatBody({ w: -4200 }) }, // -4.2 kW (export, in raw sign)
  ]));
  assert.strictEqual(L.decodeMeter({ discovery: disc, readBlock }).power_kw, -4.2);
  assert.strictEqual(L.decodeMeter({ discovery: disc, readBlock, invertGridSign: true }).power_kw, 4.2);
});

test('decodeMeter is null when no meter model is present (PV-only Eco)', () => {
  const { disc, readBlock } = discoverImage(ecoImage(10000));
  assert.strictEqual(L.decodeMeter({ discovery: disc, readBlock }), null);
});

// --- decodeMeasurements ------------------------------------------------------

test('decodeMeasurements yields a PV-only reading for the Eco (honest partial)', () => {
  const { disc, readBlock } = discoverImage(ecoImage(27000));
  const out = L.decodeMeasurements({ discovery: disc, readBlock });
  assert.deepStrictEqual(out.reading, { pv_power_kw: 27 });
  assert.strictEqual('power_kw' in out.reading, false); // no meter -> no grid channel
  assert.strictEqual(out.meta.inverterModel, 113);
  assert.strictEqual(out.meta.inverterType, 'float');
  assert.strictEqual(out.reading.ts, undefined); // caller stamps ts
});

test('decodeMeasurements merges inverter + meter when both are present', () => {
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w: 15000 }) },
    { id: 213, body: meterFloatBody({ w: 3000 }) },
  ]));
  const out = L.decodeMeasurements({ discovery: disc, readBlock });
  assert.strictEqual(out.reading.pv_power_kw, 15);
  assert.strictEqual(out.reading.power_kw, 3);
});

test('decodeMeasurements is null when nothing decodable', () => {
  const { disc, readBlock } = discoverImage(buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
  ]));
  assert.strictEqual(L.decodeMeasurements({ discovery: disc, readBlock }), null);
});

// --- the socket reader (real in-process Modbus-TCP server) -------------------

// Serve a SunSpec image (Map addr->word) over FC3, honouring arbitrary
// address/count reads and returning a Modbus exception past the image end (an
// illegal-data-address, the real end-of-file behaviour the walk relies on).
function startSunspecServer(img) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let acc = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        acc = Buffer.concat([acc, chunk]);
        while (acc.length >= 12) {
          const req = acc.slice(0, 12);
          acc = acc.slice(12);
          const txid = req.readUInt16BE(0);
          const addr = req.readUInt16BE(8);
          const count = req.readUInt16BE(10);
          // If ANY requested register is absent, reply with exception 0x02.
          let ok = true;
          for (let i = 0; i < count; i++) if (!img.has(addr + i)) { ok = false; break; }
          if (!ok) {
            const ex = Buffer.alloc(9);
            ex.writeUInt16BE(txid, 0); ex.writeUInt16BE(0, 2); ex.writeUInt16BE(3, 4);
            ex[6] = req[6]; ex[7] = 0x83; ex[8] = 0x02;
            sock.write(ex);
            continue;
          }
          const byteCount = count * 2;
          const resp = Buffer.alloc(9 + byteCount);
          resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(0, 2); resp.writeUInt16BE(3 + byteCount, 4);
          resp[6] = req[6]; resp[7] = 0x03; resp[8] = byteCount;
          for (let i = 0; i < count; i++) resp.writeUInt16BE((img.get(addr + i) || 0) & 0xffff, 9 + i * 2);
          sock.write(resp);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('makeSunspecReader walks a live server and produces pv_power_kw', async () => {
  const { server, port } = await startSunspecServer(ecoImage(26500));
  try {
    const read = L.makeSunspecReader({ net, discovery: D });
    const out = await read({ ip: '127.0.0.1', port, unitId: 1 });
    assert.ok(out, 'read succeeded');
    assert.strictEqual(out.reading.pv_power_kw, 26.5);
    assert.strictEqual(out.meta.inverterModel, 113);
  } finally {
    server.close();
  }
});

test('makeSunspecReader finds a device at a non-default base (50000)', async () => {
  const img = buildImage(50000, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w: 8000 }) },
  ]);
  const { server, port } = await startSunspecServer(img);
  try {
    const read = L.makeSunspecReader({ net, discovery: D });
    const out = await read({ ip: '127.0.0.1', port, unitId: 1 });
    assert.strictEqual(out.reading.pv_power_kw, 8);
    assert.strictEqual(out.meta.base, 50000);
  } finally {
    server.close();
  }
});

test('makeSunspecReader is idle-safe on a connection error (null, never throws)', async () => {
  const read = L.makeSunspecReader({ net, discovery: D, connectTimeoutMs: 500 });
  const out = await read({ ip: '127.0.0.1', port: 1, unitId: 1 });
  assert.strictEqual(out, null);
});

test('makeSunspecReader returns null against a non-SunSpec server', async () => {
  // A server whose base registers are not "SunS".
  const img = new Map();
  for (let a = 40000; a < 40010; a++) img.set(a, 0x1234);
  const { server, port } = await startSunspecServer(img);
  try {
    const read = L.makeSunspecReader({ net, discovery: D, bases: [40000] });
    assert.strictEqual(await read({ ip: '127.0.0.1', port, unitId: 1 }), null);
  } finally {
    server.close();
  }
});
