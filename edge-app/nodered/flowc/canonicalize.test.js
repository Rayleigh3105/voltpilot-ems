'use strict';
// node --test canonicalize.test.js - pins the JS half of the shared JCS
// vectors (the Go half is edge-app/core/internal/flowdeploy/jcs_test.go).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { canonicalize, contentHash } = require('./canonicalize');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'jcs-vectors.json'), 'utf8'));

test('shared RFC 8785 vectors', () => {
  assert.ok(vectors.cases.length >= 15, 'vector file suspiciously small');
  for (const c of vectors.cases) {
    assert.strictEqual(canonicalize(JSON.parse(c.input)), c.canonical, c.name);
  }
});

test('equivalent documents hash identically, shape sha256:<hex>', () => {
  const a = contentHash(JSON.parse('{"b":1,"a":2}'));
  const b = contentHash(JSON.parse('{ "a": 2, "b": 1 }'));
  assert.strictEqual(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});

test('non-finite numbers are refused', () => {
  assert.throws(() => canonicalize({ a: NaN }));
  assert.throws(() => canonicalize({ a: Infinity }));
});
