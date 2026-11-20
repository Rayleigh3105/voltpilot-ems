'use strict';

/**
 * Die gemeinsamen KOSTAL-PLENTICORE-Vektoren muessen aus dem AKTUELLEN
 * kostal-decode.js entstehen. Laeuft das Modul der Datei davon, faellt
 * dieser Test - und der Go-Zwilling (edge-app/core/internal/kostalplenticore) prueft
 * sich weiterhin gegen den alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/kostal/kostal-decode-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./kostal-decode-vectors.gen.js');

test('kostal-decode-vectors.json entspricht dem aktuellen kostal-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'kostal-decode-vectors.json ist veraltet - node kostal/kostal-decode-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('die Faelle decken Messung und keine Messung ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.some((c) => c.decode && c.decode.reading.power_kw !== undefined));
  assert.ok(data.cases.some((c) => c.decode === null));
});
