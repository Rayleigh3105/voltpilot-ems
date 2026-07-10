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

function deps(extra) {
  return Object.assign({ deye, modbus, fronius, solarman, sunspec, discovery, net, http, https }, extra || {});
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
