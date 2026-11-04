/**
 * The shared vectors of the generated reactive consumer rule
 * (docs/contracts/v2/verbraucherregel-vectors.json) are exactly what the JS
 * reference produces - the node runs that reference, Edge Light's Go twin
 * reads the same file (internal/verbraucherregel/vectors_test.go).
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const { render, OUT } = require('./verbraucherregel-vectors.gen.js');

describe('verbraucherregel-vectors.json', function () {
  it('matches the JS reference (regenerate with node test/verbraucherregel-vectors.gen.js)', function () {
    assert.strictEqual(fs.readFileSync(OUT, 'utf8'), render());
  });
});
