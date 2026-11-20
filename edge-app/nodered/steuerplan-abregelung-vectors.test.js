'use strict';

/**
 * Die gemeinsamen Vektoren der Fronius-Abregelung muessen aus dem AKTUELLEN
 * sunspec/curtail.js, curtail-lease.js, model-discovery.js und den Knoten
 * "PV-Abregelung / Schreibplan" und "Fronius WMaxLimPct schreiben +
 * zuruecklesen" aus flows.json entstehen; der Go-Zwilling
 * (edge-app/core/internal/steuerplan, abregel_*.go) prueft sich dagegen.
 *
 *   node edge-app/nodered/steuerplan-abregelung-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./steuerplan-abregelung-vectors.gen.js');

test('steuerplan-abregelung-vectors.json entspricht Modulen und Knoten', async () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), await gen.build(),
    'steuerplan-abregelung-vectors.json ist veraltet - node steuerplan-abregelung-vectors.gen.js ausfuehren und das Ergebnis committen');
});

test('die Kette deckt Erkennung, Schreiben, Auffrischen, Freigeben, Verwerfen, Wirkung und Fehler ab', () => {
  const ticks = JSON.parse(fs.readFileSync(gen.OUT, 'utf8')).kette.flatMap((c) => c.ticks);
  const payloads = ticks.flatMap((t) => t.payloads);
  const has = (pred, what) => assert.ok(payloads.some(pred), what);
  has((p) => p.reason === 'SunSpec-Modelle erkannt - der naechste Takt plant', 'Erkennung');
  has((p) => p.applied === true && p.all_match === true && p.mode === 'apply', 'Begrenzung geschrieben und bestaetigt');
  has((p) => p.applied === true && p.mode === 'release', 'Freigabe geschrieben');
  has((p) => p.applied === false && p.all_match === true, 'nur beobachtet');
  has((p) => p.all_match === false, 'Abweichung');
  has((p) => p.blocked === true && /verwirft/.test(p.reason || ''), 'Befehl dauerhaft verworfen');
  has((p) => p.enforcement && p.enforcement.possible_override === true, 'moeglicher Override');
  has((p) => /Gateway nicht erreichbar/.test(p.reason || ''), 'Gateway weg');
  has((p) => /Schreiben fehlgeschlagen/.test(p.reason || ''), 'Schreibfehler');
  has((p) => /Modell 123/.test(p.reason || ''), 'Modell 123 fehlt');
  assert.ok(ticks.some((t) => t.ops.some((o) => o.op === 'write16')), 'FC16-Block');
  assert.ok(ticks.some((t) => t.ops.some((o) => o.op === 'write6')), 'FC6-Rueckfall');
});
