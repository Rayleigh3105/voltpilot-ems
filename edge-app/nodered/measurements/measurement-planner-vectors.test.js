'use strict';

/**
 * Die gemeinsamen Vektoren des Planers muessen aus dem AKTUELLEN
 * measurement-planner.js und catalog.json entstehen; sonst prueft sich der
 * Go-Zwilling (edge-app/core/internal/messwerte) gegen einen alten Stand.
 *
 *   node edge-app/nodered/measurements/measurement-planner-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./measurement-planner-vectors.gen.js');

test('measurement-planner-vectors.json entspricht measurement-planner.js und catalog.json', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), gen.build(),
    'measurement-planner-vectors.json ist veraltet - node measurements/measurement-planner-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('die Planer-Vektoren treffen jeden Ausgang', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  const gruende = new Set(data.faelle.flatMap((c) => c.result.rejected.map((r) => r.reason)));
  for (const g of ['unsupported_catalog', 'unknown_point', 'invalid_cadence', 'binding_unavailable',
    'driver_unavailable', 'budget_duty_cycle', 'budget_requests', 'ocpp_configuration_incompatible']) {
    assert.ok(gruende.has(g), g);
  }
  assert.ok(data.faelle.some((c) => c.result.applied && c.result.metrics.warning));
  assert.ok(data.faelle.some((c) => (c.result.decoderPrerequisites || []).length));
});
