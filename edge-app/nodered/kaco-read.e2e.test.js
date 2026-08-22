'use strict';

// KACO/AISWEI end to end: die BEIDEN neuen Lesepfade laufen gegen echte
// In-Process-Server (HTTP bzw. Modbus TCP) - einmal ueber das Modul, einmal
// ueber den EINGEBETTETEN Flow-Funktionsknoten aus flows.json. Kein Netz nach
// aussen, kein Geraet.

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const kacoHttp = require('./kaco/kaco-http');
const aiswei = require('./kaco/aiswei-decode');

const flows = JSON.parse(fs.readFileSync(path.join(__dirname, 'flows.json'), 'utf8'));
const byId = Object.fromEntries(flows.map((n) => [n.id, n]));

// --- ein Stellvertreter der 8484-API ----------------------------------------

const NX3_INVERTER = {
  pac: 1377, fac: 5002, eto: 495, etd: 22, tmp: 351, err: 0,
  vpv: [3200, 3100], ipv: [250, 240],
};

function startStick(opts) {
  opts = opts || {};
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const send = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/getdev.cgi')) {
      return send({ inv: [{ isn: 'B1234567890', add: 3, rate: 12000 }] });
    }
    if (req.url.indexOf('device=2') >= 0) return send(NX3_INVERTER);
    if (req.url.indexOf('device=3') >= 0) return send({ pac: -820 });
    if (req.url.indexOf('device=4') >= 0) {
      if (opts.noBattery) { res.writeHead(404); return res.end(); }
      return send({ pb: -2400, soc: 78, vb: 38500, cb: 62, soh: 99 });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

// --- ein Stellvertreter der AISWEI-Registerkarte ----------------------------
//
// Er beantwortet FC4 (Input) und FC3 (Holding) aus GETRENNTEN Tabellen - genau
// die Trennung, an der ein Leser scheitert, der pauschal FC3 sendet.
function startNh3(input, holding) {
  const server = net.createServer((sock) => {
    let acc = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      while (acc.length >= 12) {
        const req = acc.slice(0, 12); acc = acc.slice(12);
        const txid = req.readUInt16BE(0);
        const fn = req[7];
        const addr = req.readUInt16BE(8);
        const count = req.readUInt16BE(10);
        const table = fn === 4 ? input : (fn === 3 ? holding : null);
        let ok = !!table;
        if (ok) for (let i = 0; i < count; i++) if (!table.has(addr + i)) { ok = false; break; }
        if (!ok) {
          const ex = Buffer.alloc(9);
          ex.writeUInt16BE(txid, 0); ex.writeUInt16BE(3, 4); ex[6] = req[6]; ex[7] = fn | 0x80; ex[8] = 0x02;
          sock.write(ex); continue;
        }
        const bc = count * 2;
        const resp = Buffer.alloc(9 + bc);
        resp.writeUInt16BE(txid, 0); resp.writeUInt16BE(3 + bc, 4); resp[6] = req[6]; resp[7] = fn; resp[8] = bc;
        for (let i = 0; i < count; i++) resp.writeUInt16BE((table.get(addr + i) || 0) & 0xffff, 9 + i * 2);
        sock.write(resp);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function nh3Tables() {
  const input = new Map();
  const holding = new Map();
  const w32 = (v) => [((v >>> 0) >>> 16) & 0xffff, (v >>> 0) & 0xffff];
  for (let a = 1000; a < 1028; a++) input.set(a, 0);
  input.set(aiswei.inputAddr(31001), 3);
  input.set(aiswei.inputAddr(31002), 3);
  input.set(aiswei.inputAddr(31028), 12000);
  for (let a = 1600; a < 1625; a++) input.set(a, 0);
  const pv = w32(5400);
  input.set(aiswei.inputAddr(31601), pv[0]);
  input.set(aiswei.inputAddr(31601) + 1, pv[1]);
  const pb = w32(-3000);
  input.set(aiswei.inputAddr(31619), pb[0]);
  input.set(aiswei.inputAddr(31619) + 1, pb[1]);
  input.set(aiswei.inputAddr(31622), 7825);
  input.set(aiswei.inputAddr(31623), 99);
  const grid = w32(-500);
  holding.set(aiswei.holdingAddr(46434), grid[0]);
  holding.set(aiswei.holdingAddr(46434) + 1, grid[1]);
  return { input, holding };
}

// Einen Funktionsknoten mit Node-RED-artigem Kontext laufen lassen.
async function runFunctionNode(func, msg) {
  const ctxStore = {};
  const sandbox = {
    msg,
    node: { status() {}, error() {}, warn() {}, send() {} },
    context: { get: (k) => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } },
    flow: { get() {}, set() {} },
    global: { get: (k) => ({ net, http, https }[k]) },
    Buffer, Date, Math, isFinite, Number, Array, Object, JSON, Promise, Map, setTimeout, clearTimeout,
  };
  const script = new vm.Script('(function(){' + func + '\n})()');
  const ret = script.runInContext(vm.createContext(sandbox));
  return ret && typeof ret.then === 'function' ? await ret : ret;
}

// --- HTTP-Pfad ---------------------------------------------------------------

test('KACO HTTP: der Leser holt sich die Seriennummer selbst und liest alle drei Geraete', async () => {
  const { server, port, seen } = await startStick();
  try {
    const read = kacoHttp.makeKacoHttpReader({ http, https });
    const out = await read({ ip: '127.0.0.1', port, family: 'kaco_http_hybrid' });
    assert.strictEqual(out.serial, 'B1234567890');
    assert.strictEqual(out.reading.pv_power_kw, 1.544); // DC-Seite beim Hybriden
    assert.strictEqual(out.reading.power_kw, -0.82);
    assert.strictEqual(out.reading.soc_pct, 78);
    assert.strictEqual(out.battKw, 2.4);
    // Das Inventar wurde wirklich gefragt - die Nummer wird nie geraten.
    assert.ok(seen.some((u) => u.startsWith('/getdev.cgi')));
  } finally {
    server.close();
  }
});

test('KACO HTTP: eine String-Familie fragt den Speicher GAR NICHT (kein Timeout auf ein Geraet ohne Batterie)', async () => {
  const { server, port, seen } = await startStick();
  try {
    const read = kacoHttp.makeKacoHttpReader({ http, https });
    const out = await read({ ip: '127.0.0.1', port, serial: 'B1234567890', family: 'kaco_http' });
    assert.strictEqual(out.reading.pv_power_kw, 1.377); // AC-Seite beim String-Geraet
    assert.strictEqual(out.battKw, null);
    assert.ok(!seen.some((u) => u.indexOf('device=4') >= 0), 'kein Speicher-Abruf');
  } finally {
    server.close();
  }
});

test('KACO HTTP: ein fehlender Speicher-Abruf laesst NUR seine Kanaele weg', async () => {
  const { server, port } = await startStick({ noBattery: true });
  try {
    const read = kacoHttp.makeKacoHttpReader({ http, https });
    const out = await read({ ip: '127.0.0.1', port, serial: 'B1', family: 'kaco_http_hybrid' });
    assert.strictEqual(out.reading.pv_power_kw, 1.544);
    assert.strictEqual(out.reading.power_kw, -0.82);
    assert.strictEqual('soc_pct' in out.reading, false);
    assert.strictEqual(out.battKw, null);
  } finally {
    server.close();
  }
});

test('KACO HTTP: eine tote Adresse endet in null, nie in einem Wurf', async () => {
  const read = kacoHttp.makeKacoHttpReader({ http, https, timeoutMs: 300 });
  // Port 1 ist auf 127.0.0.1 verlaesslich geschlossen.
  assert.strictEqual(await read({ ip: '127.0.0.1', port: 1, serial: 'B1' }), null);
});

test('der FLOW-Knoten liest den Stick und veroeffentlicht die Messwerte', async () => {
  const { server, port } = await startStick();
  try {
    const msg = {
      kaco: {
        conn: { ip: '127.0.0.1', port, scheme: 'http', serial: '', insecure_tls: false, invert_grid_sign: false, invert_batt_sign: false },
        family: 'kaco_http_hybrid', has_battery: true,
      },
    };
    const out = await runFunctionNode(byId['auto-kaco'].func, msg);
    assert.ok(Array.isArray(out));
    const reading = out[0].payload;
    assert.strictEqual(reading.pv_power_kw, 1.544);
    assert.strictEqual(reading.battery_power_kw, 2.4);
    assert.ok(typeof reading.ts === 'string');
    assert.strictEqual(out[1].payload, true); // Link-Lebenszeichen
  } finally {
    server.close();
  }
});

// --- AISWEI-Registerkarte ----------------------------------------------------

test('NH3: der Leser bedient BEIDE Tabellen (FC4 Input + FC3 Holding)', async () => {
  const t = nh3Tables();
  const { server, port } = await startNh3(t.input, t.holding);
  try {
    const read = aiswei.makeAisweiReader({ net });
    const out = await read({ ip: '127.0.0.1', port, unitId: 1 });
    assert.strictEqual(out.reading.pv_power_kw, 5.4);
    assert.strictEqual(out.reading.power_kw, -0.5); // aus dem HOLDING-Block
    assert.strictEqual(out.reading.soc_pct, 78.3);
    assert.strictEqual(out.battKw, 3); // laden -> positiv
    assert.strictEqual(out.meta.rated_power, 12000);
  } finally {
    server.close();
  }
});

test('NH3: faellt der Holding-Block aus, fehlt NUR das Netz (Fehler-Isolation je Block)', async () => {
  const t = nh3Tables();
  const { server, port } = await startNh3(t.input, new Map()); // Holding antwortet mit Exception
  try {
    const read = aiswei.makeAisweiReader({ net });
    const out = await read({ ip: '127.0.0.1', port, unitId: 1 });
    assert.strictEqual(out.reading.pv_power_kw, 5.4);
    assert.strictEqual('power_kw' in out.reading, false);
    assert.strictEqual(out.battKw, 3);
  } finally {
    server.close();
  }
});

test('NH3: eine tote Adresse endet in null (idle-sicher)', async () => {
  const read = aiswei.makeAisweiReader({ net, connectTimeoutMs: 300 });
  assert.strictEqual(await read({ ip: '127.0.0.1', port: 1, unitId: 1 }), null);
});

test('der FLOW-Knoten liest den NH3 ueber seine Registerkarte', async () => {
  const t = nh3Tables();
  const { server, port } = await startNh3(t.input, t.holding);
  try {
    const msg = {
      aiswei: {
        conn: { ip: '127.0.0.1', port, unit_id: 1, invert_grid_sign: false, invert_batt_sign: false },
        reads: aiswei.planReads({ family: 'kaco_nh3' }),
      },
    };
    const out = await runFunctionNode(byId['auto-kaco-nh3'].func, msg);
    assert.ok(Array.isArray(out));
    assert.strictEqual(out[0].payload.pv_power_kw, 5.4);
    assert.strictEqual(out[0].payload.power_kw, -0.5);
    assert.strictEqual(out[0].payload.battery_power_kw, 3);
    assert.strictEqual(out[1].payload, true);
  } finally {
    server.close();
  }
});

// --- Verbindungstest ---------------------------------------------------------

test('„Verbindung testen": der KACO-Test gibt die GEFUNDENE Seriennummer zurueck', async () => {
  const { server, port } = await startStick();
  try {
    const readOnce = require('./test-read').makeReadOnce({
      deye: require('./deye/deye-decode'), modbus: require('./modbus-tcp'),
      fronius: require('./fronius/solar-api'), solarman: require('./deye/solarman-v5'),
      sunspec: require('./sunspec/sunspec-live'), discovery: require('./sunspec/model-discovery'),
      goe: require('./goe/goe-api'), kostal: require('./kostal/kostal-decode'),
      kaco: kacoHttp, aiswei, net, http, https,
    });
    const res = await readOnce({
      brand: 'kaco', family: 'kaco_http_hybrid', communication: 'kaco_http',
      connection: { ip: '127.0.0.1', port },
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.serial, 'B1234567890');
    assert.strictEqual(res.reading.pv_kw, 1.544);
    assert.strictEqual(res.reading.soc_pct, 78);
  } finally {
    server.close();
  }
});

test('„Verbindung testen": eine abgewiesene NH3-Adresse heisst unreachable, nicht „kaputte Antwort"', async () => {
  const readOnce = require('./test-read').makeReadOnce({
    deye: require('./deye/deye-decode'), modbus: require('./modbus-tcp'),
    fronius: require('./fronius/solar-api'), solarman: require('./deye/solarman-v5'),
    sunspec: require('./sunspec/sunspec-live'), discovery: require('./sunspec/model-discovery'),
    goe: require('./goe/goe-api'), kostal: require('./kostal/kostal-decode'),
    kaco: kacoHttp, aiswei, net, http, https, connectTimeoutMs: 300,
  });
  const res = await readOnce({
    brand: 'kaco', family: 'kaco_nh3', communication: 'kaco_modbus',
    connection: { ip: '127.0.0.1', port: 1 },
  });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error_code, 'unreachable');
});
