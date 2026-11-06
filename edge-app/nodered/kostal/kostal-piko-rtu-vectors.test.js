'use strict';

/**
 * Die gemeinsamen KOSTAL-RTU-Vektoren muessen aus dem AKTUELLEN
 * kostal-piko-rtu-decode.js entstehen. Laeuft das Modul der Datei davon,
 * faellt dieser Test - und der Go-Zwilling (edge-app/core/internal/kostalrtu)
 * prueft sich weiterhin gegen den alten Stand, bis jemand den Generator
 * ausfuehrt.
 *
 *   node edge-app/nodered/kostal/kostal-piko-rtu-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./kostal-piko-rtu-vectors.gen.js');

test('kostal-piko-rtu-vectors.json entspricht dem aktuellen kostal-piko-rtu-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'kostal-piko-rtu-vectors.json ist veraltet - node kostal/kostal-piko-rtu-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('jeder Fall traegt die gelesenen Bloecke und beide Modulantworten', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.length >= 6, 'zu wenige Faelle');
  for (const c of data.cases) {
    assert.ok('blocks' in c, c.name + ': blocks');
    assert.ok('decode' in c, c.name + ': decode');
    assert.ok('decode_verbose' in c, c.name + ': decode_verbose');
  }
  assert.ok(data.cases.some((c) => c.decode === null));
  assert.ok(data.cases.some((c) => c.decode && c.decode.reading && c.decode.reading.pv_power_kw !== undefined));
});
