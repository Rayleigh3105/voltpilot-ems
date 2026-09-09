import { describe, expect, it } from 'vitest';
import { NO_DATA } from './nodata';
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

  it('V1: a missing SoC reads „noch keine Daten", NEVER „keine Batterie"', () => {
    // A storage node only exists when the plant HAS a battery - so a silent
    // device must not make the board deny the customer's most expensive asset
    // (both real plants, 13,8 kWh / 65 kWh, showed exactly that).
    const t = privatTopo();
    const storage = t.topology.nodes.find((n) => n.role === 'storage')!;
    storage.soc_pct = undefined;
    storage.value_kw = undefined;
    storage.flow_active = false;
    const tile = deriveTiles(t).find((x) => x.role === 'storage')!;
    expect(tile.stateLabel).toBe('noch keine Daten');
    expect(tile.stateLabel).not.toContain('keine Batterie');
    // X1: and the value is the ONE shared no-data mark, never a fabricated 0.
    expect(tile.value).toBe(NO_DATA);
    expect(tile.socPct).toBeUndefined();
  });

  it('X1: every tile renders the shared „—" when its value is absent', () => {
    const t = privatTopo();
    for (const n of t.topology.nodes) {
      n.value_kw = undefined;
      n.soc_pct = undefined;
      n.flow_active = false;
      n.members = n.members.map((m) => ({ ...m, value_kw: undefined }));
    }
    for (const tile of deriveTiles(t)) expect(tile.value).toBe(NO_DATA);
  });
});

describe('P5d · die HERKUNFT des Ladestands auf der Speicherkachel', () => {
  function mitHerkunft(code: number | null): SiteTopology {
    const topo = privatTopo();
    const batt = topo.entities.find((e) => e.id === 'batt')!;
    batt.capabilities = [
      { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 78 },
      { channel: 'soc_source_code', unit: '', role: null, primary: false, value: code },
    ];
    return topo;
  }

  function speicher(topo: SiteTopology) {
    return deriveTiles(topo).find((t) => t.role === 'storage')!;
  }

  it('nennt einen berechneten Ladestand berechnet', () => {
    expect(speicher(mitHerkunft(2)).herkunft).toBe('berechnet: Kennlinie');
    expect(speicher(mitHerkunft(3)).herkunft).toBe('berechnet: Ladungszählung');
    expect(speicher(mitHerkunft(1)).herkunft).toBe('gemessen');
  });

  /**
   * Fast jede über einen Katalog-Treiber gelesene Batterie meldet den Kanal
   * NIE. „gemessen" zu schreiben, weil nichts dagegenspricht, hätte sich die
   * Kachel ausgedacht - also steht dort gar nichts.
   */
  it('behauptet ohne den Herkunfts-Kanal gar nichts', () => {
    expect(speicher(privatTopo()).herkunft).toBeUndefined();
    expect(speicher(mitHerkunft(null)).herkunft).toBeUndefined();
    expect(speicher(mitHerkunft(0)).herkunft).toBeUndefined();
  });

  /** Ohne Ladestand gibt es nichts, dessen Herkunft man nennen könnte. */
  it('nennt keine Herkunft, wenn der Ladestand fehlt', () => {
    const topo = mitHerkunft(2);
    const node = topo.topology.nodes.find((n) => n.role === 'storage')!;
    delete (node as { soc_pct?: number }).soc_pct;
    expect(speicher(topo).herkunft).toBeUndefined();
    expect(speicher(topo).value).toBe(NO_DATA);
  });

  /** Der Zustand bleibt wahr: „Lädt" gilt auch, wenn die Zahl gerechnet ist. */
  it('ersetzt das Zustandswort NICHT', () => {
    const kachel = speicher(mitHerkunft(2));
    expect(kachel.stateLabel).toBe('Lädt');
    expect(kachel.subLine).toContain('Ladeleistung');
  });
});

describe('P6 · die Speiser-Bindung auf der Speicherkachel', () => {
  /**
   * Die gebundene Selbstbau-Batterie liefert den Ladestand, der
   * Hybrid-Wechselrichter die Leistung - genau der Live-Fall dieses Pakets: der
   * Deye im Spannungsmodus MISST keinen Ladestand, das DIYBMS rechnet ihn.
   */
  function gebunden(over: Partial<FlowNode> = {}): SiteTopology {
    const topo = privatTopo();
    const node = topo.topology.nodes.find((n) => n.role === 'storage')!;
    node.soc_source = { entity_id: 'diy', label: 'DIY-Speicher Keller' };
    node.soc_pct = 7.4;
    Object.assign(node, over);
    topo.entities.push({
      ...entity('diy', 'user-defined-battery', 'DIY-Speicher Keller'),
      capabilities: [
        { channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 7.4 },
        { channel: 'soc_source_code', unit: '', role: null, primary: false, value: 2 },
      ],
    });
    return topo;
  }

  function speicher(topo: SiteTopology) {
    return deriveTiles(topo).find((t) => t.role === 'storage')!;
  }

  it('sagt, von WELCHER Batterie der Ladestand kommt', () => {
    expect(speicher(gebunden()).socQuelle).toBe('Ladestand von: DIY-Speicher Keller');
  });

  /**
   * ⚠ Der Befund, den P6 nebenbei behebt: die Herkunft wurde bisher unter den
   * FLUSS-Mitgliedern gesucht. Eine gebundene Batterie ist keines - ihre
   * Kilowatt bleiben beim Wechselrichter -, also kam ein GERECHNETER Ladestand
   * ungekennzeichnet an der Kachel an.
   */
  it('findet die Herkunft an der gebundenen Batterie, nicht nur an den Mitgliedern', () => {
    expect(speicher(gebunden()).herkunft).toBe('berechnet: Kennlinie');
  });

  /**
   * Ein Hybrid, der seinen EIGENEN Ladestand meldet, bekommt die Zeile nicht:
   * „Ladestand von: Speicher" an einer Kachel, die schon „Speicher" heißt, ist
   * keine Auskunft.
   */
  it('schweigt, wenn der Ladestand vom Gerät der Kachel selbst kommt', () => {
    const topo = privatTopo();
    const node = topo.topology.nodes.find((n) => n.role === 'storage')!;
    node.soc_source = { entity_id: 'batt', label: 'Speicher' };
    expect(speicher(topo).socQuelle).toBeUndefined();
  });

  /** Ohne Ladestand gibt es nichts, dessen Quelle man nennen könnte. */
  it('nennt keine Quelle ohne Ladestand', () => {
    const topo = gebunden({ soc_pct: undefined });
    expect(speicher(topo).socQuelle).toBeUndefined();
  });

  it('zeigt die BMS-Grenzen, sobald eine Batterie welche meldet', () => {
    const topo = gebunden({
      limits: {
        source: { entity_id: 'diy', label: 'DIY-Speicher Keller' },
        charge_limit_a: 22,
        discharge_allowed: false,
      },
    });
    expect(speicher(topo).grenzen).toBe(`max. 22${NBSP}A laden · Entladen gesperrt`);
  });

  /**
   * ⚠ Ein ABWESENDES Feld wird übergangen, nie als „erlaubt" gelesen: eine
   * Batterie, die nur ihre Ladegrenze meldet, sagt nichts über das Entladen.
   */
  it('schreibt keine Freigabe hin, die niemand gegeben hat', () => {
    const topo = gebunden({
      limits: { source: { entity_id: 'diy', label: 'DIY' }, charge_limit_a: 22 },
    });
    expect(speicher(topo).grenzen).toBe(`max. 22${NBSP}A laden`);
    expect(speicher(gebunden()).grenzen).toBeUndefined();
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
