'use strict';

/**
 * test-read.test.js - unit + in-process-server proof of the one-shot
 * "Verbindung testen" read (test-read.js). The modbus_tcp path is driven end to
 * end against a real in-process Modbus-TCP server (the same harness idea as
 * modbus-tcp.e2e.test.js); the error classifications are exercised with a
 * connect-refused address, a connect-then-silent server (short timeouts) and
 * garbage frames.
 */

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const testRead = require('./test-read');
const deye = require('./deye/deye-decode');
const modbus = require('./modbus-tcp');
const fronius = require('./fronius/solar-api');
const solarman = require('./deye/solarman-v5');
const sunspec = require('./sunspec/sunspec-live');
const discovery = require('./sunspec/model-discovery');
const goe = require('./goe/goe-api');
const kostal = require('./kostal/kostal-decode');

function deps(extra) {
  return Object.assign({ deye, modbus, fronius, solarman, sunspec, discovery, goe, kostal, net, http, https }, extra || {});
}

// Build a SunSpec float-113 register image (Map addr->word) for the reader tests.
function sunspecEcoImage(base, wWatts) {
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
  const wbuf = Buffer.alloc(4); wbuf.writeFloatBE(wWatts, 0);
  inv[sunspec.INV_FLOAT.W] = wbuf.readUInt16BE(0);
  inv[sunspec.INV_FLOAT.W + 1] = wbuf.readUInt16BE(2);
  const hzbuf = Buffer.alloc(4); hzbuf.writeFloatBE(50, 0);
  inv[sunspec.INV_FLOAT.Hz] = hzbuf.readUInt16BE(0);
  inv[sunspec.INV_FLOAT.Hz + 1] = hzbuf.readUInt16BE(2);
  inv[sunspec.INV_FLOAT.St] = 4; // MPPT
  model(113, inv);
  img.set(addr, 0xffff); img.set(addr + 1, 0);
  return img;
}

// A Modbus-TCP server serving a SunSpec image, exception past the image end.
// `img` is either ONE Map (every unit id answers it) or a per-unit-id object
// {1: MapA, 2: MapB} - a Fronius Datamanager exposing several inverters on one
// IP. A unit id without an image answers a Modbus exception 0x0B (gateway
// target device failed to respond) unless opts.silentUnknown, which makes an
// unknown unit answer NOTHING (a gateway that just swallows the request).
function startSunspecServer(img, opts) {
  const silentUnknown = !!(opts && opts.silentUnknown);
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
          if (!unitImg) {
            if (!silentUnknown) ex(0x0b);
            continue;
          }
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

// A minimal Modbus-TCP server answering fn-0x03 with a fixed register block.
function startModbusServer(regs) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', (req) => {
        const txid = req.readUInt16BE(0);
        const addr = req.readUInt16BE(8);
        const count = req.readUInt16BE(10);
        const byteCount = count * 2;
        const resp = Buffer.alloc(9 + byteCount);
        resp.writeUInt16BE(txid, 0);
        resp.writeUInt16BE(0, 2);
        resp.writeUInt16BE(3 + byteCount, 4);
        resp[6] = req[6];
        resp[7] = 0x03;
        resp[8] = byteCount;
        for (let i = 0; i < count; i++) resp.writeUInt16BE((regs[addr + i] || 0) & 0xffff, 9 + i * 2);
        sock.write(resp);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// A server that accepts the connection but never answers (proves no_answer,
// distinct from a refused connect = unreachable).
function startSilentServer() {
  return new Promise((resolve) => {
    const server = net.createServer(() => { /* accept, say nothing */ });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// A server that returns garbage (proves invalid_response).
function startGarbageServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on('data', () => sock.write(Buffer.from([0, 1, 0, 0, 0, 3, 1, 0x83, 0x02])));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('modbus_tcp: reads + decodes a live server -> ok with reading', async () => {
  // grid +2.50 kW, pv 12.00 kW, load 8.00 kW, batt +5.00, soc 55.0 %, wmax 70, conn 50.
  const regs = [250, 1200, 800, 500, 550, 7000, 5000, 0, 0];
  const { server, port } = await startModbusServer(regs);
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '127.0.0.1', port, unit_id: 1 } });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.reading.pv_kw, 12);
    assert.strictEqual(res.reading.load_kw, 8);
    assert.strictEqual(res.reading.grid_kw, 2.5);
    assert.strictEqual(res.reading.soc_pct, 55);
  } finally {
    server.close();
  }
});

