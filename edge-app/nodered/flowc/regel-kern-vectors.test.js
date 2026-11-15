'use strict';
// Der Gleichheitsbeleg Regel-Baukasten -> Kern bleibt aktuell: die Datei ist genau das, was der
// Generator aus diesem Compiler und dieser Palette erzeugt (regel-kern-vectors.gen.js). Ändert sich
// ein Funktionsknoten in catalog.js oder ein Palettenknoten, ändert sich die Datei, und der Kern
// muss in gleichheit_test.go erneut gleich entscheiden.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { baue, schreibe, OUT } = require('./regel-kern-vectors.gen');

test('regel-kern-vectors.json ist aktuell', () => {
  const frisch = schreibe(baue()) + '\n';
  const alt = fs.readFileSync(OUT, 'utf8');
  assert.ok(alt === frisch, 'regel-kern-vectors.json ist veraltet: node edge-app/nodered/flowc/regel-kern-vectors.gen.js');
});

test('jeder Fall wünscht etwas, und jede Abweichung hat einen bekannten Grund', () => {
  const v = baue();
  const gruende = new Set(['start', 'veraltet', 'preis_abgelaufen', 'raster', 'nachlauf']);
  for (const f of v.faelle) {
    assert.ok(f.nodered_wuensche > 0, f.name + ': der Flow wünscht nie etwas');
    for (const a of f.abweichungen) {
      assert.ok(gruende.has(a.grund), f.name + ': unbekannter Grund ' + a.grund);
      assert.ok(a.von < a.bis && a.bis <= f.dauer_s, f.name + ': Abschnitt ' + a.von + '-' + a.bis);
    }
  }
});
