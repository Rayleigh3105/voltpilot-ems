'use strict';

/**
 * Die gemeinsamen Fronius-Vektoren muessen aus dem AKTUELLEN solar-api.js
 * entstehen. Laeuft das Modul der Datei davon, faellt dieser Test - und der
 * Go-Zwilling (edge-app/core/internal/froniusapi) prueft sich weiter gegen den
 * alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/fronius/solar-api-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./solar-api-vectors.gen.js');

test('solar-api-vectors.json entspricht dem aktuellen solar-api.js', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), gen.build(),
    'solar-api-vectors.json ist veraltet - node fronius/solar-api-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('die Faelle decken Messung, keine Messung und kein JSON ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.some((c) => c.decode && c.decode.reading.soc_pct !== undefined));
  assert.ok(data.cases.some((c) => c.json && c.decode === null));
  assert.ok(data.cases.some((c) => !c.json));
});
