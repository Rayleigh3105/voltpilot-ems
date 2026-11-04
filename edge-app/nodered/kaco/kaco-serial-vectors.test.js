'use strict';

/**
 * Die gemeinsamen KACO-seriell-Vektoren muessen aus dem AKTUELLEN
 * kaco-serial-decode.js entstehen. Laeuft das Modul der Datei davon, faellt
 * dieser Test - und der Go-Zwilling (edge-app/core/internal/kacoserial) prueft
 * sich weiterhin gegen den alten Stand, bis jemand den Generator ausfuehrt.
 * Beides zusammen haelt Node-RED und Edge Light deckungsgleich.
 *
 *   node edge-app/nodered/kaco/kaco-serial-vectors.gen.js   (neu erzeugen)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const gen = require('./kaco-serial-vectors.gen.js');

test('kaco-serial-vectors.json entspricht dem aktuellen kaco-serial-decode.js', () => {
  const committed = fs.readFileSync(gen.OUT, 'utf8');
  assert.strictEqual(
    committed,
    gen.build(),
    'kaco-serial-vectors.json ist veraltet - node kaco/kaco-serial-vectors.gen.js ausfuehren und das Ergebnis committen',
  );
});

test('jeder Fall traegt die rohen Bytes und jede Modulantwort', () => {
  const data = JSON.parse(fs.readFileSync(gen.OUT, 'utf8'));
  assert.ok(data.cases.length >= 50, 'zu wenige Faelle');
  for (const c of data.cases) {
    for (const k of ['hex', 'trim', 'complete', 'reply_command_byte', 'protocol_mismatch', 'verify_checksum', 'parse', 'decode', 'decode_require_checksum']) {
      assert.ok(k in c, c.name + ': ' + k);
    }
  }
  assert.ok(data.build_request.some((r) => r.hex === '233031300d'), 'die Anfrage #010\\r');
});
