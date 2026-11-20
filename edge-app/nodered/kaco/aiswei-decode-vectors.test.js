'use strict';

/**
 * Die gemeinsamen KACO-NH3-Vektoren (AISWEI) muessen aus dem AKTUELLEN
 * aiswei-decode.js entstehen. Laeuft das Modul der Datei davon, faellt
 * dieser Test - und der Go-Zwilling (edge-app/core/internal/aiswei) prueft
 * sich weiterhin gegen den alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/kaco/aiswei-decode-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./aiswei-decode-vectors.gen.js');

test('aiswei-decode-vectors.json entspricht dem aktuellen aiswei-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'aiswei-decode-vectors.json ist veraltet - node kaco/aiswei-decode-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('die Faelle decken Messung und keine Messung ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.some((c) => c.decode && c.decode.reading.power_kw !== undefined));
  assert.ok(data.cases.some((c) => c.decode === null));
});
