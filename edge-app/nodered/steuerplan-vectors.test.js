'use strict';

/**
 * Die gemeinsamen Vektoren der Schreibseite (Deye) muessen aus dem AKTUELLEN
 * inverter-control-routing.js, seinen eingebetteten Modulen und dem Knoten
 * "Steuerung / Schreibplan" aus flows.json entstehen. Laufen die Quellen der
 * Datei davon, faellt dieser Test - und der Go-Zwilling
 * (edge-app/core/internal/steuerplan) prueft sich weiterhin gegen den alten
 * Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/steuerplan-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./steuerplan-vectors.gen.js');

const veraltet = 'ist veraltet - node steuerplan-vectors.gen.js ausfuehren und das Ergebnis committen';

test('steuerplan-vectors.json entspricht den Modulen der Schreibseite', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT, 'utf8'), gen.build(), 'steuerplan-vectors.json ' + veraltet);
});

test('die Plan-Knoten-Vektoren entsprechen dem Knoten aus flows.json', () => {
  assert.strictEqual(fs.readFileSync(gen.OUT_KNOTEN, 'utf8'), gen.buildKnoten(false), 'steuerplan-knoten-vectors.json ' + veraltet);
  assert.strictEqual(fs.readFileSync(gen.OUT_AUTOMATIK, 'utf8'), gen.buildKnoten(true), 'steuerplan-automatik-vectors.json ' + veraltet);
});

test('die Vektoren decken Fernsteuerung, Zeitfenster, Rueckgabe, Automatik und Budget ab', () => {
  const plan = JSON.parse(fs.readFileSync(gen.OUT_KNOTEN, 'utf8')).plan
    .concat(JSON.parse(fs.readFileSync(gen.OUT_AUTOMATIK, 'utf8')).plan);
  const controls = plan.flatMap((c) => c.steps.map((s) => s.control)).filter(Boolean);
  const has = (pred, what) => assert.ok(controls.some(pred), what);
  has((c) => c.controlPath === 'remote' && c.writes.length > 0, 'Fernsteuerung mit Schreibbefehlen');
  has((c) => c.controlPath === 'tou' && c.writes.length > 0 && c.snapshotPlan, 'Zeitfenster mit Schnappschuss-Plan');
  has((c) => c.mode === 'release' && c.writes.length > 0, 'Rueckgabe');
  has((c) => c.mode === 'native' && c.writes.length > 0, 'Uebergabe an die Wechselrichter-Automatik');
  has((c) => c.touBudgetHold === true, 'Tagesbudget haelt');
  has((c) => c.pathHold === 'remote_proven', 'nachgewiesene Fernsteuerung haelt den Zeitfenster-Pfad an');
  has((c) => c.powerScaleSuppressed === true, 'unbestaetigte Leistungsskalierung');
  has((c) => c.gridTarget && c.writes.length > 0, 'netzseitiger Drossel-Slot');
  has((c) => c.gridTest && c.writes.length > 0, 'Netz-Sollwert-Test');
  has((c) => c.candidate === 'grid_zero', 'Ladeseite netzseitig');
  has((c) => c.candidate === 'own_config', 'Ladeseite Eigenkonfiguration');
  assert.ok(plan.some((c) => c.steps.length > 3), 'Folgen ueber mehrere Takte');
});
