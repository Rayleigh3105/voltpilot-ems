'use strict';

/**
 * Die gemeinsamen go-e-Vektoren muessen aus dem AKTUELLEN goe-api.js
 * entstehen. Laeuft das Modul der Datei davon, faellt dieser Test - und der
 * Go-Zwilling (edge-app/core/internal/goeapi) prueft sich weiterhin gegen den
 * alten Stand, bis jemand den Generator ausfuehrt. Beides zusammen haelt
 * Node-RED und Edge Light deckungsgleich.
 *
 *   node edge-app/nodered/goe/goe-api-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./goe-api-vectors.gen.js');

test('goe-api-vectors.json entspricht dem aktuellen goe-api.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'goe-api-vectors.json ist veraltet - node goe/goe-api-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('die Vektoren decken Messwert, abwesenden Wert, kein Objekt und kaputtes JSON ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  const cases = data.cases;
  assert.ok(cases.length >= 30, 'zu wenige Faelle');
  assert.ok(cases.some((c) => c.decode && typeof c.decode.reading.load_kw === 'number'), 'kein Fall mit Messwert');
  assert.ok(cases.some((c) => c.decode && !('load_kw' in c.decode.reading)), 'kein Fall mit abwesendem Wert');
  assert.ok(cases.some((c) => 'decode' in c && c.decode === null), 'kein Fall ohne Objekt');
  assert.ok(cases.some((c) => c.parse_error === true), 'kein Fall mit kaputtem JSON');
});
