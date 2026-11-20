'use strict';

/**
 * Die gemeinsamen Vektoren der Laufzeit muessen aus der AKTUELLEN
 * measurement-runtime.js entstehen; sonst prueft sich der Go-Zwilling
 * (edge-app/core/internal/messwerte) gegen einen alten Stand.
 *
 *   node edge-app/nodered/measurements/measurement-runtime-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./measurement-runtime-vectors.gen.js');

test('measurement-runtime-vectors.json entspricht measurement-runtime.js', async () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), await gen.build(),
    'measurement-runtime-vectors.json ist veraltet - node measurements/measurement-runtime-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('die Laufzeit-Vektoren treffen Proben, Fehler, Verwerfen und OCPP', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  const belege = data.faelle.flatMap((f) => f.protokoll.flatMap((p) => p.belege));
  for (const k of ['no_answer', 'implausible', 'invalid_response']) assert.ok(belege.some((b) => b.error_class === k), k);
  assert.ok(data.faelle.some((f) => f.protokoll.some((p) => p.ocpp_auftraege.length)));
});
