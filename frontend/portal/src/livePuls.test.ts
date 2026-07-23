import { describe, expect, it } from 'vitest';
import type { EntityHistory, SiteTopology, TelemetryPoint, TopologyEntity } from './api';
import type { FlowNode } from './topology';
import {
  componentRows,
  entitySparks,
  sparkFromEntityHistory,
  sparkFromPoints,
  v1FallbackRows,
  v1Pick,
  v1Sparks,
} from './livePuls';

/** fmtNum puts a non-breaking space before the unit. */
const NBSP = ' ';

// --- fixtures ----------------------------------------------------------------

function ent(
  id: string,
  entityType: string,
  channels: string[],
  health = 'ok',
): TopologyEntity {
  return {
    id,
    entityType,
    typeLabel: entityType,
    label: entityType,
    category: '',
    health,
    capabilities: channels.map((channel) => ({
      channel,
      unit: null,
      role: null,
      primary: false,
      value: null,
    })),
  };
}

const NODES: FlowNode[] = [
  {
    role: 'pv',
    value_kw: 6.4,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'pv', label: 'Fronius', primary: true, value_kw: 6.4 }],
  },
  {
    role: 'storage',
    value_kw: 2,
    soc_pct: 87,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'batt', label: 'Deye', primary: true, value_kw: 2 }],
  },
  {
    role: 'consumer',
    value_kw: 3.3,
    flow_active: true,
    direction: 'out',
    members: [{ entity_id: 'wb', label: 'Wallbox', primary: true, value_kw: 3.3 }],
  },
  {
    role: 'grid',
    value_kw: 1.2,
    flow_active: true,
    direction: 'in',
    members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: 1.2 }],
  },
];

const TOPO: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    ent('pv', 'producer', ['pv_power_kw']),
    ent('batt', 'battery-hybrid', ['soc_pct', 'battery_power_kw', 'pv_power_kw']),
    ent('wb', 'wallbox', ['power_kw'], 'stale'),
    ent('grid', 'grid-meter', ['power_kw']),
  ],
  topology: { schema_version: '1.0', nodes: NODES },
};

// --- componentRows -----------------------------------------------------------

describe('componentRows (v2, reusing the tile derivations)', () => {
  const rows = componentRows(TOPO);

  it('emits one row per component in role order: PV, Speicher, Verbraucher, Netz', () => {
    expect(rows.map((r) => r.role)).toEqual(['pv', 'storage', 'consumer', 'grid']);
  });

  it('carries the value + state word straight from deriveTiles (no re-derivation)', () => {
    const [pv, storage, wb, grid] = rows;
    expect(pv.value).toBe(`6,4${NBSP}kW`);
    expect(pv.stateLabel).toBe('erzeugt');
    expect(storage.value).toBe(`87${NBSP}%`);
    expect(storage.stateLabel).toBe('Lädt');
    expect(wb.value).toBe(`3,3${NBSP}kW`);
    expect(wb.stateLabel).toBe('lädt');
    expect(grid.stateLabel).toBe('Netzbezug');
  });

  it('resolves the „Verlauf →" / sparkline target to the representative channel', () => {
    expect(rows[0].target).toEqual({ entityId: 'pv', channel: 'pv_power_kw' });
    expect(rows[1].target).toEqual({ entityId: 'batt', channel: 'soc_pct' });
    expect(rows[2].target).toEqual({ entityId: 'wb', channel: 'power_kw' });
    expect(rows[3].target).toEqual({ entityId: 'grid', channel: 'power_kw' });
  });

  it('lists every Messwert of a component (the battery-hybrid has three)', () => {
    const storage = rows[1];
    expect(storage.channels.map((c) => c.label)).toEqual([
      'Ladestand',
      'Batterieleistung',
      'PV-Leistung',
    ]);
    expect(storage.channels[0].unit).toBe('%');
    expect(storage.channels[1].unit).toBe('kW');
  });

  it('takes the component health (a stale entity → an amber dot)', () => {
    expect(rows[2].health).toBe('stale');
    expect(rows[0].health).toBe('ok');
  });

  it('collapses a multi-producer PV role to ONE row with a subline (parts stay in the rail)', () => {
    const topo: SiteTopology = {
      ...TOPO,
      entities: [
        ...TOPO.entities,
        ent('pv2', 'producer', ['pv_power_kw']),
      ],
      topology: {
        schema_version: '1.0',
        nodes: [
          {
            role: 'pv',
            value_kw: 9.1,
            flow_active: true,
            direction: 'in',
            members: [
              { entity_id: 'pv', label: 'Fronius', primary: true, value_kw: 5.85 },
              { entity_id: 'pv2', label: 'Deye', primary: false, value_kw: 3.25 },
            ],
          },
          ...NODES.slice(1),
        ],
      },
    };
    const [pvRow] = componentRows(topo);
    expect(pvRow.subLine).toBe('2 Erzeuger');
    // The primary member is the representative jump; both parts are listed.
    expect(pvRow.target).toEqual({ entityId: 'pv', channel: 'pv_power_kw' });
    expect(pvRow.channels).toHaveLength(2);
  });

  it('resolves to an existing channel when the preferred one is absent', () => {
    // A grid meter that only measures grid_power_kw (not power_kw) still resolves.
    const topo: SiteTopology = {
      ...TOPO,
      entities: [ent('grid', 'grid-meter', ['grid_power_kw'])],
      topology: {
        schema_version: '1.0',
        nodes: [
          {
            role: 'grid',
            value_kw: 1,
            flow_active: true,
            direction: 'in',
            members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: 1 }],
          },
        ],
      },
    };
    expect(componentRows(topo)[0].target).toEqual({ entityId: 'grid', channel: 'grid_power_kw' });
  });
});

