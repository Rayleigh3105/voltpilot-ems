'use strict';

/**
 * Erzeugt kaco-http-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * KACO-Leser ueber die App-Schnittstelle (HTTP 8484) der Docker-Box
 * (kaco-http.js, Quelle der Wahrheit; Flow und Quellen-Executor betten das
 * Modul ein) und seinem Go-Zwilling in Edge Light
 * (edge-app/core/internal/kacohttp).
 *
 * Neben URLs, Inventar und Decodierung wird der ganze Lesezyklus
 * (makeKacoHttpReader) gegen ein nachgebautes http-Modul gefahren: je Fall die
 * Antworten je URL (Status + Text, oder ausbleibend/abgewiesen), festgehalten
 * die abgerufenen URLs in Aufruf-Reihenfolge und das Ergebnis.
 *
 *   node edge-app/nodered/kaco/kaco-http-vectors.gen.js
 */

const fs = require('fs');
const path = require('path');
const K = require('./kaco-http.js');

const OUT = path.join(__dirname, 'kaco-http-vectors.json');

const urls = [];
for (const serial of ['B1234567890', 'SN 12/3?&=#ä', '', null, 42, ' x ']) {
  urls.push({ scheme: 'http', host: '192.168.1.50', port: 8484, serial,
    inventory: K.inventoryUrl('http', '192.168.1.50', 8484),
    devdata: [2, 3, 4].map((d) => K.devDataUrl('http', '192.168.1.50', 8484, d, serial)) });
}

const inventories = [
  '{"inv":[{"isn":"B1234567890","add":3,"rate":10000}]}',
  '{"inv":[{"isn":"  B2  ","add":"4","rate":"5000"},{"isn":"B3"}]}',
  '{"inv":[{"isn":""},{"add":1},null,5,{"isn":7},{"isn":"B4","add":"x","rate":""}]}',
  '{"inv":{}}', '{}', '[]', 'null', 'kein json', '',
].map((raw) => ({ raw, inventory: K.parseInventory(raw) }));

const J = (o) => JSON.stringify(o);
const decodes = [];
const parts = [
  ['NX3 tagsueber', 'kaco_http', { inverter: J({ pac: 7350, fac: 4998, tmp: 412, eto: 123456, etd: 287, err: 0 }), meter: J({ pac: -5100 }) }],
  ['NX3 Nacht (negatives pac)', 'kaco_http', { inverter: J({ pac: -8, fac: 5001 }), meter: J({ pac: 350 }) }],
  ['NH3 PV aus den Strings', 'kaco_http_hybrid', { inverter: J({ pac: 4800, vpv: [3850, 4120], ipv: [612, 503] }), meter: J({ pac: -900 }), battery: J({ pb: -2100, soc: 64, vb: 5124, cb: -41, soh: 99, cst: 1, bst: 2 }) }],
  ['NH3 Strings ungleich lang', 'kaco_http_hybrid', { inverter: J({ pac: 4800, vpv: [3850, 4120], ipv: [612] }), battery: J({ pb: 500, soc: 20 }) }],
  ['NH3 String mit null', 'kaco_http_hybrid', { inverter: J({ pac: 4800, vpv: [3850, null], ipv: [612, 3] }) }],
  ['NH3 Strings leer', 'kaco_http_hybrid', { inverter: J({ pac: 4800, vpv: [], ipv: [] }) }],
  ['NH3 Strings als Text', 'kaco_http_hybrid', { inverter: J({ vpv: ['3850', ' 4120 '], ipv: ['612', '0x1F4'] }) }],
  ['Werte als Text', 'kaco_http', { inverter: J({ pac: ' 1200 ', fac: '4999', tmp: '', eto: 'x' }), meter: J({ pac: '-300' }) }],
  ['nur Zaehler', 'kaco_http', { meter: J({ pac: 1234.5 }) }],
  ['Zaehler ohne pac', 'kaco_http', { meter: J({ p: 1 }) }],
  ['nur Batterie: SoC 0 faellt, pb 0 bleibt', 'kaco_http_hybrid', { battery: J({ pb: 0, soc: 0 }) }],
  ['Batterie SoC 100,04', 'kaco_http_hybrid', { battery: J({ soc: 100.04 }) }],
  ['Batterie nur Meta', 'kaco_http_hybrid', { battery: J({ vb: 5000 }) }],
  ['Wechselrichter nur Meta', 'kaco_http', { inverter: J({ fac: 5000 }) }],
  ['unbekannte Familie = String-Geraet', 'kaco_bogus', { inverter: J({ pac: 900 }) }],
  ['Rundung halb', 'kaco_http', { inverter: J({ pac: 1234.5, tmp: 335, eto: 35 }), meter: J({ pac: -0.5 }) }],
  ['Antworten sind keine Objekte', 'kaco_http', { inverter: '[1,2]', meter: 'null', battery: '"text"' }],
  ['Zahl ausserhalb von float64', 'kaco_http', { inverter: '{"pac":1e400,"fac":5000}', meter: '{"pac":12}' }],
  ['nichts', 'kaco_http', {}],
];
for (const [name, family, p] of parts) {
  for (const flags of [{}, { invertGridSign: true, invertBattSign: true }]) {
    const opts = Object.assign({ family }, flags);
    decodes.push({ name, parts: { inverter: p.inverter === undefined ? null : p.inverter, meter: p.meter === undefined ? null : p.meter,
      battery: p.battery === undefined ? null : p.battery }, opts, decode: K.decode(p, opts) });
  }
}

