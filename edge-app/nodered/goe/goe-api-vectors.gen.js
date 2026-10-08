'use strict';

/**
 * Erzeugt goe-api-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * goe-api.js (Node-RED, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/goeapi (Edge Light).
 *
 * Das Muster von deye-decode-vectors.gen.js: Die erwarteten Ausgaben entstehen
 * nicht von Hand, sondern aus dem JS-Modul selbst. goe-api-vectors.test.js
 * rechnet sie bei jedem Lauf neu und schlaegt fehl, sobald Modul und Datei
 * auseinanderlaufen. Wer goe-api.js aendert, fuehrt dieses Skript aus und
 * committet die neue Datei; der Go-Test zeigt dann, ob der Zwilling mitziehen
 * muss.
 *
 *   node edge-app/nodered/goe/goe-api-vectors.gen.js
 *
 * Eingabe ist jeweils der ROHE Antworttext von /api/status (body), so wie ihn
 * der Flow per JSON.parse liest - damit pruefen beide Seiten auch, was beim
 * Parsen passiert (Text statt Zahl, kaputtes JSON, kein Objekt).
 */

const fs = require('fs');
const path = require('path');
const G = require('./goe-api.js');

const OUT = path.join(__dirname, 'goe-api-vectors.json');

// nrg: U(L1,L2,L3,N), I(L1,L2,L3), P(L1,L2,L3,N,Total), pf(L1,L2,L3,N).
const nrgWith = (total, perPhase) => {
  const p = perPhase || [0, 0, 0];
  return [232.1, 231.8, 232.5, 0, 16, 16.1, 15.9, p[0], p[1], p[2], 0, total, 99.9, 99.8, 99.7, 0];
};
const body = (obj) => JSON.stringify(obj);

