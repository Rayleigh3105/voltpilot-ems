'use strict';

/**
 * Die gemeinsamen KOSTAL-dxs-Vektoren muessen aus dem AKTUELLEN
 * kostal-dxs-decode.js entstehen. Laeuft das Modul der Datei davon, faellt
 * dieser Test - und der Go-Zwilling (edge-app/core/internal/kostaldxs) prueft
 * sich weiterhin gegen den alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/kostal/kostal-dxs-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./kostal-dxs-vectors.gen.js');

test('kostal-dxs-vectors.json entspricht dem aktuellen kostal-dxs-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'kostal-dxs-vectors.json ist veraltet - node kostal/kostal-dxs-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('jeder Fall traegt den rohen Antworttext und die Modulantwort', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.length >= 15, 'zu wenige Faelle');
  for (const c of data.cases) {
    assert.ok('raw' in c, c.name + ': raw');
    assert.ok('decode' in c, c.name + ': decode');
  }
  assert.ok(data.cases.some((c) => c.decode && c.decode.reading && c.decode.reading.pv_power_kw !== undefined));
  assert.ok(data.cases.some((c) => c.decode === null));
});
