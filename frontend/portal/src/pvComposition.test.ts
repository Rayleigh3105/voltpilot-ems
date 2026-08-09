import { describe, expect, it } from 'vitest';
import type { SiteSource, SiteTopology, TopologyEntity } from './api';
import { pvComposition, shareOf, UNASSIGNED_NOTE } from './pvComposition';
import type { EntityPin } from './pvReconcile';
import type { FlowMember } from './topology';

function src(over: Partial<SiteSource>): SiteSource {
  return {
    deviceId: 'd1',
    sourceId: 's1',
    kind: 'source',
    role: 'pv-generation',
    label: null,
    brand: null,
    model: null,
    pvKw: null,
    powerKw: null,
    loadKw: null,
    health: 'ok',
    readAt: null,
    reportedAt: '2026-07-21T10:00:00Z',
    ...over,
  };
}

function entity(over: Partial<TopologyEntity> & { id: string }): TopologyEntity {
  return {
    entityType: 'producer',
    typeLabel: 'Erzeuger',
    label: null,
    category: 'producer',
    health: 'ok',
    capabilities: [],
    ...over,
  };
}

function topo(members: FlowMember[], entities: TopologyEntity[]): SiteTopology {
  return {
    schemaVersion: '1.0',
    entities,
    topology: {
      schema_version: '1.0',
      nodes: [
        {
          role: 'pv',
          value_kw: 69.8,
          flow_active: true,
          direction: 'in',
          members,
        },
      ],
    },
  };
}

/**
 * The captain's real plant: the writer mirrors the COMPOSITE site PV onto the
 * battery-hybrid entity, so the hybrid alone carries 69,8 kW while the two
 * Fronius producers have no series at all. `/sources` knows the honest split.
 */
const HYBRID_CARRIES_ALL = topo(
  [
    // Post-Label-Hygiene (V20260812000000) a COMPOSED row carries NO label:
    // the composition writes none, so a label here would mean a human gave it.
    { entity_id: 'deye', label: null, primary: true, value_kw: 69.8 },
    { entity_id: 'f1', label: null, primary: false },
    { entity_id: 'f2', label: null, primary: false },
  ],
  [
    entity({ id: 'deye', entityType: 'battery-hybrid', category: 'storage', label: null }),
    entity({ id: 'f1', health: 'never' }),
    entity({ id: 'f2', health: 'never' }),
  ],
);

/**
 * The PIN facts (`GET /entities`): each producer names the edge source that
 * measures it. This is the ONLY link - order and names are never consulted
 * (`vp-pin-werte-f8`).
 */
const PINS: EntityPin[] = [
  { id: 'deye', edgeSourceId: null },
  { id: 'f1', edgeSourceId: 'a' },
  { id: 'f2', edgeSourceId: 'b' },
];

const REAL_SOURCES: SiteSource[] = [
  src({
    sourceId: 'inverter',
    kind: 'primary',
    role: null,
    label: null,
    brand: 'deye',
    model: 'SUN-30K-SG01HP3-EU',
    pvKw: 23.0,
  }),
  src({ sourceId: 'a', label: 'Fronius Anlage', pvKw: 21.3 }),
  src({ sourceId: 'b', label: 'Fronius Anlage WR 2', pvKw: 25.5 }),
];