test('grid-meter role shows only Netzbezug', async () => {
  const regs = [250, 1200, 800, 500, 550, 7000, 5000, 0, 0];
  const { server, port } = await startModbusServer(regs);
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '127.0.0.1', port, unit_id: 1 } }, 'grid-meter');
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(Object.keys(res.reading), ['grid_kw']);
    assert.strictEqual(res.reading.grid_kw, 2.5);
  } finally {
    server.close();
  }
});

test('unreachable: a refused connect classifies as unreachable', async () => {
  // Port 1 on loopback is refused immediately.
  const readOnce = testRead.makeReadOnce(deps({ connectTimeoutMs: 500 }));
  const res = await readOnce({ communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '127.0.0.1', port: 1 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_UNREACHABLE);
});

test('no_answer: connected but silent classifies as no_answer', async () => {
  const { server, port } = await startSilentServer();
  try {
    const readOnce = testRead.makeReadOnce(deps({ readTimeoutMs: 300 }));
    const res = await readOnce({ communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, testRead.ERR_NO_ANSWER);
  } finally {
    server.close();
  }
});

test('invalid_response: a Modbus exception frame classifies as invalid_response', async () => {
  const { server, port } = await startGarbageServer();
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, testRead.ERR_INVALID_RESPONSE);
  } finally {
    server.close();
  }
});

test('invalid_request: a form with no IP is rejected before any I/O', async () => {
  const readOnce = testRead.makeReadOnce(deps());
  const res = await readOnce({ communication: 'modbus_tcp', family: 'sunspec', connection: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_INVALID_REQUEST);
});

test('invalid_request: a Deye form with no datalogger serial is rejected', async () => {
  const readOnce = testRead.makeReadOnce(deps());
  const res = await readOnce({ communication: 'solarman_v5', family: 'hybrid_3p', connection: { ip: '127.0.0.1' } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_INVALID_REQUEST);
});

test('fronius_sunspec: a live SunSpec inverter decodes into a PV reading', async () => {
  const { server, port } = await startSunspecServer(sunspecEcoImage(40000, 26500));
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port, unit_id: 1, model_type: 'auto' } });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.reading.pv_kw, 26.5);
    assert.strictEqual('grid_kw' in res.reading, false); // PV-only inverter, no meter
  } finally {
    server.close();
  }
});

test('fronius_sunspec: a refused connect classifies as unreachable', async () => {
  const readOnce = testRead.makeReadOnce(deps({ connectTimeoutMs: 500 }));
  const res = await readOnce({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port: 1, unit_id: 1 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_UNREACHABLE);
});

test('fronius_sunspec: a connected non-SunSpec host classifies as invalid_response', async () => {
  const img = new Map();
  for (let a = 40000; a < 40010; a++) img.set(a, 0x1234); // not "SunS"
  const { server, port } = await startSunspecServer(img);
  try {
    const readOnce = testRead.makeReadOnce(deps({ readTimeoutMs: 500 }));
    const res = await readOnce({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port, unit_id: 1 } });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, testRead.ERR_INVALID_RESPONSE);
  } finally {
    server.close();
  }
});

/* ---- multi-inverter unit-ID enumeration (Fronius Datamanager) ---- */

test('probe finds BOTH inverters at one Datamanager IP (the captain\'s site: unit ids 1 + 2)', async () => {
  // Two Eco 27.0-3-S behind one Datamanager: "(1) ost" = unit 1, "(2) west" =
  // unit 2 (Datamanager convention: inverter number = Modbus unit id).
  const { server, port } = await startSunspecServer({ 1: sunspecEcoImage(40000, 22110), 2: sunspecEcoImage(40000, 26140) });
  try {
    const probeUnits = testRead.makeProbeUnits(deps());
    const res = await probeUnits({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port, unit_id: 1 } });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.deepStrictEqual(res.found_units, [1, 2]);
  } finally {
    server.close();
  }
});

