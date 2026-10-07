'use strict';

/**
 * Die gemeinsamen Deye-Vektoren muessen aus dem AKTUELLEN deye-decode.js
 * entstehen. Laeuft das Modul der Datei davon, faellt dieser Test - und der
 * Go-Zwilling (edge-app/core/internal/deyedecode) prueft sich weiterhin gegen
 * den alten Stand, bis jemand den Generator ausfuehrt. Beides zusammen haelt
 * Node-RED und Edge Light deckungsgleich.
 *
 *   node edge-app/nodered/deye/deye-decode-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./deye-decode-vectors.gen.js');

test('deye-decode-vectors.json entspricht dem aktuellen deye-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'deye-decode-vectors.json ist veraltet - node deye/deye-decode-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('jeder Fall traegt eine Erwartung fuer decode und decodeVerbose', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.length >= 20, 'zu wenige Faelle');
  for (const c of data.cases) {
    assert.ok('decode' in c && 'verbose' in c, c.name);
  }
});
