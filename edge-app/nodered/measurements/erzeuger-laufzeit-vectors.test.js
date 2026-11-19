'use strict';

/**
 * Die gemeinsamen Laufzeit-Vektoren des Erzeuger-Wegs muessen aus den AKTUELLEN Modulen der
 * Palette entstehen (measurement-runtime.js, erzeuger-*.js, vp-modbus-probe.js). Laeuft eines davon
 * der Datei davon, faellt dieser Test - und der Go-Zwilling (edge-app/core/internal/erzeugerbild)
 * prueft sich weiter gegen den alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/measurements/erzeuger-laufzeit-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./erzeuger-laufzeit-vectors.gen.js');

test('erzeuger-laufzeit-vectors.json entspricht den aktuellen Modulen der Palette', async () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(committed, await gen.build(),
    'erzeuger-laufzeit-vectors.json ist veraltet - node measurements/erzeuger-laufzeit-vectors.gen.js '
    + 'ausfuehren und das Ergebnis committen');
});

test('die Faelle decken Messplan, Melde-Regel, Ereignisse, Standort-Sample und Kopfpruefung', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  const topics = new Set(data.laufzeit.flatMap((f) => f.expected.takte
    .flatMap((t) => t.nachrichten.map((m) => m.topic.replace(/^edge\/sources\/[^/]+\//, 'edge/sources/*/')))));
  assert.deepStrictEqual([...topics].sort(),
    ['edge/events', 'edge/measurements/samples', 'edge/sources/*/telemetry']);
  const arten = new Set(data.laufzeit.flatMap((f) => f.expected.takte.flatMap((t) => t.nachrichten
    .filter((m) => m.topic === 'edge/events').map((m) => m.payload.art))));
  assert.deepStrictEqual([...arten].sort(), ['device_restart', 'frozen_source']);
  const gruende = new Set(data.laufzeit.flatMap((f) => f.expected.status.rejected.map((r) => r.reason)));
  for (const g of ['unknown_point', 'invalid_cadence', 'driver_unavailable', 'binding_unavailable']) {
    assert.ok(gruende.has(g), g);
  }
  assert.ok(data.kopfpruefung.some((f) => f.expected.results.some((r) => r.ok === false)));
  assert.ok(data.kopfpruefung.some((f) => f.expected.results.some((r) => r.erzeuger_kopf
    && r.erzeuger_kopf.direktvermarkter_name === '')));
});