test('probe with a single inverter returns exactly [1] (absent unit ids answer fast exceptions)', async () => {
  const { server, port } = await startSunspecServer({ 1: sunspecEcoImage(40000, 26500) });
  try {
    const probeUnits = testRead.makeProbeUnits(deps());
    const res = await probeUnits({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.found_units, [1]);
  } finally {
    server.close();
  }
});

test('probe locks the discovered base: devices at base 0 are still enumerated', async () => {
  const { server, port } = await startSunspecServer({ 1: sunspecEcoImage(0, 8000), 2: sunspecEcoImage(0, 9000) });
  try {
    const probeUnits = testRead.makeProbeUnits(deps());
    const res = await probeUnits({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.found_units, [1, 2]);
  } finally {
    server.close();
  }
});

test('probe on a refused connect classifies as unreachable', async () => {
  const probeUnits = testRead.makeProbeUnits(deps({ connectTimeoutMs: 500 }));
  const res = await probeUnits({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port: 1 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_UNREACHABLE);
});

test('probe skips a SILENT unknown unit within its per-id budget and still returns the found ones', async () => {
  // A gateway that swallows requests for unknown unit ids (no exception): the
  // scan must not hang - each silent id costs at most one per-id timeout.
  const { server, port } = await startSunspecServer({ 1: sunspecEcoImage(40000, 26500) }, { silentUnknown: true });
  try {
    const probeUnits = testRead.makeProbeUnits(deps({ probeIdTimeoutMs: 150, probeMaxUnitId: 3 }));
    const started = Date.now();
    const res = await probeUnits({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.found_units, [1]);
    assert.ok(Date.now() - started < 2000, 'silent ids are bounded by the per-id timeout');
  } finally {
    server.close();
  }
});

test('probe is bounded by the overall budget and returns what it found so far', async () => {
  const { server, port } = await startSunspecServer({ 1: sunspecEcoImage(40000, 26500) }, { silentUnknown: true });
  try {
    const probeUnits = testRead.makeProbeUnits(deps({ probeIdTimeoutMs: 400, probeOverallMs: 600 }));
    const started = Date.now();
    const res = await probeUnits({ communication: 'fronius_sunspec', family: 'sunspec_live', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.found_units, [1]);
    assert.ok(Date.now() - started < 1500, 'the overall budget caps the scan');
  } finally {
    server.close();
  }
});

test('probe rejects a non-SunSpec selection before any I/O', async () => {
  const probeUnits = testRead.makeProbeUnits(deps());
  const res = await probeUnits({ communication: 'modbus_tcp', family: 'sunspec', connection: { ip: '127.0.0.1', port: 502 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_INVALID_REQUEST);
});

test('fronius: a non-answering host classifies as fronius_api', async () => {
  const readOnce = testRead.makeReadOnce(deps({ httpTimeoutMs: 400 }));
  const res = await readOnce({ communication: 'fronius_solar_api', family: 'fronius_gen24', connection: { ip: '127.0.0.1', port: 1 } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_FRONIUS_API);
});

test('fronius: a live Solar API host decodes into a reading', async () => {
  const body = JSON.stringify({
    Head: { Status: { Code: 0 } },
    Body: { Data: { Site: { P_PV: 4800, P_Grid: -2100, P_Load: -1200 }, Inverters: { 1: { SOC: 62 } } } },
  });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'fronius_solar_api', family: 'fronius_gen24', connection: { ip: '127.0.0.1', port } });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.reading.pv_kw, 4.8);
    assert.strictEqual(res.reading.grid_kw, -2.1);
    assert.strictEqual(res.reading.load_kw, 1.2);
    assert.strictEqual(res.reading.soc_pct, 62);
  } finally {
    server.close();
  }
});

// --- go-e Charger (HTTP API v2) consumer read path ---------------------------

test('go-e: a live /api/status host decodes charging power into load_kw (consumer)', async () => {
  const body = JSON.stringify({
    car: 2,
    alw: true,
    amp: 16,
    nrg: [232, 231, 232, 0, 16, 16, 16, 3680, 3700, 3660, 0, 11040, 99, 99, 99, 0],
  });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'goe_http_api', family: 'goe_http_api', connection: { ip: '127.0.0.1', port } }, 'consumer');
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.reading.load_kw, 11.04);
    // a consumer read surfaces only load (no pv/grid/soc fabricated).
    assert.strictEqual(res.reading.pv_kw, undefined);
    assert.strictEqual(res.reading.grid_kw, undefined);
  } finally {
    server.close();
  }
});

