'use strict';

/**
 * Die gemeinsamen Vektoren des generischen Modbus-TCP-Wegs muessen aus dem
 * AKTUELLEN modbus-tcp.js und vp-modbus-probe.js entstehen. Laufen die Module
 * der Datei davon, faellt dieser Test - und der Go-Zwilling
 * (edge-app/core/internal/modbusprofil) prueft sich weiterhin gegen den alten
 * Stand, bis jemand den Generator ausfuehrt.
 *
 *   node edge-app/nodered/modbus-tcp-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./modbus-tcp-vectors.gen.js');

test('modbus-tcp-vectors.json entspricht modbus-tcp.js und vp-modbus-probe.js', async () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    await gen.build(),
    'modbus-tcp-vectors.json ist veraltet - node modbus-tcp-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('die Vektoren decken Werte, Profil, Klassen und Probe-Schritte ab', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.decode_value.length >= 25, 'zu wenige decodeValue-Faelle');
  assert.ok(data.profile.some((c) => c.decode === null) && data.profile.some((c) => c.decode !== null));
  assert.deepStrictEqual(data.profile_read.sunspec, { fc: 3, addr: 0, count: 9 });
  const codes = new Set(data.classify.map((c) => c.ergebnis.code));
  for (const c of ['unreachable', 'no_answer', 'timeout', 'invalid_response']) assert.ok(codes.has(c), c);
  for (const c of data.probe) assert.strictEqual(c.results.length, c.ops.length, c.name);
});