// --- Lesezyklen gegen ein nachgebautes http-Modul -----------------------------
function fakeHttp(responses, calls) {
  return {
    get(url, opts, cb) {
      calls.push(url);
      const handlers = {};
      let timeoutFn = null;
      const req = {
        setTimeout(ms, fn) { timeoutFn = fn; return req; },
        on(ev, fn) { handlers[ev] = fn; return req; },
        destroy() {},
      };
      setImmediate(() => {
        const r = responses[url];
        if (r === undefined || r === 'timeout') return timeoutFn && timeoutFn();
        if (r === 'refused') return handlers.error && handlers.error(new Error('ECONNREFUSED'));
        const res = { statusCode: r.status, resume() {}, setEncoding() {}, on(ev, fn) { res['_' + ev] = fn; return res; } };
        cb(res);
        setImmediate(() => { if (res._data && r.body) res._data(r.body); if (res._end) res._end(); });
      });
      return req;
    },
  };
}

const base = 'http://10.0.0.9:8484';
const inv = base + '/getdev.cgi?device=2';
const dd = (d, sn) => base + '/getdevdata.cgi?device=' + d + '&sn=' + encodeURIComponent(sn);
const ok = (o) => ({ status: 200, body: typeof o === 'string' ? o : J(o) });
const scenarios = [
  ['ohne Seriennummer: Inventar, dann Messwerte', { family: 'kaco_http' },
    { [inv]: ok({ inv: [{ isn: 'B77', add: 3 }, { isn: 'B78' }] }), [dd(2, 'B77')]: ok({ pac: 3000 }), [dd(3, 'B77')]: ok({ pac: -2000 }) }],
  ['mit Seriennummer kein Inventar', { family: 'kaco_http', serial: ' B9 ' },
    { [dd(2, 'B9')]: ok({ pac: 500 }), [dd(3, 'B9')]: ok({ pac: 100 }) }],
  ['Hybrid fragt den Speicher', { family: 'kaco_http_hybrid', serial: 'H1' },
    { [dd(2, 'H1')]: ok({ vpv: [4000], ipv: [500] }), [dd(3, 'H1')]: ok({ pac: 10 }), [dd(4, 'H1')]: ok({ pb: -1500, soc: 50 }) }],
  ['hasBattery uebersteuert die Familie', { family: 'kaco_http', serial: 'H2', hasBattery: true },
    { [dd(2, 'H2')]: ok({ pac: 1 }), [dd(4, 'H2')]: ok({ soc: 30 }) }],
  ['leeres Inventar: keine Messung', { family: 'kaco_http' }, { [inv]: ok({ inv: [] }) }],
  ['Inventar antwortet nicht', { family: 'kaco_http' }, { [inv]: 'timeout' }],
  ['Nacht: Wechselrichter ausbleibend, Zaehler da', { family: 'kaco_http', serial: 'N1' },
    { [dd(2, 'N1')]: 'timeout', [dd(3, 'N1')]: ok({ pac: 400 }) }],
  ['HTTP 500 und abgewiesen', { family: 'kaco_http_hybrid', serial: 'E1' },
    { [dd(2, 'E1')]: { status: 500, body: '{"pac":1}' }, [dd(3, 'E1')]: 'refused', [dd(4, 'E1')]: ok({ soc: 77, pb: 12 }) }],
  ['HTTP 204 zaehlt nicht', { family: 'kaco_http', serial: 'E2' }, { [dd(2, 'E2')]: { status: 204, body: '{"pac":1}' }, [dd(3, 'E2')]: ok({ pac: 9 }) }],
  ['alles ausbleibend', { family: 'kaco_http', serial: 'D1' }, {}],
  ['Seriennummer mit Sonderzeichen', { family: 'kaco_http', serial: 'A B/C' }, { [dd(2, 'A B/C')]: ok({ pac: 2500 }) }],
  ['Vorzeichen-Auswege', { family: 'kaco_http_hybrid', serial: 'S1', invertGridSign: true, invertBattSign: true },
    { [dd(2, 'S1')]: ok({ vpv: [4000], ipv: [500] }), [dd(3, 'S1')]: ok({ pac: -700 }), [dd(4, 'S1')]: ok({ pb: -1500 }) }],
];

async function main() {
  const reads = [];
  for (const [name, t, responses] of scenarios) {
    const calls = [];
    const read = K.makeKacoHttpReader({ http: fakeHttp(responses, calls), https: fakeHttp(responses, calls), timeoutMs: 50 });
    const target = Object.assign({ ip: '10.0.0.9', port: 8484 }, t);
    const result = await read(target);
    reads.push({ name, target, responses, calls, result: result === undefined ? null : result });
  }
  const out = {
    _comment: [
      'GENERIERT von kaco-http-vectors.gen.js aus kaco-http.js - nicht von Hand bearbeiten.',
      'Gepruefte Seiten: kaco-http-vectors.test.js (JS) und edge-app/core/internal/kacohttp (Go, Edge Light).',
      'reads.responses: je URL {status, body}, "timeout" (keine Antwort) oder "refused" (Verbindung abgewiesen); fehlende URL = keine Antwort.',
    ],
    families: K.FAMILIES,
    default_port: K.DEFAULT_PORT,
    urls, inventories, decodes, reads,
  };
  return JSON.stringify(out) + '\n';
}

if (require.main === module) {
  main().then((text) => {
    fs.writeFileSync(OUT, text);
    console.log('geschrieben: ' + OUT + ' (' + decodes.length + ' Decodierungen, ' + scenarios.length + ' Lesezyklen, ' + Math.round(text.length / 1024) + ' KiB)');
  });
}
module.exports = { build: main, OUT };