test('go-e: a not-charging device reports a real load_kw 0 (kept)', async () => {
  const body = JSON.stringify({ car: 4, nrg: new Array(16).fill(0) });
  const server = http.createServer((req, res) => res.end(body));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'goe_http_api', family: 'goe_http_api', connection: { ip: '127.0.0.1', port } }, 'consumer');
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.reading.load_kw, 0);
  } finally {
    server.close();
  }
});

test('go-e: a reachable host with no nrg classifies as invalid_response (no fabricated load)', async () => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ car: 2 })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce({ communication: 'goe_http_api', family: 'goe_http_api', connection: { ip: '127.0.0.1', port } }, 'consumer');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, testRead.ERR_INVALID_RESPONSE);
  } finally {
    server.close();
  }
});

test('go-e: a refused connect classifies as unreachable', async () => {
  const readOnce = testRead.makeReadOnce(deps({ httpTimeoutMs: 400 }));
  const res = await readOnce({ communication: 'goe_http_api', family: 'goe_http_api', connection: { ip: '127.0.0.1', port: 1 } }, 'consumer');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, testRead.ERR_UNREACHABLE);
});

// --- KOSTAL PLENTICORE BI (kostal_modbus) ------------------------------------

// Absolute register image of a healthy PLENTICORE BI 10/26: byte order little
// (factory), KSEM at the grid connection importing 1.5 kW, SoC 87 %, battery
// charging 2 kW (register -2000: negative = charge per the official doc).
function kostalImage() {
  const regs = {};
  const putF32 = (addr, value) => {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(value, 0);
    regs[addr] = buf.readUInt16BE(2); // little/CDAB: LOW word first
    regs[addr + 1] = buf.readUInt16BE(0);
  };
  regs[kostal.REG.BYTE_ORDER] = 0;
  regs[kostal.REG.INVERTER_STATE] = 6; // low word (little)
  regs[kostal.REG.INVERTER_STATE + 1] = 0;
  regs[kostal.REG.BATTERY_SOC_PCT] = 87;
  regs[kostal.REG.INVERTER_MAX_POWER_W] = 10000;
  regs[kostal.REG.BATTERY_POWER_W] = -2000 & 0xffff;
  regs[kostal.REG.BATTERY_TYPE] = 0x0004;
  regs[kostal.REG.BATTERY_MGMT_MODE] = kostal.MGMT_MODE_EXTERNAL_MODBUS;
  regs[kostal.REG.SENSOR_TYPE] = 0x03; // KSEM
  putF32(kostal.REG.POWERMETER_TOTAL_W, 1500);
  putF32(kostal.REG.BMS_MAX_CHARGE_W, 9000);
  putF32(kostal.REG.BMS_MAX_DISCHARGE_W, 10000);
  putF32(kostal.REG.BATTERY_WORK_CAPACITY_WH, 10240);
  return regs;
}

function kostalSelection(ip, port) {
  return {
    communication: 'kostal_modbus', family: 'kostal_plenticore',
    connection: { ip, port, unit_id: 71, byte_order: 'auto' },
  };
}

test('kostal_modbus: reads + decodes a live PLENTICORE -> ok with grid + SoC', async () => {
  const { server, port } = await startModbusServer(kostalImage());
  try {
    const readOnce = testRead.makeReadOnce(deps());
    const res = await readOnce(kostalSelection('127.0.0.1', port));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.reading.grid_kw, 1.5);
    assert.strictEqual(res.reading.soc_pct, 87);
    // The BI has no PV/load channel - absent, never fabricated.
    assert.strictEqual(res.reading.pv_kw, undefined);
    assert.strictEqual(res.reading.load_kw, undefined);
  } finally {
    server.close();
  }
});

test('kostal_modbus: refused connect classifies unreachable, garbage as invalid_response', async () => {
  const readOnce = testRead.makeReadOnce(deps({ connectTimeoutMs: 500, readTimeoutMs: 500 }));
  const refused = await readOnce(kostalSelection('127.0.0.1', 1));
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error_code, 'unreachable');
  const { server, port } = await startGarbageServer();
  try {
    const res = await readOnce(kostalSelection('127.0.0.1', port));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error_code, 'invalid_response');
  } finally {
    server.close();
  }
});
