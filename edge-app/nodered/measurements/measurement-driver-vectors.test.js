'use strict';

/**
 * Die gemeinsamen Vektoren des Lesetreibers muessen aus dem AKTUELLEN
 * measurement-driver.js und catalog.json entstehen. Laufen sie der Datei davon,
 * faellt dieser Test - und der Go-Zwilling (edge-app/core/internal/messwerte)
 * prueft sich weiterhin gegen den alten Stand, bis jemand den Generator
 * ausfuehrt.
 *
 *   node edge-app/nodered/measurements/measurement-driver-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./measurement-driver-vectors.gen.js');
const D = require('./measurement-driver.js');

test('measurement-driver-vectors.json entspricht measurement-driver.js und catalog.json', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), gen.build(),
    'measurement-driver-vectors.json ist veraltet - node measurements/measurement-driver-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('jede Dekodier-Signatur des Katalogs ist abgedeckt', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.strictEqual(data.catalog_version, D.catalogDocument.catalog_version);
  const gedeckt = new Set(data.register.map((c) => c.point_key));
  assert.ok(gedeckt.size > 900, 'zu wenige Signaturen');
  assert.ok(data.json.length > 10 && data.abgeleitet.length > 50 && data.aufloesen.length > 10);
});
