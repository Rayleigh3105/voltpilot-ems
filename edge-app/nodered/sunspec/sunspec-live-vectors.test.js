'use strict';

/**
 * Die gemeinsamen SunSpec-Vektoren muessen aus dem AKTUELLEN Lesepfad
 * (sunspec-live.js + model-discovery.js) entstehen. Laeuft er der Datei davon,
 * faellt dieser Test - und der Go-Zwilling (edge-app/core/internal/sunspeclive)
 * prueft sich weiterhin gegen den alten Stand, bis jemand den Generator
 * ausfuehrt. Beides zusammen haelt Node-RED und Edge Light deckungsgleich.
 *
 *   node edge-app/nodered/sunspec/sunspec-live-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./sunspec-live-vectors.gen.js');

test('sunspec-live-vectors.json entspricht dem aktuellen SunSpec-Lesepfad', async () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    await gen.build(),
    'sunspec-live-vectors.json ist veraltet - node sunspec/sunspec-live-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('jeder Fall traegt Registerkarte, Anfragen und Ergebnis; die drei echten KACO lesen PV', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.length >= 25, 'zu wenige Faelle');
  for (const c of data.cases) {
    assert.ok(Array.isArray(c.registers) && Array.isArray(c.requests) && 'read' in c, c.name);
    for (const r of c.requests) assert.ok(r[2] >= 1 && r[2] <= 125, c.name + ': FC3 hoechstens 125 Register');
  }
  const schramm = data.cases.filter((c) => c.name.startsWith('Schramm: '));
  assert.strictEqual(schramm.length, 3);
  for (const c of schramm) {
    assert.deepStrictEqual(c.requests.map((r) => r[1]), [40000, 40002, 40004, 40070, 40072, 40122], c.name);
    assert.ok(c.read && c.read.reading.pv_power_kw > 0, c.name);
    assert.strictEqual(c.read.meta.inverterModel, 103, c.name);
  }
});
