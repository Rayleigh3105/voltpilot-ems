import { describe, expect, it } from 'vitest';
import type { SiteTopology, TopologyEntity } from './api';
import { deriveTiles, hasTopology, liveState } from './adaptiveLive';
import type { FlowNode } from './topology';

const NBSP = ' ';

function entity(id: string, entityType: string, label: string): TopologyEntity {
  return { id, entityType, typeLabel: label, label, category: '', health: 'ok', capabilities: [] };
}

/** A Privat-Haushalt topology: PV, charging battery, wallbox + idle heating rod, export. */
function privatTopo(): SiteTopology {
  const nodes: FlowNode[] = [
    {
      role: 'pv',
      value_kw: 6.4,
      flow_active: true,
      direction: 'in',
      members: [{ entity_id: 'pv', label: 'PV', primary: true, value_kw: 6.4 }],
    },
    {
      role: 'storage',
      value_kw: 3.5,
      soc_pct: 78,
      flow_active: true,
      direction: 'out', // charging
      members: [{ entity_id: 'batt', label: 'Speicher', primary: true, value_kw: 3.5 }],
    },
    {
      role: 'consumer',
      value_kw: 7.2,
      flow_active: true,
      direction: 'out',
      members: [
        { entity_id: 'wb', label: 'Wallbox', primary: true, value_kw: 7.2 },
        { entity_id: 'hz', label: 'Heizstab', primary: false, value_kw: 0 },
      ],
    },
    {
      role: 'grid',
      value_kw: 1.1,
      flow_active: true,
      direction: 'out', // export
      members: [{ entity_id: 'grid', label: 'Netz', primary: true, value_kw: -1.1 }],
    },
  ];
  return {
    schemaVersion: '1.0',
    entities: [
      entity('pv', 'producer', 'PV'),
      entity('batt', 'battery-hybrid', 'Speicher'),
      entity('wb', 'wallbox', 'Wallbox'),
      entity('hz', 'heating-rod', 'Heizstab'),
      entity('grid', 'grid-meter', 'Netz'),
    ],
    topology: { schema_version: '1.0', nodes },
  };
}

describe('deriveTiles', () => {
  it('makes one tile per role plus one per consumer, in mockup order', () => {
    const tiles = deriveTiles(privatTopo());
    expect(tiles.map((t) => t.role)).toEqual(['pv', 'storage', 'consumer', 'consumer', 'grid']);
    const wb = tiles.find((t) => t.title === 'Wallbox')!;
    expect(wb.stateLabel).toBe('lädt');
    // the wallbox is controllable -> read-only switches; the heating rod idle.
    expect(wb.control?.options).toEqual(['Aus', 'Nur PV', 'Voll']);
    const hz = tiles.find((t) => t.title === 'Heizstab')!;
    expect(hz.stateLabel).toBe('aus');
    expect(hz.control?.options).toEqual(['Auto', 'An', 'Aus']);
  });

  it('drives the storage tile off SoC + charge/discharge', () => {
    const t = deriveTiles(privatTopo()).find((x) => x.role === 'storage')!;
    expect(t.value).toBe(`78${NBSP}%`);
    expect(t.stateLabel).toBe('Lädt');
    expect(t.arrow).toBe('up');
    expect(t.socPct).toBe(78);
  });

  it('flips the grid tile between Bezug and Einspeisung and hides signs', () => {
    const t = deriveTiles(privatTopo()).find((x) => x.role === 'grid')!;
    expect(t.stateLabel).toBe('Einspeisung');
    expect(t.value).toBe(`1,1${NBSP}kW`); // abs, never negative
    expect(t.arrow).toBe('down');
  });

  it('skips a role absent from the topology (never a fake 0)', () => {
    const t = privatTopo();
    t.topology.nodes = t.topology.nodes.filter((n) => n.role !== 'storage');
    expect(deriveTiles(t).some((x) => x.role === 'storage')).toBe(false);
  });
});

describe('hasTopology', () => {
  it('is true only with entities AND nodes', () => {
    expect(hasTopology(privatTopo())).toBe(true);
    expect(hasTopology(null)).toBe(false);
    expect(
      hasTopology({ schemaVersion: '1.0', entities: [], topology: { schema_version: '1.0', nodes: [] } }),
    ).toBe(false);
  });
});

// G3: the live surface used to contradict itself - a green "Stand vor 7 Sek."
// chip and a full Verlauf chart next to "Ihre Anlage meldet gerade keine
// aktuellen Daten" and grey "wartet auf Daten" tiles. Two independent sources
// (the Anlage's v1 telemetry vs. the per-entity v2 health) were each speaking
// for the whole page. `liveState` is the ONE truth both now read.
describe('liveState - the ONE freshness truth (G3)', () => {
  it('is live as soon as any entity delivers', () => {
    expect(liveState({ entityFresh: true, siteFresh: false })).toBe('live');
    expect(liveState({ entityFresh: true, siteFresh: null })).toBe('live');
  });

  it('is site-only when the Anlage reports but the entities do not', () => {
    expect(liveState({ entityFresh: false, siteFresh: true })).toBe('site-only');
  });

  it('is stale only when NEITHER source is current', () => {
    expect(liveState({ entityFresh: false, siteFresh: false })).toBe('stale');
    expect(liveState({ entityFresh: false, siteFresh: null })).toBe('stale');
    expect(liveState({ entityFresh: false, siteFresh: undefined })).toBe('stale');
  });
});
