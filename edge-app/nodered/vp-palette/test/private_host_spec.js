'use strict';

/**
 * LAN-only auf der BOX (Einheitsmodell Stufe 3).
 *
 * ⚠ Der Beweis, dass Go, api, Portal und Palette DIESELBE Regel sprechen: die
 * Vektoren kommen aus der GETEILTEN Datei. Eine eigene Liste hier wäre eine
 * zweite Wahrheit, die lautlos auseinanderläuft.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isPrivateHost, REFUSAL } = require('../lib/private-host');

const VECTORS = path.join(__dirname, '..', '..', '..', '..',
  'docs', 'contracts', 'lan-host-vectors.json');

describe('private-host', function () {
  const vectors = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));

  it('spricht genau die geteilten Vektoren', function () {
    assert.ok(vectors.private.length > 0, 'private Vektoren vorhanden');
    assert.ok(vectors.public.length > 0, 'öffentliche Vektoren vorhanden');
    vectors.private.forEach(function (v) {
      assert.strictEqual(isPrivateHost(v.host), true, 'privat: ' + v.host + ' (' + v.why + ')');
    });
    vectors.public.forEach(function (v) {
      assert.strictEqual(isPrivateHost(v.host), false,
        'NICHT privat: ' + v.host + ' (' + v.why + ')');
    });
  });

  it('nennt seine Ablehnung in Klartext', function () {
    assert.ok(/Heimnetz/.test(REFUSAL));
  });
});
