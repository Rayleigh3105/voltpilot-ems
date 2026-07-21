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

// A FLOAT inverter (model 113) body carrying W/Hz/St/Evt1 at the standard
// offsets, plus the optional DC power DCW (the hybrid PV source).
function invFloatBody({ w = 0, hz = 50, st = 4, evt1 = 0, dcw = null } = {}) {
  const body = new Array(60).fill(0);
  const [wh, wl] = f32words(w);
  body[L.INV_FLOAT.W] = wh;
  body[L.INV_FLOAT.W + 1] = wl;
  if (dcw !== null) {
    const [dh, dl] = f32words(dcw);
    body[L.INV_FLOAT.DCW] = dh;
    body[L.INV_FLOAT.DCW + 1] = dl;
  }
  const [hzh, hzl] = f32words(hz);
  body[L.INV_FLOAT.Hz] = hzh;
  body[L.INV_FLOAT.Hz + 1] = hzl;
  body[L.INV_FLOAT.St] = st & 0xffff;
  body[L.INV_FLOAT.Evt1] = (evt1 >>> 16) & 0xffff;
  body[L.INV_FLOAT.Evt1 + 1] = evt1 & 0xffff;
  return body;
}

// An INT+SF inverter (model 103) body: W (int16) scaled by W_SF, plus St/Evt1.
function invIntBody({
  wRaw = 0, wSf = 0, hzRaw = 500, hzSf = -1, st = 4, evt1 = 0,
  dcwRaw = null, dcwSf = 0,
} = {}) {
  const body = new Array(50).fill(0);
  body[L.INV_INT.W] = wRaw & 0xffff;
  body[L.INV_INT.W_SF] = wSf & 0xffff;
  if (dcwRaw !== null) {
    body[L.INV_INT.DCW] = dcwRaw & 0xffff;
    body[L.INV_INT.DCW_SF] = dcwSf & 0xffff;
  }
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

// --- the hybrid guard: AC W is NOT PV when a battery (Model 124) is present ---
//
// Regression for the 2026-07-21 PV incident (data/vp-pv-battery-bug §7 item 1).
// On a hybrid, AC W = PV + battery discharge - battery charge, so publishing W
// as pv_power_kw would inflate PV by the discharge. These pin: DCW is used, the
// value does NOT move with the battery, the one-sided clamp is gone, and an
// unreadable DCW publishes NOTHING (never a fabricated AC number).

const storageBody = () => new Array(D.M124.LENGTH).fill(0);

// A hybrid (Symo GEN24 + storage): Common + inverter(113) + Storage(124).
function hybridImage({ w, dcw }) {
  return buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w, dcw, st: 4 }) },
    { id: D.MODEL.STORAGE, body: storageBody() },
  ]);
}

test('hybrid (Model 124 present): pv_power_kw is DCW, unmoved by battery discharge', () => {
  // Same 8 kW of real PV throughout; only the battery changes, which moves AC W.
  const pvW = 8000;
  const cases = [
    { batteryW: 0, acW: pvW }, // battery idle
    { batteryW: 5000, acW: pvW + 5000 }, // discharging 5 kW -> AC inflated
    { batteryW: -3000, acW: pvW - 3000 }, // charging 3 kW -> AC deflated
  ];
  const seen = new Set();
  for (const c of cases) {
    const { disc, readBlock } = discoverImage(hybridImage({ w: c.acW, dcw: pvW }));
    const inv = L.decodeInverter({ discovery: disc, readBlock });
    assert.ok(inv, 'hybrid decodes');
    assert.strictEqual(inv.hybrid, true);
    assert.strictEqual(inv.pvSource, 'dc');
    assert.strictEqual(inv.pv_power_kw, 8, 'PV follows DCW, not AC W');
    assert.strictEqual(inv.w_kw, c.acW / 1000, 'AC W still surfaced for diagnostics');
    seen.add(inv.pv_power_kw);
  }
  assert.strictEqual(seen.size, 1, 'pv_power_kw is bit-identical across the battery sweep');
});

test('hybrid: the one-sided max(0, ...) clamp is dropped - a negative DCW stays visible', () => {
  const { disc, readBlock } = discoverImage(hybridImage({ w: 4000, dcw: -1500 }));
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.strictEqual(inv.pv_power_kw, -1.5, 'a sign/scale error must be visible, not a silent 0');
});

test('hybrid: unreadable DCW publishes NOTHING rather than the AC number', () => {
  // NaN float = the SunSpec "not implemented" signal for a float field.
  const { disc, readBlock } = discoverImage(hybridImage({ w: 22000, dcw: NaN }));
  assert.strictEqual(L.decodeInverter({ discovery: disc, readBlock }), null);
  const out = L.decodeMeasurements({ discovery: disc, readBlock });
  assert.strictEqual(out, null, 'no reading at all - never a fabricated PV from AC W');
});

test('hybrid (int+SF 103): DCW is scaled by DCW_SF; the sentinel means unreadable', () => {
  const withDc = buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 103, body: invIntBody({ wRaw: 1800, wSf: 1, dcwRaw: 900, dcwSf: 1 }) },
    { id: D.MODEL.STORAGE, body: storageBody() },
  ]);
  const a = discoverImage(withDc);
  const inv = L.decodeInverter({ discovery: a.disc, readBlock: a.readBlock });
  assert.strictEqual(inv.pv_power_kw, 9); // 900 * 10^1 W, NOT the 18 kW AC
  assert.strictEqual(inv.w_kw, 18);

  const sentinel = buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 103, body: invIntBody({ wRaw: 1800, wSf: 1, dcwRaw: -32768, dcwSf: 0 }) },
    { id: D.MODEL.STORAGE, body: storageBody() },
  ]);
  const b = discoverImage(sentinel);
  assert.strictEqual(L.decodeInverter({ discovery: b.disc, readBlock: b.readBlock }), null);
});

test('batteryless (no Model 124) is byte-identical to before: AC W IS the PV, clamped', () => {
  // The live Fronius Eco path - must not regress. DCW is deliberately present in
  // the image and MUST be ignored.
  const img = buildImage(D.DEFAULT_BASE, [
    { id: D.MODEL.COMMON, body: commonBody() },
    { id: 113, body: invFloatBody({ w: 26900, dcw: 12345, st: 4 }) },
  ]);
  const { disc, readBlock } = discoverImage(img);
  const inv = L.decodeInverter({ discovery: disc, readBlock });
  assert.strictEqual(inv.hybrid, false);
  assert.strictEqual(inv.pvSource, 'ac');
  assert.strictEqual(inv.pv_power_kw, 26.9);
  // and the negative-W floor still applies for a string inverter
  const neg = discoverImage(ecoImage(-350));
  assert.strictEqual(L.decodeInverter({ discovery: neg.disc, readBlock: neg.readBlock }).pv_power_kw, 0);
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
