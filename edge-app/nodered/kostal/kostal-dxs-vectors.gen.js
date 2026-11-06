'use strict';

/**
 * Erzeugt kostal-dxs-vectors.json: die GEMEINSAMEN Testvektoren zwischen
 * kostal-dxs-decode.js (Node-RED, Quelle der Wahrheit) und seinem Go-Zwilling
 * edge-app/core/internal/kostaldxs (Edge Light).
 *
 * Muster von kaco-serial-vectors.gen.js: die erwarteten Ausgaben entstehen
 * aus dem JS-Modul selbst, nie von Hand. Wer kostal-dxs-decode.js aendert,
 * fuehrt dieses Skript aus und committet die neue Datei:
 *
 *   node edge-app/nodered/kostal/kostal-dxs-vectors.gen.js
 *
 * Eingabe jedes Falls ist der ROHE Antworttext, wie `/api/dxs.json` ihn
 * liefert - so pruefen beide Seiten dieselbe JSON-Form, dieselbe
 * dxsId-statt-Position-Regel und dieselbe Text/Zahl-Trennung.
 */

const fs = require('fs');
const path = require('path');
const K = require('./kostal-dxs-decode.js');

const OUT = path.join(__dirname, 'kostal-dxs-vectors.json');

function response(entries, opts) {
  opts = opts || {};
  const body = { dxsEntries: entries.map(([dxsId, value]) => ({ dxsId, value })) };
  if (opts.session !== false) body.session = { sessionId: 0, roleId: 0 };
  if (opts.statusCode !== undefined) body.status = { code: opts.statusCode };
  else body.status = { code: 0 };
  return JSON.stringify(body);
}

const EXAMPLE_ENTRIES = [
  [K.DXS.AC_POWER_W, 12505.64], [K.DXS.DC_POWER_TOTAL_W, 12700],
  [K.DXS.DC1_A, 12.1], [K.DXS.DC1_V, 365.4], [K.DXS.DC1_W, 4420],
  [K.DXS.DC2_A, 11.8], [K.DXS.DC2_V, 364.9], [K.DXS.DC2_W, 4280],
  [K.DXS.L1_A, 9.1], [K.DXS.L1_V, 231.2], [K.DXS.L1_W, 2100],
  [K.DXS.L2_A, 9.0], [K.DXS.L2_V, 230.8], [K.DXS.L2_W, 2080],
  [K.DXS.L3_A, 8.9], [K.DXS.L3_V, 231.5], [K.DXS.L3_W, 2060],
  [K.DXS.FREQ_HZ, 50.01], [K.DXS.COS_PHI, 1], [K.DXS.LIMITATION_PCT, 70],
  [K.DXS.STATUS, 3], [K.DXS.ENERGY_TOTAL_KWH, 32965.3], [K.DXS.ENERGY_TODAY_WH, 222.07],
  [K.DXS.OPERATING_HOURS_H, 33919], [K.DXS.TYPE, 'PIKO 20'], [K.DXS.SERIAL, '12345678'],
  [K.DXS.NAME, 'Dach Sued'], [K.DXS.FW_VERSION, '06.17'], [K.DXS.HW_VERSION, '01.08'],
  [K.DXS.UI_VERSION, '06.53'], [K.DXS.PAR_VERSION, '01.02'],
];