// --- v1 fallback rows --------------------------------------------------------

const pt = (over: Partial<TelemetryPoint>): TelemetryPoint => ({
  ts: '2026-07-06T10:00:00Z',
  powerKw: null,
  socPct: null,
  pvPowerKw: null,
  loadKw: null,
  gridLimitKw: null,
  ...over,
});

describe('v1FallbackRows (site-level, reusing live.ts states)', () => {
  const rows = v1FallbackRows([pt({ pvPowerKw: 4.7, loadKw: 1.1, powerKw: -2.4, socPct: 76 })]);

  it('emits the four site-level rows deep-linking into the v1 explorer tree', () => {
    expect(rows.map((r) => r.target)).toEqual([
      { entityId: 'anlage', channel: 'pv' },
      { entityId: 'anlage', channel: 'soc' },
      { entityId: 'anlage', channel: 'haus' },
      { entityId: 'anlage', channel: 'netz' },
    ]);
  });

  it('speaks direction words + carries derived charge power, never signs', () => {
    const [pv, storage, haus, netz] = rows;
    expect(pv.stateLabel).toBe('erzeugt');
    expect(storage.stateLabel).toBe('Lädt');
    expect(storage.subLine).toMatch(/^Ladeleistung/);
    expect(storage.socPct).toBe(76);
    expect(haus.stateLabel).toBe('aktueller Bedarf');
    // grid -2.4 → export → Einspeisung, value shown as a positive magnitude.
    expect(netz.stateLabel).toBe('Einspeisung');
    expect(netz.value).not.toMatch(/-/);
  });

  it('keeps an absent value as „–", never a fabricated 0', () => {
    const [, storage] = v1FallbackRows([pt({ pvPowerKw: 0 })]);
    expect(storage.value).toBe('–');
    expect(storage.stateLabel).toBe('keine Batterie');
  });
});

// --- sparklines --------------------------------------------------------------

const NOW = new Date('2026-07-06T10:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function entHistory(buckets: { start: string; avg: number | null }[]): EntityHistory {
  return {
    range: 'day',
    from: minsAgo(1440),
    to: NOW.toISOString(),
    bucketMinutes: 15,
    channels: {
      pv_power_kw: buckets.map((b) => ({
        start: b.start,
        avg: b.avg,
        min: b.avg,
        max: b.avg,
        last: b.avg,
        n: 1,
      })),
    },
  };
}

describe('sparkFromEntityHistory', () => {
  it('plucks only the trailing 60 minutes', () => {
    const h = entHistory([
      { start: minsAgo(120), avg: 9 }, // outside the window → dropped
      { start: minsAgo(45), avg: 3 },
      { start: minsAgo(15), avg: 6 },
      { start: minsAgo(2), avg: 5 },
    ]);
    const spark = sparkFromEntityHistory(h, 'pv_power_kw', NOW)!;
    expect(spark.values).toEqual([3, 6, 5]);
    expect(spark.min).toBe(3);
    expect(spark.max).toBe(6);
  });

  it('keeps a null bucket as an honest gap', () => {
    const h = entHistory([
      { start: minsAgo(45), avg: 3 },
      { start: minsAgo(30), avg: null },
      { start: minsAgo(15), avg: 6 },
    ]);
    expect(sparkFromEntityHistory(h, 'pv_power_kw', NOW)!.values).toEqual([3, null, 6]);
  });

  it('returns null when fewer than two finite points remain (no invented line)', () => {
    const h = entHistory([{ start: minsAgo(15), avg: 6 }]);
    expect(sparkFromEntityHistory(h, 'pv_power_kw', NOW)).toBeNull();
    // An unknown channel is also null (never throws).
    expect(sparkFromEntityHistory(h, 'nope', NOW)).toBeNull();
  });
});

describe('sparkFromPoints / v1Sparks', () => {
  const points = [
    pt({ ts: minsAgo(90), pvPowerKw: 9 }), // outside window
    pt({ ts: minsAgo(40), pvPowerKw: 2 }),
    pt({ ts: minsAgo(10), pvPowerKw: 4 }),
  ];

  it('plucks the last 60 minutes of a telemetry channel', () => {
    const spark = sparkFromPoints(points, v1Pick('pv'), NOW)!;
    expect(spark.values).toEqual([2, 4]);
  });

  it('keys the v1 sparks by row.key and honours the „too few points → null" rule', () => {
    const rows = v1FallbackRows(points);
    const sparks = v1Sparks(rows, points, NOW);
    expect(sparks.get('v1-pv')?.values).toEqual([2, 4]);
    // Only one non-null soc sample in-window → null (SoC never set here).
    expect(sparks.get('v1-soc')).toBeNull();
  });
});

describe('entitySparks', () => {
  it('maps each row to its entity history spark (missing history → null)', () => {
    const rows = componentRows(TOPO);
    const histories = new Map<string, EntityHistory>([
      [
        'pv',
        {
          range: 'day',
          from: minsAgo(1440),
          to: NOW.toISOString(),
          bucketMinutes: 15,
          channels: {
            pv_power_kw: [
              { start: minsAgo(30), avg: 3, min: 3, max: 3, last: 3, n: 1 },
              { start: minsAgo(5), avg: 6, min: 6, max: 6, last: 6, n: 1 },
            ],
          },
        },
      ],
    ]);
    const sparks = entitySparks(rows, histories, NOW);
    expect(sparks.get('role-pv')?.values).toEqual([3, 6]);
    // Storage entity has no history loaded → null (honest, no sparkline).
    expect(sparks.get('role-storage')).toBeNull();
  });
});