describe('pvComposition · the rows add up to the node total', () => {
  it('explains the captain’s three-inverter plant', () => {
    const c = pvComposition(HYBRID_CARRIES_ALL, REAL_SOURCES, PINS)!;
    expect(c.origin).toBe('sources');
    expect(c.deviceCount).toBe(3);
    expect(c.parts.map((p) => p.label)).toEqual([
      'Deye SUN-30K',
      'Fronius Anlage',
      'Fronius Anlage WR 2',
    ]);
    expect(c.parts.map((p) => p.kw)).toEqual([23.0, 21.3, 25.5]);
    expect(c.unmeasured).toHaveLength(0);
    expect(c.totalKw).toBeCloseTo(69.8, 9);
  });

  it('the total is EXACTLY the sum of the parts, whatever the inputs', () => {
    for (const sources of [REAL_SOURCES, REAL_SOURCES.slice(0, 2), []]) {
      const c = pvComposition(HYBRID_CARRIES_ALL, sources, PINS);
      if (!c || c.parts.length === 0) continue;
      const sum = c.parts.reduce((s, p) => s + (p.kw as number), 0);
      expect(c.totalKw).toBeCloseTo(sum, 9);
    }
  });

  it('prefers real per-entity values when the edge already publishes them', () => {
    // TODO(edge-fanout): this is the world after the edge fan-out - no /sources
    // reconstruction is involved and the labels come from the entities.
    const native = topo(
      [
        { entity_id: 'deye', label: 'Deye SUN-30K', primary: true, value_kw: 23 },
        { entity_id: 'f1', label: 'Fronius WR 1', primary: false, value_kw: 21.3 },
        { entity_id: 'f2', label: 'Fronius WR 2', primary: false, value_kw: 25.5 },
      ],
      [entity({ id: 'deye' }), entity({ id: 'f1' }), entity({ id: 'f2' })],
    );
    const c = pvComposition(native, null)!;
    expect(c.origin).toBe('entity');
    expect(c.parts.map((p) => p.label)).toEqual(['Deye SUN-30K', 'Fronius WR 1', 'Fronius WR 2']);
    expect(c.totalKw).toBeCloseTo(69.8, 9);
    // …and it stays the truth even when a stale /sources heartbeat disagrees.
    const withStaleSources = pvComposition(native, REAL_SOURCES, PINS)!;
    expect(withStaleSources.origin).toBe('entity');
    expect(withStaleSources.parts.map((p) => p.kw)).toEqual([23, 21.3, 25.5]);
  });
});

/**
 * The captain's Pilsting constellation (proof of 2026-07-29, 17:00): the
 * component „Fronius WR1" is a PROVEN orphan (its pin names a source that
 * vanished in the delete+re-add churn), while the ghost „Fronius WR2" is pinned
 * to the source that is actually DELIVERING. Positional matching put 20,1 kW on
 * the orphan and "–" on the ghost - exactly the wrong way round.
 */
describe('pvComposition · strictly pin-based (the Pilsting cross-pin)', () => {
  const CROSS = topo(
    [
      { entity_id: 'deye', label: 'Batteriespeicher', primary: true, value_kw: 43.1 },
      { entity_id: 'wr1', label: 'Fronius WR1 (Erzeuger)', primary: false },
      { entity_id: 'wr2', label: 'Fronius WR2 (Erzeuger)', primary: false },
    ],
    [
      entity({ id: 'deye', entityType: 'battery-hybrid', category: 'storage', label: 'Deye' }),
      entity({ id: 'wr1', health: 'never', label: 'Fronius WR1' }),
      entity({ id: 'wr2', health: 'never', label: 'Fronius WR2' }),
    ],
  );
  const CROSS_SOURCES: SiteSource[] = [
    src({ sourceId: 'inverter', kind: 'primary', role: null, brand: 'deye', model: 'SUN-30K-SG01HP3-EU', pvKw: 23 }),
    src({ sourceId: 'live', label: 'Fronius Anlage WR2', pvKw: 20.1 }),
  ];
  // wr1's pin points at a source that no longer exists -> PROVEN orphan.
  const CROSS_PINS: EntityPin[] = [
    { id: 'deye', edgeSourceId: null },
    { id: 'wr1', edgeSourceId: 'weg', orphanedPin: true },
    { id: 'wr2', edgeSourceId: 'live' },
  ];

  it('gives the value to the PINNED component, never to the row above it', () => {
    const c = pvComposition(CROSS, CROSS_SOURCES, CROSS_PINS)!;
    // The ENTITY carries the customer's name, so that is what the row shows.
    const wr2 = c.parts.find((p) => p.label === 'Fronius WR2')!;
    expect(wr2.kw).toBe(20.1);
    // …and the orphan carries NO value at all - its own state is „nicht verbunden".
    const wr1 = c.unmeasured.find((p) => p.label.includes('WR1'))!;
    expect(wr1.kw).toBeNull();
    expect(wr1.note).toBe('nicht mehr mit einem gemeldeten Gerät verbunden');
    expect(c.parts.some((p) => p.label.includes('WR1'))).toBe(false);
    // Σ shown = the composite the edge reported (23 own + 20,1 WR2).
    expect(c.totalKw).toBeCloseTo(43.1, 9);
  });

  it('assigns nothing at all without pins - a guess by position is not an option', () => {
    const c = pvComposition(CROSS, CROSS_SOURCES, null)!;
    // Neither producer is pinned, so neither is filled…
    expect(c.unmeasured.map((p) => p.label)).toEqual(['Fronius WR1', 'Fronius WR2']);
    // …and the delivering source is NAMED as unassigned instead of sliding onto
    // the next row. The total still equals the composite (physical truth).
    const loose = c.parts.find((p) => p.note === UNASSIGNED_NOTE)!;
    expect(loose.kw).toBe(20.1);
    expect(loose.label).toBe('Fronius Anlage WR2');
    expect(c.totalKw).toBeCloseTo(43.1, 9);
  });

  it('lists a delivering device nobody is pinned to as its own row', () => {
    const extra = [...CROSS_SOURCES, src({ sourceId: 'neu', label: 'Fronius Carport', pvKw: 4.4 })];
    const withExtra = topo(
      [
        { entity_id: 'deye', label: 'Batteriespeicher', primary: true, value_kw: 47.5 },
        { entity_id: 'wr2', label: 'Fronius WR2 (Erzeuger)', primary: false },
      ],
      [
        entity({ id: 'deye', entityType: 'battery-hybrid', category: 'storage', label: 'Deye' }),
        entity({ id: 'wr2', health: 'never', label: 'Fronius WR2' }),
      ],
    );
    const c = pvComposition(withExtra, extra, [
      { id: 'deye', edgeSourceId: null },
      { id: 'wr2', edgeSourceId: 'live' },
    ])!;
    const loose = c.parts.find((p) => p.label === 'Fronius Carport')!;
    expect(loose.kw).toBe(4.4);
    expect(loose.note).toBe(UNASSIGNED_NOTE);
    // 23 (Deye's own) + 20,1 (WR2) + 4,4 (unassigned) = 47,5 = the composite.
    expect(c.parts.map((p) => p.kw)).toEqual([23, 20.1, 4.4]);
    expect(c.totalKw).toBeCloseTo(47.5, 9);
  });
});

