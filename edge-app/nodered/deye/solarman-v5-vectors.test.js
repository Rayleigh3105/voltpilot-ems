'use strict';

/**
 * Die gemeinsamen Solarman-V5-Vektoren muessen aus dem AKTUELLEN
 * solarman-v5.js entstehen (Gegenstueck: edge-app/core/internal/solarmanv5).
 *
 *   node edge-app/nodered/deye/solarman-v5-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./solarman-v5-vectors.gen.js');

test('solarman-v5-vectors.json entspricht dem aktuellen solarman-v5.js', () => {
  assert.strictEqual(
    fs.readFileSync(gen.OUT, 'utf8'),
    gen.build(),
    'solarman-v5-vectors.json ist veraltet - node deye/solarman-v5-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('die Vektoren decken Annahme UND Ablehnung ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.responses.some((r) => r.expect.regs), 'kein angenommener Antwortrahmen');
  assert.ok(data.responses.filter((r) => r.expect.error).length >= 10, 'zu wenige Ablehnungen');
});
