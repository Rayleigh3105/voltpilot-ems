import { describe, expect, it } from 'vitest';
import type { TopologyEntity } from './api';
import { layoutFlow } from './adaptiveFlow';
import type { FlowNode, Topology } from './topology';

const NBSP = '\u00A0';

function entity(id: string, entityType: string, label: string): TopologyEntity {
  return { id, entityType, typeLabel: label, label, category: '', health: 'ok', capabilities: [] };
}

const PILOT_NODES: FlowNode[] = [
  {
    role: 'pv',
    value_kw: 72.6,
    flow_active: true,
    direction: 'in',
    members: [
      { entity_id: 'fronius', label: 'Fronius Symo', primary: true, value_kw: 60 },
      { entity_id: 'deye', label: 'Deye', primary: false, value_kw: 12.6 },
    ],
  },
  {
    role: 'storage',
    value_kw: 4,
    soc_pct: 45,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'deye', label: 'Deye 65 kWh', primary: true, value_kw: 4 }],
  },
  {
    role: 'consumer',
    value_kw: 11,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'goe', label: 'go-e', primary: true, value_kw: 11 }],
  },
  {
    role: 'grid',
    value_kw: 54.2,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'deye', label: 'Netz', primary: true, value_kw: -54.2 }],
  },
];

const TOPO: Topology = { schema_version: '1.0', nodes: PILOT_NODES };
const ENTITIES: TopologyEntity[] = [
  entity('fronius', 'producer', 'Fronius Symo'),
  entity('deye', 'battery-hybrid', 'Deye 65 kWh'),
  entity('goe', 'wallbox', 'go-e Charger'),
];

describe('layoutFlow', () => {
  it('places a circle per member grouped by role side', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    // 2 PV + 1 storage + 1 consumer + 1 grid = 5 vertices.
    expect(l.vertices).toHaveLength(5);
    const pv = l.vertices.filter((v) => v.role === 'pv');
    expect(pv).toHaveLength(2);
    // producers sit on the top row, symmetric around the hub x.
    expect(pv.every((v) => v.y === 48)).toBe(true);
    expect(pv[0].x + pv[1].x).toBeCloseTo(2 * l.hubX);
    // storage left column, consumer right column, grid bottom row.
    const storage = l.vertices.find((v) => v.role === 'storage')!;
    const consumer = l.vertices.find((v) => v.role === 'consumer')!;
    const grid = l.vertices.find((v) => v.role === 'grid')!;
    expect(storage.x).toBeLessThan(l.hubX);
    expect(consumer.x).toBeGreaterThan(l.hubX);
    expect(grid.y).toBeGreaterThan(l.hubY);
  });

  it('encodes the topology flow direction (in = node->hub, out = hub->node)', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    const pv = l.vertices.find((v) => v.role === 'pv')!;
    const consumer = l.vertices.find((v) => v.role === 'consumer')!;
    expect(pv.reverse).toBe(false); // 'in'
    expect(consumer.reverse).toBe(true); // 'out'
    expect(pv.spokeActive).toBe(true);
  });

  it('shows SoC in the storage circle and |kW| elsewhere', () => {
    const l = layoutFlow(TOPO, ENTITIES);
    expect(l.vertices.find((v) => v.role === 'storage')!.value).toBe(`45${NBSP}%`);
    expect(l.vertices.find((v) => v.role === 'grid')!.value).toBe(`54,2${NBSP}kW`); // abs of -54.2
  });

  it('grows the viewBox as a role gains members but stays >= the base', () => {
    const wide: Topology = {
      schema_version: '1.0',
      nodes: [
        {
          role: 'pv',
          value_kw: 1,
          flow_active: true,
          direction: 'in',
          members: [
            { entity_id: 'a', label: 'A', primary: true, value_kw: 1 },
            { entity_id: 'b', label: 'B', primary: false, value_kw: 1 },
            { entity_id: 'c', label: 'C', primary: false, value_kw: 1 },
          ],
        },
      ],
    };
    const base = layoutFlow(TOPO, ENTITIES);
    const grown = layoutFlow(wide, ENTITIES);
    expect(base.W).toBe(520);
    expect(grown.W).toBeGreaterThan(base.W);
  });

  it('returns no vertices for an empty topology', () => {
    expect(layoutFlow({ schema_version: '1.0', nodes: [] }, []).vertices).toHaveLength(0);
  });
});
