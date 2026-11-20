'use strict';

/**
 * Die gemeinsamen Vektoren des WAGO-Registerbilds muessen aus den AKTUELLEN
 * wago-*.js-Modulen und dem Simulator-Store entstehen; sonst prueft sich der
 * Go-Zwilling (edge-app/core/internal/wagobild) gegen einen alten Stand.
 *
 *   node edge-app/nodered/measurements/wago-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./wago-vectors.gen.js');

test('wago-vectors.json entspricht den wago-*.js-Modulen', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), gen.build(),
    'wago-vectors.json ist veraltet - node measurements/wago-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('die Folgen treffen Neustart, eingefrorenen Herzschlag und Bereichsgrenze', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  const arten = new Set(data.folgen.flatMap((f) => f.lesungen.flatMap((l) => l.ereignisse.map((e) => e.payload.art))));
  for (const a of ['device_restart', 'frozen_source', 'range_limit']) assert.ok(arten.has(a), a);
});
