import { describe, expect, it } from 'vitest';
import {
  findItem,
  firstTarget,
  flattenItems,
  measurementTree,
  parseVerlaufParams,
  rangeWord,
  seriesFromEntityHistory,
  v1FallbackTree,
  v1SeriesFromHistory,
  verlaufHash,
  verlaufStats,
  wordRange,
  V1_ENTITY,
} from './verlauf';
import type {
  EntityHistory,
  History,
  HistoryBucket,
  SiteEntities,
  SiteEntity,
  SiteTopology,
} from './api';

// --- fixtures ---------------------------------------------------------------

function entity(id: string, entityType: string, overrides: Partial<SiteEntity> = {}): SiteEntity {
  return {
    id,
    entityType,
    typeLabel: entityType,
    role: entityType,
    label: null,
    control: false,
    deviceId: 'gw',
    capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
    guards: null,
    syncStatus: 'in_sync',
    observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    edgeSourceId: null,
    ...overrides,
  };
}

/** A realistic migrated site: Speicher (composed), Netz, Haus + a modbus-generic. */
const entities: SiteEntities = {
  registry: null,
  entities: [
    entity('batt', 'battery-hybrid', {
      label: 'Batteriespeicher',
      control: true,
      capabilities: {
        measure: [
          { channel: 'soc_pct', unit: '%' },
          { channel: 'battery_power_kw', unit: 'kW' },
          { channel: 'pv_power_kw', unit: 'kW' },
        ],
      },
      observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    }),
    entity('grid', 'grid-meter', {
      label: 'Netzanschluss',
      capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
      observed: { health: 'stale', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
    }),
    entity('haus', 'house-load', {
      capabilities: { measure: [{ channel: 'power_kw', unit: 'kW' }] },
    }),
    // A modbus-generic device with an operator-declared open channel.
    entity('mb', 'modbus-generic', {
      label: 'Wärmepumpe',
      capabilities: { measure: [{ channel: 'temperature_c', unit: '°C' }, { channel: 'custom_foo' }] },
    }),
  ],
  localSetup: [
    { id: 'inv', kind: 'inverter', role: null, brand: 'deye', label: 'SUN-12K', reportedAt: '', adoptedEntityId: null },
  ],
  staleOnDevice: [],
};

const topology: SiteTopology = {
  schemaVersion: '1.0',
  entities: [
    { id: 'batt', entityType: 'battery-hybrid', typeLabel: 'Speicher', label: 'Batteriespeicher', category: 'storage', health: 'ok', capabilities: [] },
    { id: 'grid', entityType: 'grid-meter', typeLabel: 'Netz', label: 'Netzanschluss', category: 'meter', health: 'stale', capabilities: [] },
    { id: 'haus', entityType: 'house-load', typeLabel: 'Haus', label: null, category: 'consumer', health: 'ok', capabilities: [] },
    { id: 'mb', entityType: 'modbus-generic', typeLabel: 'Messgerät', label: 'Wärmepumpe', category: 'meter', health: 'ok', capabilities: [] },
  ],
  topology: { schema_version: '1.0', nodes: [] },
};

// --- measurementTree --------------------------------------------------------

describe('measurementTree', () => {
  const tree = measurementTree(entities, topology);

  it('produces one group per Komponente with its Messwerte and roles', () => {
    expect(tree.map((g) => g.label)).toEqual(['Batteriespeicher', 'Netzanschluss', 'Haus', 'Wärmepumpe']);
    expect(tree.map((g) => g.role)).toEqual(['storage', 'grid', 'house', 'grid']);
  });

  it('carries German channel labels + units, never raw channel names in the label', () => {
    const batt = tree[0];
    expect(batt.items.map((i) => i.label)).toEqual(['Ladestand', 'Batterieleistung', 'PV-Leistung']);
    expect(batt.items.map((i) => i.channel)).toEqual(['soc_pct', 'battery_power_kw', 'pv_power_kw']);
    expect(batt.items.map((i) => i.unit)).toEqual(['%', 'kW', 'kW']);
  });

  it('falls back to the raw name for an operator-declared modbus channel', () => {
    const mb = tree[3];
    // A declared channel we have a word for → German; an unknown one → its raw name.
    expect(mb.items.map((i) => i.label)).toEqual(['Temperatur', 'custom_foo']);
    // The unit hint fills in from the channel suffix when no German unit exists.
    expect(mb.items[0].unit).toBe('°C');
    expect(mb.items[1].unit).toBe('');
  });

  it('surfaces component health per component', () => {
    expect(tree[0].health).toBe('ok');
    expect(tree[1].health).toBe('stale');
  });

  it('carries a device attribution sub-line (device health, worst across its components)', () => {
    // The one inverter feeds the composed components; since it also feeds the
    // stale grid, the physical box reads stale in this fixture.
    expect(tree[0].deviceLine).toContain('SUN-12K');
    expect(tree[0].deviceLine).toContain('meldet gerade keine Daten');
    // With an all-healthy plant the sub-line reads "verbunden".
    const healthy = measurementTree(
      {
        ...entities,
        entities: [entity('b', 'battery-hybrid', { label: 'Speicher', capabilities: { measure: [{ channel: 'soc_pct', unit: '%' }] } })],
        localSetup: [{ id: 'inv', kind: 'inverter', role: null, brand: 'deye', label: 'SUN-12K', reportedAt: '', adoptedEntityId: null }],
      },
      null,
    );
    expect(healthy[0].deviceLine).toContain('verbunden');
  });

  it('drops a component with no measurable channel', () => {
    const noChannels = measurementTree(
      { ...entities, entities: [entity('empty', 'wallbox', { capabilities: { measure: [] } })] },
      null,
    );
    expect(noChannels).toEqual([]);
  });
});

// --- v1FallbackTree ---------------------------------------------------------

describe('v1FallbackTree', () => {
  const tree = v1FallbackTree();

  it('lists the site-level measurements under the shared synthetic entity', () => {
    expect(tree.map((g) => g.items[0].channel)).toEqual(['pv', 'haus', 'netz', 'soc']);
    expect(tree.every((g) => g.entityId === V1_ENTITY)).toBe(true);
    expect(tree.map((g) => g.role)).toEqual(['pv', 'house', 'grid', 'storage']);
  });

  it('labels groups by role and measurements by their German name, kW/% units', () => {
    expect(tree[0].label).toBe('PV-Erzeugung');
    expect(tree[0].items[0].label).toBe('PV-Leistung');
    expect(tree[3].items[0].unit).toBe('%');
    expect(tree[0].items[0].unit).toBe('kW');
  });
});

// --- tree helpers -----------------------------------------------------------

describe('tree helpers', () => {
  const tree = measurementTree(entities, topology);

  it('flattens items in rail order and finds the first target', () => {
    expect(flattenItems(tree).length).toBe(7);
    expect(firstTarget(tree)).toEqual({ entityId: 'batt', channel: 'soc_pct' });
  });

  it('resolves a deep-link target and returns null for an unknown one', () => {
    expect(findItem(tree, { entityId: 'grid', channel: 'power_kw' })?.label).toBe('Leistung');
    expect(findItem(tree, { entityId: 'grid', channel: 'nope' })).toBeNull();
    expect(findItem(tree, null)).toBeNull();
  });

  it('firstTarget is null for an empty tree', () => {
    expect(firstTarget([])).toBeNull();
  });
});

// --- deep-link params -------------------------------------------------------

describe('parseVerlaufParams / verlaufHash', () => {
  it('round-trips a full target through hash → params', () => {
    const hash = verlaufHash('site-1', { entityId: 'batt', channel: 'soc_pct' }, 'month', '2026-05-01');
    expect(hash).toBe('#/anlage/site-1/historie?m=batt:soc_pct&z=monat&at=2026-05-01');
    const p = parseVerlaufParams(hash);
    expect(p.target).toEqual({ entityId: 'batt', channel: 'soc_pct' });
    expect(p.range).toBe('month');
    expect(p.at).toBe('2026-05-01');
  });

  it('omits at when not given and defaults an unknown range word to day', () => {
    expect(verlaufHash('s', { entityId: 'e', channel: 'c' }, 'week')).toBe('#/anlage/s/historie?m=e:c&z=woche');
    const p = parseVerlaufParams('?m=e:c&z=quatsch');
    expect(p.range).toBe('day');
    expect(p.at).toBeNull();
  });

  it('parses a bare query and rejects malformed m / at', () => {
    expect(parseVerlaufParams('?z=jahr').target).toBeNull();
    expect(parseVerlaufParams('?m=noColon').target).toBeNull();
    expect(parseVerlaufParams('?m=:leading').target).toBeNull();
    expect(parseVerlaufParams('?m=trailing:').target).toBeNull();
    expect(parseVerlaufParams('?m=e:c&at=nonsense').at).toBeNull();
    expect(parseVerlaufParams('').target).toBeNull();
  });

  it('preserves a channel colon-free identity and maps range words both ways', () => {
    expect(rangeWord('year')).toBe('jahr');
    expect(wordRange('woche')).toBe('week');
    expect(wordRange(null)).toBe('day');
    // A UUID entityId + underscore channel survive the split.
    const p = parseVerlaufParams('?m=00000000-0000-0000-0000-000000000001:pv_power_kw');
    expect(p.target).toEqual({ entityId: '00000000-0000-0000-0000-000000000001', channel: 'pv_power_kw' });
  });
});

// --- series from entity history ---------------------------------------------

function eHist(range: EntityHistory['range'], buckets: EntityHistory['channels'][string]): EntityHistory {
  return { range, from: '', to: '', bucketMinutes: range === 'day' ? 15 : 60, channels: { soc_pct: buckets } };
}

describe('seriesFromEntityHistory', () => {
  it('day range = a plain line, no band', () => {
    const s = seriesFromEntityHistory(
      eHist('day', [
        { start: '2026-05-01T00:00:00Z', avg: 40, min: 40, max: 40, last: 40, n: 1 },
        { start: '2026-05-01T00:15:00Z', avg: 45, min: 45, max: 45, last: 45, n: 1 },
      ]),
      'soc_pct',
    );
    expect(s.isDay).toBe(true);
    expect(s.hasBand).toBe(false);
    expect(s.bars).toBe(false);
    expect(s.unit).toBe('%');
    expect(s.points.map((p) => p.avg)).toEqual([40, 45]);
    expect(s.empty).toBe(false);
  });

  it('week range = avg line + min/max band; unit from the channel hint', () => {
    const s = seriesFromEntityHistory(
      eHist('week', [{ start: '2026-05-01T00:00:00Z', avg: 50, min: 10, max: 90, last: 55, n: 4 }]),
      'soc_pct',
    );
    expect(s.hasBand).toBe(true);
    expect(s.points[0]).toMatchObject({ avg: 50, min: 10, max: 90, n: 4 });
  });

  it('an absent value stays null and an all-null series is empty', () => {
    const s = seriesFromEntityHistory(
      eHist('day', [{ start: '2026-05-01T00:00:00Z', avg: null, min: null, max: null, last: null, n: 0 }]),
      'soc_pct',
    );
    expect(s.points[0].avg).toBeNull();
    expect(s.empty).toBe(true);
  });

  it('a missing channel yields an empty series', () => {
    const s = seriesFromEntityHistory(eHist('day', []), 'not_there');
    expect(s.points).toEqual([]);
    expect(s.empty).toBe(true);
  });
});

// --- v1 series from History buckets -----------------------------------------

function bucket(o: Partial<HistoryBucket>): HistoryBucket {
  return {
    start: '2026-05-01T00:00:00Z',
    pvKwh: null,
    loadKwh: null,
    gridImportKwh: null,
    gridExportKwh: null,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
    ...o,
  };
}

function hist(range: History['range'], buckets: HistoryBucket[]): History {
  return {
    range,
    from: '',
    to: '',
    bucketMinutes: range === 'day' ? 15 : range === 'week' ? 60 : 1440,
    buckets,
    totals: {
      consumptionKwh: 0,
      pvGenerationKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      gridCostEur: null,
      batterySavingsEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
    },
    protocol: [],
    plan: [],
  };
}

describe('v1SeriesFromHistory', () => {
  it('day pv = kWh converted to average kW (× 60 / bucketMinutes), a line', () => {
    const s = v1SeriesFromHistory(hist('day', [bucket({ pvKwh: 1 })]), 'pv');
    expect(s.unit).toBe('kW');
    expect(s.isDay).toBe(true);
    expect(s.bars).toBe(false);
    // 1 kWh over a 15-min bucket = 4 kW.
    expect(s.points[0].avg).toBe(4);
  });

  it('week pv = raw kWh as bars', () => {
    const s = v1SeriesFromHistory(hist('week', [bucket({ pvKwh: 12 })]), 'pv');
    expect(s.unit).toBe('kWh');
    expect(s.bars).toBe(true);
    expect(s.points[0].avg).toBe(12);
  });

  it('netz = import minus export, honest about all-null', () => {
    const s = v1SeriesFromHistory(hist('week', [bucket({ gridImportKwh: 5, gridExportKwh: 2 })]), 'netz');
    expect(s.points[0].avg).toBe(3);
    const nul = v1SeriesFromHistory(hist('week', [bucket({})]), 'netz');
    expect(nul.points[0].avg).toBeNull();
    expect(nul.empty).toBe(true);
  });

  it('soc stays percent across ranges (no kWh conversion)', () => {
    const day = v1SeriesFromHistory(hist('day', [bucket({ socLastPct: 80 })]), 'soc');
    expect(day.unit).toBe('%');
    expect(day.points[0].avg).toBe(80);
    const week = v1SeriesFromHistory(hist('week', [bucket({ socLastPct: 80 })]), 'soc');
    expect(week.unit).toBe('%');
    expect(week.bars).toBe(false);
    expect(week.points[0].avg).toBe(80);
  });

  it('an unknown pseudo-channel yields an empty series', () => {
    const s = v1SeriesFromHistory(hist('day', [bucket({ pvKwh: 1 })]), 'mystery');
    expect(s.points).toEqual([]);
    expect(s.empty).toBe(true);
  });
});

// --- verlaufStats -----------------------------------------------------------

describe('verlaufStats', () => {
  it('computes min/max with time, weighted avg and the last value (band series)', () => {
    const s = seriesFromEntityHistory(
      eHist('week', [
        { start: '2026-05-01T00:00:00Z', avg: 40, min: 20, max: 60, last: 40, n: 2 },
        { start: '2026-05-02T00:00:00Z', avg: 70, min: 65, max: 95, last: 70, n: 2 },
      ]),
      'soc_pct',
    );
    const st = verlaufStats(s);
    expect(st.min).toEqual({ value: 20, t: '2026-05-01T00:00:00Z' });
    expect(st.max).toEqual({ value: 95, t: '2026-05-02T00:00:00Z' });
    // weighted mean = (40*2 + 70*2) / 4 = 55.
    expect(st.avg).toBe(55);
    expect(st.last).toBe(70);
  });

  it('uses the point value for min/max when there is no band (day/v1)', () => {
    const s = v1SeriesFromHistory(
      hist('day', [bucket({ pvKwh: 0.25 }), bucket({ start: '2026-05-01T00:15:00Z', pvKwh: 0.75 })]),
      'pv',
    );
    const st = verlaufStats(s);
    // 0.25 kWh/15min = 1 kW ; 0.75 kWh/15min = 3 kW.
    expect(st.min?.value).toBe(1);
    expect(st.max?.value).toBe(3);
    expect(st.last).toBe(3);
  });

  it('is all-null for an empty series', () => {
    const st = verlaufStats(seriesFromEntityHistory(eHist('day', []), 'x'));
    expect(st).toEqual({ min: null, max: null, avg: null, last: null });
  });

  it('skips null points without crashing', () => {
    const s = seriesFromEntityHistory(
      eHist('day', [
        { start: '2026-05-01T00:00:00Z', avg: null, min: null, max: null, last: null, n: 0 },
        { start: '2026-05-01T00:15:00Z', avg: 12, min: null, max: null, last: 12, n: 1 },
      ]),
      'soc_pct',
    );
    const st = verlaufStats(s);
    expect(st.min?.value).toBe(12);
    expect(st.max?.value).toBe(12);
    expect(st.avg).toBe(12);
    expect(st.last).toBe(12);
  });
});