describe('pvComposition · the honest empty state', () => {
  it('names a producer measured through the inverter instead of a bare "–"', () => {
    // Only ONE additional source reported, so the second Fronius has no own
    // value - its output is inside the hybrid's number, and that is what it says.
    const c = pvComposition(HYBRID_CARRIES_ALL, REAL_SOURCES.slice(0, 2), PINS)!;
    expect(c.parts).toHaveLength(2);
    expect(c.unmeasured).toHaveLength(1);
    expect(c.unmeasured[0].kw).toBeNull();
    expect(c.unmeasured[0].note).toBe('über den Wechselrichter mitgemessen');
    expect(c.unmeasured[0].label).not.toBe('–');
    expect(c.deviceCount).toBe(3);
    // the shown parts still sum to exactly what they claim
    expect(c.totalKw).toBeCloseTo(69.8, 9);
  });

  it('says "wartet auf erste Daten" for a device that never delivered', () => {
    const fresh = topo(
      [
        { entity_id: 'deye', label: 'Deye', primary: true, value_kw: 23 },
        { entity_id: 'neu', label: 'Neuer Erzeuger', primary: false },
      ],
      [entity({ id: 'deye' }), entity({ id: 'neu', health: 'never' })],
    );
    // No /sources at all -> nothing was reconstructed, so nothing is "measured
    // through the inverter"; the device is simply waiting.
    const c = pvComposition(fresh, [])!;
    expect(c.unmeasured[0].note).toBe('wartet auf erste Daten');
  });

  it('says "meldet sich gerade nicht" for a device that has gone quiet', () => {
    const quiet = topo(
      [
        { entity_id: 'deye', label: 'Deye', primary: true, value_kw: 23 },
        { entity_id: 'f1', label: 'Fronius WR 1', primary: false },
      ],
      [entity({ id: 'deye' }), entity({ id: 'f1', health: 'stale' })],
    );
    const c = pvComposition(quiet, [])!;
    expect(c.unmeasured[0].note).toBe('meldet sich gerade nicht');
    expect(c.unmeasured[0].health).toBe('stale');
  });

  it('keeps a stale part with its last value and flags it', () => {
    const c = pvComposition(
      HYBRID_CARRIES_ALL,
      [
        REAL_SOURCES[0],
        src({ sourceId: 'a', label: 'Fronius Anlage', pvKw: 21.3, health: 'stale' }),
        REAL_SOURCES[2],
      ],
      PINS,
    )!;
    expect(c.parts.find((p) => p.label === 'Fronius Anlage')!.health).toBe('stale');
    expect(c.parts.find((p) => p.label === 'Fronius Anlage')!.kw).toBe(21.3);
  });
});

