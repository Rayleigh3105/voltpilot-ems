'use strict';
/**
 * canonicalize.js - RFC 8785 (JCS) JSON canonicalization, the integrity basis
 * of the flow-artifact contract (docs/contracts/v2/flow-artifact.md §1):
 * content_hash = "sha256:" + sha256(canonicalize(bundle)).
 *
 * The Go consumer (edge-app/core/internal/flowdeploy/jcs.go) re-canonicalizes
 * and verifies before applying - the two implementations MUST stay
 * byte-identical. The shared vector file jcs-vectors.json is pinned by BOTH
 * test suites (the refCheckChar lockstep precedent); never change one side
 * alone.
 *
 * Implementation notes: JSON.stringify already implements the JCS primitive
 * serializations (ES6 number formatting, minimal string escapes); JCS is then
 * "stringify with lexicographically sorted keys". Keys MUST be serialized by
 * explicit iteration - rebuilding an object would let JS enumerate
 * integer-like keys first and break the RFC's UTF-16 order.
 */

const crypto = require('crypto');

function canonicalize(value) {
  if (value === undefined) throw new Error('jcs: undefined is not JSON');
  if (typeof value === 'number' && !isFinite(value)) throw new Error('jcs: non-finite number');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  const keys = Object.keys(value).sort(); // default sort = UTF-16 code units
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue; // JSON.stringify drops undefined members
    parts.push(JSON.stringify(k) + ':' + canonicalize(v));
  }
  return '{' + parts.join(',') + '}';
}

/** contentHash returns the contract's "sha256:<hex>" over the canonical form. */
function contentHash(value) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

module.exports = { canonicalize, contentHash };