const cases = [
  // --- die Fixtures aus goe-api.test.js ---------------------------------------
  { name: 'laedt 11,04 kW (chargingStatus)', body: body({ car: 2, alw: true, amp: 16, wh: 5321.4, nrg: nrgWith(11040, [3680, 3700, 3660]) }) },
  { name: 'fertig, Laden nicht erlaubt, echte 0 W (notChargingStatus)', body: body({ car: 4, alw: false, amp: 6, wh: 8000, nrg: [231, 231, 231, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }) },
  // --- am Geraet aufgezeichnet ------------------------------------------------
  {
    name: 'echte go-e V4, Firmware 59.4, Leerlauf (aufgezeichnet 03.10.2026)',
    body: '{"alw":true,"amp":16,"car":1,"wh":23980.87648,"nrg":[232.5,233.4299927,234.6699982,1.24000001,0,0,0,0,0,0,0,0,0,0,0,0]}',
  },
  // --- Leistung: Index, Einheit, Klemmung, Rundung ----------------------------
  { name: 'Index 11 ist die Summe, nicht eine Phase', body: body({ car: 2, nrg: nrgWith(7360, [3680, 3680, 0]) }) },
  { name: 'negative Leistung wird auf 0 geklemmt', body: body({ car: 2, nrg: nrgWith(-12) }) },
  { name: 'minus null', body: '{"car":1,"nrg":[0,0,0,0,0,0,0,0,0,0,0,-0,0,0,0,0]}' },
  { name: 'Rundung: 0,5 W', body: body({ car: 2, nrg: nrgWith(0.5) }) },
  { name: 'Rundung: 1,5 W', body: body({ car: 2, nrg: nrgWith(1.5) }) },
  { name: 'Rundung: 2,5 W', body: body({ car: 2, nrg: nrgWith(2.5) }) },
  { name: 'Rundung: 1004,5 W', body: body({ car: 2, nrg: nrgWith(1004.5) }) },
  { name: 'Rundung: 1234,5678 W', body: body({ car: 2, nrg: nrgWith(1234.5678) }) },
  { name: 'Rundung: 22080,4999 W', body: body({ car: 2, nrg: nrgWith(22080.4999) }) },
  { name: 'grosse Leistung 43,999999 kW', body: body({ car: 2, nrg: nrgWith(43999.999) }) },
  // --- abwesend ist keine Null ------------------------------------------------
  { name: 'kein nrg: load_kw fehlt, Zustand bleibt', body: body({ car: 2, alw: true }) },
  { name: 'nrg[11] null', body: '{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,null,0,0,0,0]}' },
  { name: 'nrg[11] als Text', body: '{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,"11040",0,0,0,0]}' },
  { name: 'nrg[11] als Wahrheitswert', body: '{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,true,0,0,0,0]}' },
  { name: 'nrg zu kurz', body: body({ car: 2, nrg: [230, 230] }) },
  { name: 'nrg ist ein Objekt', body: '{"car":2,"nrg":{"11":11040}}' },
  { name: 'nrg[11] ausserhalb von float64 (1e400)', body: '{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,1e400,0,0,0,0]}' },
  { name: 'nrg[11] -1e400', body: '{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,-1e400,0,0,0,0]}' },
  { name: 'nrg mit verschachteltem Unsinn davor', body: '{"car":2,"nrg":[[1],{"a":1},"x",null,true,0,0,0,0,0,0,3680.25,0,0,0,0]}' },
  // --- Fahrzeugzustand und Freigabe --------------------------------------------
  { name: 'car 0 (unbekannt/Fehler)', body: body({ car: 0, nrg: nrgWith(0) }) },
  { name: 'car 3 (wartet)', body: body({ car: 3, nrg: nrgWith(0) }) },
  { name: 'car 5 (Fehler)', body: body({ car: 5, nrg: nrgWith(0) }) },
  { name: 'car 6 (Initialisierung, Firmware 60.x) bleibt unknown', body: body({ car: 6, nrg: nrgWith(0) }) },
  { name: 'car null', body: '{"car":null,"nrg":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}' },
  { name: 'car als Text', body: '{"car":"2","alw":true}' },
  { name: 'car 2.0 (Zahl mit Nachkommastelle)', body: '{"car":2.0}' },
  { name: 'car 2.5', body: '{"car":2.5}' },
  { name: 'car 2e0', body: '{"car":2e0}' },
  { name: 'alw als Text bleibt null', body: '{"car":1,"alw":"true"}' },
  { name: 'alw als Zahl bleibt null', body: '{"car":1,"alw":1}' },
  { name: 'doppelter Schluessel: der letzte gilt', body: '{"car":1,"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,5,0,0,0,0]}' },
  { name: 'Leerraum um das Objekt', body: ' \n {"car": 2 , "alw": false} \n ' },
  { name: 'weitere Schluessel stoeren nicht', body: body({ car: 2, alw: true, amp: 16, wh: 1.5, frc: 0, psm: 0, nrg: nrgWith(3680.5), fwv: '59.4' }) },
  // --- kein Objekt: null ------------------------------------------------------
  { name: 'leeres Objekt', body: '{}' },
  { name: 'null', body: 'null' },
  { name: 'Zahl', body: '42' },
  { name: 'Text', body: '"status"' },
  { name: 'Array', body: '[{"car":2}]' },
  { name: 'Wahrheitswert', body: 'true' },
  // --- kein JSON: der Flow verwirft die Antwort ---------------------------------
  { name: 'leere Antwort', body: '' },
  { name: 'abgeschnittenes JSON', body: '{"car":2,"nrg":[0,0' },
  { name: 'HTML-Fehlerseite', body: '<h1>Not Found</h1>' },
  { name: 'Komma am Ende', body: '{"car":2,}' },
];

// JSON kennt kein undefined: weglassen, damit beide Seiten "abwesend" lesen.
const clean = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

function expectFor(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { parse_error: true };
  }
  return { decode: clean(G.decodeStatus(parsed)) };
}

const out = {
  _comment: [
    'GENERIERT von goe-api-vectors.gen.js aus goe-api.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: goe-api-vectors.test.js (JS) und edge-app/core/internal/goeapi (Go, Edge Light).',
    'body ist der rohe Antworttext von /api/status; parse_error = JSON.parse wirft (der Flow verwirft die Antwort).',
  ],
  constants: {
    status_path: G.STATUS_PATH,
    status_filter: G.STATUS_FILTER,
    nrg_total_power_idx: G.NRG_TOTAL_POWER_IDX,
    families: Object.keys(G.FAMILIES),
    car_states: G.CAR_STATES,
  },
  car_state: [0, 1, 2, 3, 4, 5, 6, -1, 2.5, null, '2', true].map((v) => ({ car: v, state: G.carState(v) })),
  status_url: [
    { host: '192.168.2.105', port: 80 },
    { host: '10.0.0.5', port: 8080 },
    { host: 'goe.local', port: null },
    { host: 'goe.local', port: 0 },
  ].map((c) => ({ host: c.host, port: c.port, url: G.statusUrl(c.host, c.port) })),
  cases: cases.map((c) => Object.assign({ name: c.name, body: c.body }, expectFor(c.body))),
};

const text = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, text);
  console.log('geschrieben: ' + OUT + ' (' + out.cases.length + ' Faelle)');
}

module.exports = { build: () => text, OUT };
