'use strict';

/**
 * Die gemeinsamen KACO-HTTP-Vektoren muessen aus dem AKTUELLEN kaco-http.js
 * entstehen. Laeuft das Modul der Datei davon, faellt dieser Test - und der
 * Go-Zwilling (edge-app/core/internal/kacohttp) prueft sich weiter gegen den
 * alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/kaco/kaco-http-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./kaco-http-vectors.gen.js');

test('kaco-http-vectors.json entspricht dem aktuellen kaco-http.js', async () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), await gen.build(),
    'kaco-http-vectors.json ist veraltet - node kaco/kaco-http-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('die Lesezyklen decken Inventar, Speicher und Ausfaelle ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.reads.some((r) => r.calls[0].includes('/getdev.cgi')));
  assert.ok(data.reads.some((r) => r.calls.some((c) => c.includes('device=4'))));
  assert.ok(data.reads.some((r) => r.result === null));
});