describe('pvComposition · scale', () => {
  it('works for a single inverter - one part, nothing to expand', () => {
    const single = topo(
      [{ entity_id: 'deye', label: 'Deye', primary: true, value_kw: 8.3 }],
      [entity({ id: 'deye' })],
    );
    const c = pvComposition(single, [src({ sourceId: 'inverter', kind: 'primary', pvKw: 8.3 })])!;
    expect(c.deviceCount).toBe(1);
    expect(c.parts).toHaveLength(1);
    expect(c.totalKw).toBe(8.3);
  });

  it('works for six inverters - every one named, all shares sum to 1', () => {
    const members: FlowMember[] = Array.from({ length: 6 }, (_, i) => ({
      entity_id: `wr${i}`,
      label: `Wechselrichter ${i + 1}`,
      primary: i === 0,
      value_kw: 5 + i,
    }));
    const six = topo(
      members,
      members.map((m) => entity({ id: m.entity_id })),
    );
    const c = pvComposition(six, null)!;
    expect(c.origin).toBe('entity');
    expect(c.deviceCount).toBe(6);
    expect(c.parts.map((p) => p.label)).toEqual([
      'Wechselrichter 1',
      'Wechselrichter 2',
      'Wechselrichter 3',
      'Wechselrichter 4',
      'Wechselrichter 5',
      'Wechselrichter 6',
    ]);
    expect(c.totalKw).toBe(45); // 5+6+7+8+9+10
    const shares = c.parts.reduce((s, p) => s + shareOf(p, c), 0);
    expect(shares).toBeCloseTo(1, 9);
  });

  it('stays out of the way where there is no PV role at all', () => {
    expect(pvComposition(null, REAL_SOURCES, PINS)).toBeNull();
    expect(
      pvComposition(
        { schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } },
        REAL_SOURCES,
        PINS,
      ),
    ).toBeNull();
    expect(pvComposition(topo([], []), REAL_SOURCES, PINS)).toBeNull();
  });
});

describe('pvComposition · one vocabulary, no crossed labels', () => {
  it('names every box the way the customer named it on the device', () => {
    const c = pvComposition(HYBRID_CARRIES_ALL, REAL_SOURCES, PINS)!;
    // An UNNAMED row reads as the DEVICE ("Deye SUN-30K") - the composition
    // gives it no name of its own to get in the way.
    expect(c.parts[0].label).toBe('Deye SUN-30K');
    expect(c.parts[0].title).toBe('Deye SUN-30K');
    // The two Fronius keep the edge's own names, in the edge's own order -
    // the flow prints no device name at all, so nothing can cross any more.
    expect(c.parts[1].label).toBe('Fronius Anlage');
    expect(c.parts[2].label).toBe('Fronius Anlage WR 2');
    expect(new Set(c.parts.map((p) => p.label)).size).toBe(3);
  });

  it('falls back to the type word when neither a name nor a device is known', () => {
    const c = pvComposition(HYBRID_CARRIES_ALL, [], PINS)!;
    expect(c.parts[0].label).toBe('Erzeuger');
    expect(c.parts[0].alias).toBeNull();
    expect(c.unmeasured.map((p) => p.label)).toEqual(['Erzeuger', 'Erzeuger']);
  });

  // The alias concept (`vp-entity-alias-k1`): THE surface the customer was
  // looking at when they asked for their own names.
  it('lets the customer‘s own name beat the name typed on the device', () => {
    const named = topo(
      [
        { entity_id: 'deye', label: null, primary: true, value_kw: 69.8 },
        { entity_id: 'f1', label: 'Dach Süd', primary: false },
        { entity_id: 'f2', label: null, primary: false },
      ],
      [
        entity({ id: 'deye', entityType: 'battery-hybrid', category: 'storage', label: null }),
        entity({ id: 'f1', health: 'never', label: 'Dach Süd' }),
        entity({ id: 'f2', health: 'never' }),
      ],
    );
    const c = pvComposition(named, REAL_SOURCES, PINS)!;
    const dach = c.parts.find((p) => p.label === 'Dach Süd')!;
    // The edge still calls it „Fronius Anlage" - and that stays reachable as
    // the row's tooltip (R2), so support can still find the physical box.
    expect(dach.title).toBe('Fronius Anlage');
    expect(dach.alias).toBe('Dach Süd');
    // The un-renamed sibling is untouched.
    expect(c.parts.some((p) => p.label === 'Fronius Anlage WR 2')).toBe(true);
    // Every component row can be renamed; a loose source row cannot (assign it
    // to a component first).
    expect(c.parts.every((p) => p.entityId != null || p.note === UNASSIGNED_NOTE)).toBe(true);
  });
});
