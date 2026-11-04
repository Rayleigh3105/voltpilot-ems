'use strict';

/**
 * Die gemeinsamen Huawei-Vektoren muessen aus dem AKTUELLEN huawei-decode.js
 * entstehen. Laeuft das Modul der Datei davon, faellt dieser Test - und der
 * Go-Zwilling (edge-app/core/internal/huaweidecode) prueft sich weiterhin
 * gegen den alten Stand, bis jemand den Generator ausfuehrt. Beides zusammen
 * haelt Node-RED und Edge Light deckungsgleich.
 *
 *   node edge-app/nodered/huawei/huawei-decode-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./huawei-decode-vectors.gen.js');

test('huawei-decode-vectors.json entspricht dem aktuellen huawei-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'huawei-decode-vectors.json ist veraltet - node huawei/huawei-decode-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('jeder Fall traegt Bloecke, Optionen und eine Erwartung fuer decode', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.length >= 30, 'zu wenige Faelle');
  for (const c of data.cases) {
    assert.ok(Array.isArray(c.blocks) && 'opts' in c && 'decode' in c, c.name);
  }
  assert.deepStrictEqual(data.plan_reads.huawei_sun2000_luna, [[32064, 2], [32080, 2], [37113, 2], [37760, 7]]);
});