const cases = [
  { name: 'volle Antwort (angelehnt an den Report, 5-s-Takt belegt)', raw: response(EXAMPLE_ENTRIES) },
  { name: 'nur die AC-Leistung (Kundenaltsystem liest genau dies alle 5 s)', raw: response([[K.DXS.AC_POWER_W, 1234.5]]) },
  { name: 'AC-Leistung negativ nachts (Eigenverbrauch der Elektronik)', raw: response([[K.DXS.AC_POWER_W, -2.1]]) },
  { name: 'AC-Leistung 0', raw: response([[K.DXS.AC_POWER_W, 0]]) },
  { name: 'Status 0 (Aus, Nacht)', raw: response([[K.DXS.STATUS, 0]]) },
  { name: 'Status 4 (Einspeisen, abgeregelt)', raw: response([[K.DXS.STATUS, 4]]) },
  { name: 'unbekannter Status-Code 9: benannt statt verschluckt', raw: response([[K.DXS.STATUS, 9]]) },
  { name: 'Tagesertrag 0 ([DBUS]-Hinweis: manche Firmware liefert das)', raw: response([[K.DXS.ENERGY_TODAY_WH, 0]]) },
  { name: 'Begrenzung fehlt (kein Eintrag) - keine Begrenzung geraten', raw: response([[K.DXS.AC_POWER_W, 500]]) },
  { name: 'doppelte dxsId: der letzte Eintrag gewinnt', raw: response([[K.DXS.AC_POWER_W, 1], [K.DXS.AC_POWER_W, 2]]) },
  { name: 'Kennung an Position 0 ist NICHT die AC-Leistung (Altsystem-Fehler vermeiden)', raw: response([[K.DXS.ENERGY_TOTAL_KWH, 999], [K.DXS.AC_POWER_W, 42]]) },
  { name: 'Identitaetsfeld als Zahl statt Text zaehlt nicht', raw: response([[K.DXS.TYPE, 20]]) },
  { name: 'Identitaetsfeld leer/nur Leerzeichen zaehlt als abwesend', raw: response([[K.DXS.NAME, '   ']]) },
  { name: 'value ist null -> abwesend', raw: JSON.stringify({ dxsEntries: [{ dxsId: K.DXS.AC_POWER_W, value: null }], status: { code: 0 } }) },
  { name: 'value ist ein Objekt -> abwesend', raw: JSON.stringify({ dxsEntries: [{ dxsId: K.DXS.AC_POWER_W, value: {} }] }) },
  { name: 'dxsEntries leer -> kein Kanal, decode liefert null', raw: response([]) },
  { name: 'status.code fehlt -> wie 0 behandelt (Messwerte lesbar ohne Login)', raw: '{"dxsEntries":[{"dxsId":' + K.DXS.AC_POWER_W + ',"value":77}]}' },
  { name: 'kaputtes JSON -> null', raw: 'nicht json' },
  { name: 'kein dxsEntries-Array -> null', raw: '{"foo":1}' },
  { name: 'nur String/Phasen-Daten, keine AC-Leistung: meta gefuellt, reading leer', raw: response([[K.DXS.DC1_V, 365.4], [K.DXS.L1_W, 2100]]) },
];

function decodeFor(raw) {
  return K.decode(raw);
}

const out = {
  _comment: [
    'GENERIERT von kostal-dxs-vectors.gen.js aus kostal-dxs-decode.js - nicht von Hand bearbeiten.',
    'Gepruefte Seiten: kostal-dxs-decode.test.js (JS, direkt) und edge-app/core/internal/kostaldxs (Go, Edge Light).',
    'raw ist der rohe /api/dxs.json-Antworttext; decode ist K.decode(raw) darauf.',
  ],
  constants: {
    default_port: K.DEFAULT_PORT,
    dxs_path: K.DXS_PATH,
    dxs: K.DXS,
    status_labels: K.STATUS_LABELS,
    fast_ids: K.FAST_IDS,
    slow_ids: K.SLOW_IDS,
    identity_ids: K.IDENTITY_IDS,
    poll_ids: K.POLL_IDS,
    all_ids: K.ALL_IDS,
  },
  dxs_url: [
    { scheme: 'http', host: '192.168.1.122', port: 80, ids: [K.DXS.AC_POWER_W], url: K.dxsUrl('http', '192.168.1.122', 80, [K.DXS.AC_POWER_W]) },
    { scheme: 'http', host: '192.168.1.122', port: 80, ids: [K.DXS.AC_POWER_W, K.DXS.STATUS], url: K.dxsUrl('http', '192.168.1.122', 80, [K.DXS.AC_POWER_W, K.DXS.STATUS]) },
  ],
  cases: cases.map((c) => ({ name: c.name, raw: c.raw, decode: decodeFor(c.raw) })),
};

const textOut = JSON.stringify(out, null, 2) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, textOut);
  console.log('geschrieben: ' + OUT + ' (' + out.cases.length + ' Faelle)');
}

module.exports = { build: () => textOut, OUT };
