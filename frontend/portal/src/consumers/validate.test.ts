/**
 * Client-side consumer-policy validator vectors - the SAME file the api's
 * ConsumerPolicyValidatorTest runs (docs/contracts/v2/consumer-policy-vectors.json),
 * so both validators produce the same verdict per case (the topology-vectors /
 * FlowGraphValidator / EdgeRef precedent). Also pins the contract example
 * fixtures (docs/contracts/v2/examples) as valid/invalid.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePolicy, validateControlProfileOnly, type ConsumerFinding } from './validate';

const V2 = resolve(process.cwd(), '../../docs/contracts/v2');

function read(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(V2, rel), 'utf8'));
}

function errorRules(doc: unknown): string[] {
  return validatePolicy(doc).filter((f: ConsumerFinding) => f.severity === 'error').map((f) => f.rule);
}

interface Vector {
  name: string;
  expect: 'valid' | { rule: string };
  document: unknown;
}

describe('consumer-policy validator (shared vectors)', () => {
  const vectors = read('consumer-policy-vectors.json') as { cases: Vector[] };

  it('has the shared cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(20);
  });

  for (const c of vectors.cases) {
    it(`case ${c.name}`, () => {
      const rules = errorRules(c.document);
      if (c.expect === 'valid') {
        expect(rules).toEqual([]);
      } else {
        expect(rules).toContain(c.expect.rule);
      }
    });
  }
});

describe('consumer-policy validator (contract example fixtures)', () => {
  it('the valid fixtures validate clean', () => {
    expect(errorRules(read('examples/consumer-policy.valid.heater.json'))).toEqual([]);
    expect(errorRules(read('examples/consumer-policy.valid.wallbox-ranges.json'))).toEqual([]);
    expect(errorRules(read('examples/consumer-policy.valid.pump-flexible.json'))).toEqual([]);
  });

  it('the invalid fixture (percent 150) is caught semantically too', () => {
    expect(errorRules(read('examples/consumer-policy.invalid.percent-out-of-range.json')))
      .toContain('target_value_type');
  });
});

describe('control-profile-only validation shares the rule codes', () => {
  it('accepts disjoint ascending ranges and rejects overlap', () => {
    expect(validateControlProfileOnly({
      control_kind: 'continuous', rated_power_kw: 11,
      power_ranges_kw: [[1.4, 3.7], [4.2, 11.0]],
    })).toEqual([]);
    expect(validateControlProfileOnly({
      control_kind: 'continuous', rated_power_kw: 11,
      power_ranges_kw: [[1.4, 4.0], [3.5, 11.0]],
    }).map((f) => f.rule)).toContain('power_ranges_not_ascending');
  });
});
