import { describe, expect, it } from 'vitest';
import { reconcileProducerPv } from './pvReconcile';
import type { SiteSource, SiteTopology, TopologyEntity } from './api';
import type { FlowMember, FlowNode } from './topology';

function tEntity(id: string, entityType: string, category: string): TopologyEntity {
  return { id, entityType, typeLabel: entityType, label: null, category, health: 'ok', capabilities: [] };
}

function member(entity_id: string, label: string, value_kw?: number): FlowMember {
  const m: FlowMember = { entity_id, label, primary: false };
  if (value_kw !== undefined) m.value_kw = value_kw;
  return m;
}

function pvNode(members: FlowMember[]): FlowNode {
  return { role: 'pv', value_kw: 70.3, flow_active: true, direction: 'in', members };
}

/** Pilsting-shaped topology: hybrid carries the WHOLE plant PV, producers are "–". */
function pilsting(members: FlowMember[]): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities: [
      tEntity('batt', 'battery-hybrid', 'storage'),
      tEntity('fro1', 'producer', 'producer'),
      tEntity('fro2', 'producer', 'producer'),
    ],
    topology: { schema_version: '1.0', nodes: [pvNode(members)] },
  };
}

function source(
  sourceId: string,
  kind: SiteSource['kind'],
  overrides: Partial<SiteSource> = {},
): SiteSource {
  return {
    deviceId: 'gw',
    sourceId,
    kind,
    role: kind === 'primary' ? null : 'pv-generation',
    label: null,
    brand: null,
    model: null,
    pvKw: null,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: null,
    reportedAt: '',
    ...overrides,
  };
}

const SOURCES: SiteSource[] = [
  source('deye', 'primary', { pvKw: 23.8, label: 'Deye' }),
  source('fro-a', 'source', { pvKw: 19.9, label: 'Fronius Anlage' }),
  source('fro-b', 'source', { pvKw: 26.6, label: 'Fronius Anlage WR 2' }),
];

describe('reconcileProducerPv (F3/F4)', () => {
  it('splits the composite PV onto the producer circles and reduces the hybrid', () => {
    const topo = pilsting([
      member('batt', 'Batteriespeicher', 70.3),
      member('fro1', 'Fronius WR1'), // value absent (the bug state)
      member('fro2', 'Fronius WR2'),
    ]);
    const out = reconcileProducerPv(topo, SOURCES);
    const members = out.topology.nodes[0].members;

    // F3: each producer circle now carries its own /sources PV…
    expect(members[1].value_kw).toBe(19.9);
    expect(members[2].value_kw).toBe(26.6);
    // …and the hybrid is reduced by their sum (Deye's own PV).
    expect(members[0].value_kw).toBeCloseTo(23.8, 3);
    // The three circles still add up to the composite total.
    const sum = members.reduce((s, m) => s + (m.value_kw ?? 0), 0);
    expect(sum).toBeCloseTo(70.3, 3);

    // F4: the flow labels now come from the /sources split (one naming scheme).
    expect(members[1].label).toBe('Fronius Anlage');
    expect(members[2].label).toBe('Fronius Anlage WR 2');
  });

  it('does not mutate the input topology', () => {
    const topo = pilsting([member('batt', 'Batteriespeicher', 70.3), member('fro1', 'F1'), member('fro2', 'F2')]);
    reconcileProducerPv(topo, SOURCES);
    expect(topo.topology.nodes[0].members[0].value_kw).toBe(70.3);
    expect(topo.topology.nodes[0].members[1].value_kw).toBeUndefined();
  });

  it('is a no-op when the edge already splits per entity (producers carry values)', () => {
    const topo = pilsting([
      member('batt', 'Batteriespeicher', 23.8),
      member('fro1', 'Fronius WR1', 19.9),
      member('fro2', 'Fronius WR2', 26.6),
    ]);
    expect(reconcileProducerPv(topo, SOURCES)).toBe(topo);
  });

  it('is a no-op without sources or a PV node', () => {
    const topo = pilsting([member('batt', 'Batteriespeicher', 70.3), member('fro1', 'F1'), member('fro2', 'F2')]);
    expect(reconcileProducerPv(topo, null)).toBe(topo);
    expect(reconcileProducerPv(topo, [])).toBe(topo);
    const noPv: SiteTopology = { ...topo, topology: { schema_version: '1.0', nodes: [] } };
    expect(reconcileProducerPv(noPv, SOURCES)).toBe(noPv);
  });

  it('ignores grid meters / consumers and a producer with no reading', () => {
    const topo = pilsting([member('batt', 'Batteriespeicher', 70.3), member('fro1', 'F1'), member('fro2', 'F2')]);
    const onlyGrid: SiteSource[] = [
      source('grid', 'source', { role: 'grid-meter', powerKw: -2.1 }),
      source('wb', 'source', { role: 'consumer', loadKw: 3.3 }),
      source('fro-never', 'source', { role: 'pv-generation', pvKw: null, health: 'never' }),
    ];
    expect(reconcileProducerPv(topo, onlyGrid)).toBe(topo);
  });

  it('fills only as many producer circles as there are /sources parts', () => {
    const topo = pilsting([member('batt', 'Batteriespeicher', 70.3), member('fro1', 'F1'), member('fro2', 'F2')]);
    const out = reconcileProducerPv(topo, [
      source('deye', 'primary', { pvKw: 50, label: 'Deye' }),
      source('fro-a', 'source', { pvKw: 19.9, label: 'Fronius Anlage' }),
    ]);
    const members = out.topology.nodes[0].members;
    expect(members[1].value_kw).toBe(19.9);
    // The second producer has no matching part → stays "–".
    expect(members[2].value_kw).toBeUndefined();
    expect(members[0].value_kw).toBeCloseTo(50.4, 3); // 70.3 - 19.9
  });
});
