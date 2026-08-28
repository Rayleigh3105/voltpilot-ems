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
  /**
   * Die MAPPING-Vektoren (Cockpit Phase 1 / C2). Die derive-Fälle können sie
   * nicht abdecken - sie tragen bereits aufgelöste Rollen -, und genau dort
   * driften die drei Zwillinge am leichtesten auseinander: ein Ladepunkt ist
   * Kategorie `consumer`, nur der TYP hält ihn aus dem Haus-Knoten heraus.
   */
  default_role_cases: {
    name: string;
    type: string;
    category: string;
    channel: string;
    connection: string;
    expected: string;
  }[];
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

describe('topology.defaultRole (shared vectors)', () => {
  it('has cases', () => {
    expect(vectors.default_role_cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.default_role_cases) {
    it(c.name, () => {
      expect(defaultRole(c.type, c.category, c.channel, c.connection)).toBe(c.expected);
    });
  }
});

describe('topology - die Lade-Rollen (C2)', () => {
  it('gibt die Lade-Rollen ZULETZT aus (angehängt, damit alte Vektoren byte-gleich bleiben)', () => {
    const cap = (channel: string, role: string) => ({
      channel,
      role,
      primary: true,
      value: 1,
    });
    const ent = (id: string, role: string) => ({
      id,
      type: id,
      label: id,
      category: 'consumer',
      health: 'ok',
      capabilities: [cap('power_kw', role)],
    });
    // Bewusst in VERDREHTER Eingabe-Reihenfolge: die Ausgabe folgt der
    // kanonischen Ordnung, nicht der Eingabe.
    const got = derive({
      entities: [
        ent('C', 'charging-own'),
        ent('G', 'grid'),
        ent('W', 'charging'),
        ent('H', 'consumer'),
        ent('S', 'storage'),
        ent('P', 'pv'),
      ],
    });
    expect(got.nodes.map((n) => n.role)).toEqual([
      'pv',
      'storage',
      'consumer',
      'grid',
      'charging',
      'charging-own',
    ]);
  });

  it('lässt einen Ladepunkt aus dem Haus-Knoten heraus und fliesst nach aussen', () => {
    const got = derive({
      entities: [
        {
          id: 'H',
          type: 'house-load',
          label: 'Hausverbrauch',
          category: 'consumer',
          health: 'ok',
          capabilities: [{ channel: 'power_kw', role: 'consumer', primary: true, value: 4.2 }],
        },
        {
          id: 'W',
          type: 'wallbox',
          label: 'Wallbox',
          category: 'consumer',
          health: 'ok',
          capabilities: [{ channel: 'power_kw', role: 'charging', primary: true, value: 11 }],
        },
      ],
    });
    expect(got.nodes.map((n) => n.role)).toEqual(['consumer', 'charging']);
    // Beide Richtungen „out": Laden IST Verbrauch.
    expect(got.nodes[1].direction).toBe('out');
    expect(got.nodes[0].members).toHaveLength(1);
  });
});
