'use strict';

/**
 * Erzeugt solar-api-vectors.json: die GEMEINSAMEN Testvektoren zwischen dem
 * Fronius-Solar-API-Leser der Docker-Box (solar-api.js, Quelle der Wahrheit;
 * der Flow traegt eine Kopie von decodePowerFlow) und seinem Go-Zwilling in
 * Edge Light (edge-app/core/internal/froniusapi).
 *
 * Jeder Fall ist der ROHE Antworttext von GetPowerFlowRealtimeData.fcgi, so
 * wie er ueber die Leitung kommt: der Flow macht JSON.parse(body) und gibt das
 * Ergebnis an decodePowerFlow - ein Text, der kein JSON ist, ergibt keine
 * Messung. Festgehalten wird, was decodePowerFlow daraus macht (null = keine
 * Messung).
 *
 *   node edge-app/nodered/fronius/solar-api-vectors.gen.js
 */

const fs = require('fs');
const path = require('path');
const FR = require('./solar-api.js');

const OUT = path.join(__dirname, 'solar-api-vectors.json');

const ok = { Head: { Status: { Code: 0 } } };
const body = (site, inverters, extra) => JSON.stringify(Object.assign({}, ok, extra || {},
  { Body: { Data: Object.assign({ Site: site }, inverters === undefined ? {} : { Inverters: inverters }) } }));

const raws = [
  ['GEN24 Hybrid tagsueber', body({ P_PV: 5300, P_Grid: -1200, P_Load: -900, P_Akku: -3200 }, { 1: { SOC: 62.44 } })],
  ['Netzbezug, Akku entlaedt', body({ P_PV: 0, P_Grid: 1834.5, P_Load: -2500.25, P_Akku: 665.75 }, { 1: { SOC: 41 } })],
  ['Wechselrichter schlaeft (P_PV null)', body({ P_PV: null, P_Grid: 420, P_Load: -420, P_Akku: null })],
  ['Nacht, alles null', body({ P_PV: null, P_Grid: null, P_Load: null, P_Akku: null })],
  ['ohne Akku (kein SOC)', body({ P_PV: 7120, P_Grid: -6000, P_Load: -1120 }, { 1: { DT: 1, P: 7120 } })],
  ['SOC 0 ist keine Antwort', body({ P_PV: 100, P_Grid: 0, P_Load: -100 }, { 1: { SOC: 0 } })],
  ['SOC 100 gilt, 100.04 nicht', body({ P_PV: 100 }, { 1: { SOC: 100 } })],
  ['SOC ueber 100', body({ P_PV: 100 }, { 1: { SOC: 100.04 } })],
  ['SOC als Text', body({ P_PV: 100 }, { 1: { SOC: '55' } })],
  ['Inverters ohne "1"', body({ P_PV: 100 }, { 2: { SOC: 55 } })],
  ['negatives P_PV klemmt auf 0', body({ P_PV: -12, P_Grid: 12 })],
  ['positives P_Load klemmt auf 0', body({ P_Load: 300 })],
  ['P_Grid als Text zaehlt nicht', body({ P_Grid: '1200', P_PV: 10 })],
  ['Rundung halb', body({ P_PV: 1234.5, P_Grid: -0.5, P_Load: -2.5 }, { 1: { SOC: 33.35 } })],
  ['Rundung negativ halb', body({ P_Grid: -1234.5 })],
  ['BadStatus', JSON.stringify({ Head: { Status: { Code: 8 } }, Body: { Data: { Site: { P_PV: 1 } } } })],
  ['Status-Code als Text gilt nicht als Fehler', JSON.stringify({ Head: { Status: { Code: '8' } }, Body: { Data: { Site: { P_PV: 1 } } } })],
  ['kein Head', JSON.stringify({ Body: { Data: { Site: { P_PV: 2 } } } })],
  ['kein Site', JSON.stringify({ Head: { Status: { Code: 0 } }, Body: { Data: {} } })],
  ['Site ist kein Objekt', JSON.stringify({ Body: { Data: { Site: 5 } } })],
  ['Data ist eine Liste', JSON.stringify({ Body: { Data: [] } })],
  ['Site ist eine Liste', JSON.stringify({ Body: { Data: { Site: [] } } })],
  ['Zahl ausserhalb von float64', '{"Body":{"Data":{"Site":{"P_PV":1e400,"P_Grid":5}}}}'],
  ['doppelter Schluessel: der letzte gilt', '{"Body":{"Data":{"Site":{"P_PV":1,"P_PV":2000}}}}'],
  ['kein JSON', '<html>404</html>'],
  ['leerer Text', ''],
  ['JSON null', 'null'],
  ['JSON-Zahl', '42'],
  ['Leerraum um das JSON', '  \n' + body({ P_PV: 10 }) + '\n '],
  ['Datamanager v0 (keine PowerFlow-Antwort)', JSON.stringify({ Head: { Status: { Code: 0 } }, Body: {} })],
];

const cases = [];
for (const [name, raw] of raws) {
  for (const invertGridSign of [false, true]) {
    let json;
    let parsed = true;
    try { json = JSON.parse(raw); } catch (e) { parsed = false; }
    const decode = parsed ? FR.decodePowerFlow(json, { invertGridSign }) : null;
    cases.push({ name, raw, invert_grid_sign: invertGridSign, json: parsed, decode });
  }
}

const urls = [['http', '192.168.1.40', 80], ['https', '10.0.0.5', 443], ['ftp', 'fronius', 8080], [undefined, 'fd00::7', 80]]
  .map(([scheme, host, port]) => ({ scheme: scheme === undefined ? null : scheme, host, port, url: FR.powerFlowUrl(scheme, host, port) }));

const out = {
  _comment: [
    'GENERIERT von solar-api-vectors.gen.js aus solar-api.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: solar-api-vectors.test.js (JS) und edge-app/core/internal/froniusapi (Go, Edge Light).',
    'raw ist der Antworttext; json=false heisst: JSON.parse scheitert, keine Messung.',
  ],
  power_flow_path: FR.POWER_FLOW_PATH,
  families: Object.keys(FR.FAMILIES),
  urls,
  cases,
};

const text = JSON.stringify(out, null, 1) + '\n';
if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + cases.length + ' Faelle)');
}
module.exports = { build: () => text, OUT };
