'use strict';

/**
 * Die gemeinsamen Vektoren des Einmal-Schreibpfads (Modbus-TCP-Spur) muessen
 * aus dem AKTUELLEN vp-palette/lib/register-write.js und switch-write.js
 * entstehen. Laufen die Module der Datei davon, faellt dieser Test - und der
 * Go-Zwilling (edge-app/core/internal/einmalschreiben) prueft sich weiterhin
 * gegen den alten Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/register-write-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./register-write-vectors.gen.js');

test('register-write-vectors.json entspricht register-write.js und switch-write.js', async () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    await gen.build(),
    'register-write-vectors.json ist veraltet - node register-write-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('die Vektoren decken Leseplan, Klassen und jeden Ausgang des Laufs ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.plan.some((c) => c.plan === null) && data.plan.some((c) => c.plan !== null));
  const codes = new Set(data.laeufe.map((c) => c.ergebnis.error_code || 'ok'));
  for (const c of ['ok', 'precondition', 'write_unconfirmed', 'unreachable', 'invalid_request', 'timeout']) {
    assert.ok(codes.has(c), c);
  }
  assert.ok(data.laeufe.some((c) => c.aufrufe.some((a) => a.warten === data.settle_ms)));
});
