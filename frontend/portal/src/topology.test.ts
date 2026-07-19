import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRole, derive, type Input, type Topology } from './topology';

// The ONE shared derivation vector file, also consumed by the Go twin
// (edge-app/core/internal/topology/topology_test.go) and the Java twin
// (TopologyDeriverTest). Asserting derive(input) === expected here AND in Go
// proves the two draw byte-identical node sets from the same input. vitest runs
// with cwd = frontend/portal, so the repo root is two levels up.
const vectorsPath = resolve(process.cwd(), '../../docs/contracts/v2/topology-vectors.json');

interface VectorFile {
  cases: { name: string; input: Input; expected: Topology }[];
}

const vectors: VectorFile = JSON.parse(readFileSync(vectorsPath, 'utf8'));

describe('topology.derive (shared vectors)', () => {
  it('has cases', () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(derive(c.input)).toEqual(c.expected);
    });
  }

  it('serializes byte-identically to the expected JSON (canonical key order)', () => {
    // The FlowNode/FlowMember key order in topology.ts matches the vector
    // authoring order, so a JSON.stringify of a derived node equals the
    // stringify of its expected twin - the same byte-level guarantee the Go
    // twin makes via json.Marshal.
    const pilot = vectors.cases.find((x) => x.name === 'pilot-deye-fronius-gridmeter')!;
    const got = derive(pilot.input);
    expect(JSON.stringify(got.nodes[0])).toBe(JSON.stringify(pilot.expected.nodes[0]));
  });
});

describe('topology.defaultRole', () => {
  it.each([
    ['storage', 'pv_power_kw', 'pv'],
    ['producer', 'pv_power_kw', 'pv'],
    ['storage', 'battery_power_kw', 'storage'],
    ['storage', 'soc_pct', 'storage'],
    ['storage', 'power_kw', 'storage'],
    ['producer', 'power_kw', 'pv'],
    ['consumer', 'power_kw', 'consumer'],
    ['meter', 'power_kw', 'grid'],
    ['measure-only', 'power_kw', 'grid'],
    ['consumer', 'energy_kwh', ''],
    ['meter', 'frequency_hz', ''],
  ])('defaultRole(%s, %s) = %s', (category, channel, want) => {
    expect(defaultRole(category, channel)).toBe(want);
  });
});
