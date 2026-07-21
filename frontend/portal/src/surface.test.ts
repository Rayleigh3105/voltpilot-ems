import { describe, expect, it } from 'vitest';
import type { FlowDocument } from './flows/model';
import {
  activeModes,
  anlageSurface,
  baseSurface,
  cockpitBlocks,
  deepViews,
  hasMode,
  moneyStreams,
  telemetryChannels,
  type AnlageSurfaceInput,
  type SurfaceEntity,
  type SurfaceFlow,
} from './surface';

// ---------------------------------------------------------------------------
// Fixtures — the five Ausprägungen of report §3
// ---------------------------------------------------------------------------

function doc(nodes: Array<{ id: string; type: string }>): FlowDocument {
  return {
    schema_version: '1.0',
    name: 'flow',
    runtime: 'edge',
    nodes: nodes.map((n) => ({ ...n, type_version: '1.0.0' })),
    edges: [],
    triggers: [],
  };
}

function flow(flowId: string, name: string, nodes: Array<{ id: string; type: string }>): SurfaceFlow {
  return {
    flowId,
    name,
    activeVersion: 1,
    latestLifecycle: 'active',
    latestDocument: doc(nodes),
  };
}

function entity(id: string, entityType: string, channels: string[]): SurfaceEntity {
  return {
    id,
    entityType,
    label: null,
    capabilities: { measure: channels.map((channel) => ({ channel })) },
  };
}

const BATTERY = entity('e-batt', 'battery-hybrid', ['soc_pct', 'battery_power_kw']);
const PRODUCER = entity('e-pv', 'producer', ['pv_power_kw']);
const GRID = entity('e-grid', 'grid-meter', ['power_kw']);
const WALLBOX = entity('e-wb', 'wallbox', ['power_kw']);
const HEIZSTAB = entity('e-hz', 'heating-rod', ['power_kw']);

/** 1 · Privat-EMS (Haus Sonnenweg 12): EV + zwei Automationen. */
const PRIVAT: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: true,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: false,
  },
  config: {
    plantKind: 'eigenverbrauch',
    tarifArt: 'fest',
    netzladenErlaubt: false,
    leistungspreisEurKw: null,
  },
  flows: [
    flow('f-wb', 'Wallbox nur bei PV-Überschuss', [
      { id: 'n1', type: 'vp.entity.read' },
      { id: 'n2', type: 'vp.entity.control' },
    ]),
    flow('f-hz', 'Heizstab-Zeitplan', [
      { id: 'n1', type: 'vp.schedule.window' },
      { id: 'n2', type: 'vp.entity.control' },
    ]),
  ],
  entities: [BATTERY, PRODUCER, GRID, WALLBOX, HEIZSTAB],
};

/** 2 · Gewerbe (Halle Nord): Peak + EV — die Union, die AE7 heute verliert. */
const GEWERBE: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: true,
  },
  config: {
    plantKind: 'eigenverbrauch',
    tarifArt: 'fest',
    netzladenErlaubt: false,
    leistungspreisEurKw: 120,
  },
  flows: [],
  entities: [BATTERY, PRODUCER, GRID],
};

/** 3 · Marktvermarktung (Solarpark Dachau): DV + Netzladen — ein Park, kein Haus. */
const MARKT: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'direktvermarktung',
    hasLeistungspreis: false,
  },
  config: {
    plantKind: 'direktvermarktung',
    tarifArt: 'dynamisch',
    netzladenErlaubt: true,
    leistungspreisEurKw: null,
  },
  flows: [],
  entities: [BATTERY, PRODUCER, GRID],
};

/** 4 · Multi-Modus (Hof Lindenberg): Peak + Markt + EV + Wallbox-Regel. */
const MULTI: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: true,
    activeStrategyNodeTypes: ['vp.strategy.market'],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: true,
  },
  config: {
    plantKind: 'eigenverbrauch',
    tarifArt: 'dynamisch',
    netzladenErlaubt: true,
    leistungspreisEurKw: 95,
  },
  flows: [
    flow('f-markt', 'Marktoptimierung', [
      { id: 'n1', type: 'vp.price.dayahead' },
      { id: 'n2', type: 'vp.strategy.market' },
    ]),
    flow('f-wb', 'Wallbox nur bei PV-Überschuss', [
      { id: 'n1', type: 'vp.entity.read' },
      { id: 'n2', type: 'vp.entity.control' },
    ]),
  ],
  entities: [BATTERY, PRODUCER, GRID, WALLBOX],
};

/** 5 · Neu / leer: keine Entitäten, keine Modi, keine Platzhalter. */
const LEER: AnlageSurfaceInput = {
  signals: {
    hasStorage: false,
    hasPv: false,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: false,
  },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne', netzladenErlaubt: false },
  flows: [],
  entities: [],
};

const kinds = (input: AnlageSurfaceInput) => activeModes(input).map((m) => m.kind);

// ---------------------------------------------------------------------------
// 1 · Privat-EMS
// ---------------------------------------------------------------------------

describe('Ausprägung: Privat-EMS', () => {
  it('aktiviert Eigenverbrauch plus eine Automation je Regel', () => {
    expect(kinds(PRIVAT)).toEqual(['eigenverbrauch', 'automation', 'automation']);
    const automations = activeModes(PRIVAT).filter((m) => m.kind === 'automation');
    expect(automations.map((m) => m.label)).toEqual([
      'Heizstab-Zeitplan',
      'Wallbox nur bei PV-Überschuss',
    ]);
    expect(automations.every((m) => m.origin === 'flow')).toBe(true);
    expect(automations[0].flowRef?.flowId).toBe('f-hz');
  });

  it('zeigt Telemetrie-Historie (base), aber NIRGENDS Marktpreise oder Prognose', () => {
    const s = anlageSurface(PRIVAT);
    expect(s.deepViews).toContain('telemetrie-historie');
    expect(s.deepViews).not.toContain('marktpreise');
    expect(s.deepViews).not.toContain('prognosequalitaet');
    expect(s.deepViews).not.toContain('lastspitzen');
    expect(s.deepViews).not.toContain('fahrplan');
  });

  it('führt mit dem Energiefluss-Hub — kein Peak-Band, kein Handel-Block', () => {
    const ids = anlageSurface(PRIVAT).cockpitBlocks.map((b) => b.id);
    expect(ids).toEqual([
      'status',
      'erloes-komposition',
      'energiefluss',
      'eigenverbrauch',
      'geraete-automatik',
      'toolbox-pointer',
    ]);
    expect(ids).not.toContain('peak-band');
    expect(ids).not.toContain('handel');
    // Zwei Regeln, EIN Geräte-Automatik-Block - dann ohne einzelnen "von"-Tag.
    const automatik = anlageSurface(PRIVAT).cockpitBlocks.find(
      (b) => b.id === 'geraete-automatik',
    )!;
    expect(automatik.from).toBeNull();
  });

  it('komponiert EV-Wert + Einspeisung und lässt die Automation ehrlich unzugeordnet', () => {
    const streams = anlageSurface(PRIVAT).moneyStreams;
    expect(streams.filter((s) => !s.unattributed).map((s) => s.id)).toEqual([
      'eigenverbrauchswert',
      'einspeisung',
    ]);
    const automation = streams.filter((s) => s.unattributed);
    expect(automation).toHaveLength(2);
    expect(automation.every((s) => s.sources.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 · Gewerbe
// ---------------------------------------------------------------------------

describe('Ausprägung: Gewerbe', () => {
  it('aktiviert die UNION aus Lastspitzenkappung und Eigenverbrauch (was AE7 verliert)', () => {
    expect(kinds(GEWERBE)).toEqual(['lastspitzenkappung', 'eigenverbrauch']);
  });

  it('führt mit dem Peak-Band und zeigt beide Geld-Ströme mit ihrer Periode', () => {
    const s = anlageSurface(GEWERBE);
    const ids = s.cockpitBlocks.map((b) => b.id);
    expect(ids[0]).toBe('status');
    expect(ids[1]).toBe('peak-band');
    expect(ids).not.toContain('handel');
    expect(ids).not.toContain('geraete-automatik');
    expect(s.moneyStreams.map((m) => [m.id, m.period])).toEqual([
      ['lastspitzen', 'billing-period'],
      ['eigenverbrauchswert', 'range'],
      ['einspeisung', 'range'],
    ]);
  });

  it('zeigt Telemetrie-Historie, aber weder Marktpreise noch Prognose', () => {
    const s = anlageSurface(GEWERBE);
    expect(s.deepViews).toContain('telemetrie-historie');
    expect(s.deepViews).toContain('lastspitzen');
    expect(s.deepViews).not.toContain('marktpreise');
    expect(s.deepViews).not.toContain('prognosequalitaet');
  });

  it('markiert den reinen Stammdaten-Modus als von VoltPilot eingerichtet (keine Flow-Affordanz)', () => {
    const peak = activeModes(GEWERBE).find((m) => m.kind === 'lastspitzenkappung')!;
    expect(peak.origin).toBe('masterdata');
    expect(peak.signals).toEqual(['leistungspreis']);
    expect(peak.flowRef).toBeNull();
    expect(peak.manifest.steuerungCard.managed).toBe(true);
    expect(peak.manifest.steuerungCard.action).toBe('none');
    expect(peak.manifest.steuerungCard.subLine).toBe('Von VoltPilot eingerichtet.');
  });
});

// ---------------------------------------------------------------------------
// 3 · Marktvermarktung
// ---------------------------------------------------------------------------

describe('Ausprägung: Marktvermarktung', () => {
  it('aktiviert NUR den Markt-Modus — ein Park bekommt kein Eigenverbrauchs-Cockpit', () => {
    expect(kinds(MARKT)).toEqual(['marktvermarktung']);
    expect(hasMode(activeModes(MARKT), 'eigenverbrauch')).toBe(false);
    const ids = anlageSurface(MARKT).cockpitBlocks.map((b) => b.id);
    expect(ids).toContain('handel');
    expect(ids).not.toContain('eigenverbrauch');
    expect(ids).not.toContain('peak-band');
    expect(ids).not.toContain('geraete-automatik');
  });

  it('bringt Marktpreise + Prognose als Modus-Deep-Views mit (nie global)', () => {
    const s = anlageSurface(MARKT);
    expect(s.deepViews).toContain('marktpreise');
    expect(s.deepViews).toContain('prognosequalitaet');
    expect(s.deepViews).toContain('fahrplan');
    // Telemetrie-Historie bleibt base - auch hier.
    expect(s.deepViews).toContain('telemetrie-historie');
    expect(s.deepViews).not.toContain('lastspitzen');
  });

  it('ist stammdatengetragen (plant_kind + Netzladen) und nennt beide Signale', () => {
    const markt = activeModes(MARKT)[0];
    expect(markt.signals).toEqual([
      'plant-kind-direktvermarktung',
      'netzladen-and-dynamic-tariff',
    ]);
    expect(markt.origin).toBe('masterdata');
    expect(markt.manifest.steuerungCard.line).toContain('teuer verkaufen');
    expect(markt.manifest.moneyStreams.map((m) => m.sources)).toEqual([
      ['savedEur', 'arbitrageEur'],
    ]);
  });

  it('F4: Netzladen + dynamischer Tarif zählt auch ohne Direktvermarktung als Markt', () => {
    const eigenverbrauchMitNetzladen: AnlageSurfaceInput = {
      ...GEWERBE,
      signals: { ...GEWERBE.signals!, hasLeistungspreis: false },
      config: {
        plantKind: 'eigenverbrauch',
        tarifArt: 'dynamisch',
        netzladenErlaubt: true,
        leistungspreisEurKw: null,
      },
    };
    const markt = activeModes(eigenverbrauchMitNetzladen).find(
      (m) => m.kind === 'marktvermarktung',
    )!;
    expect(markt.signals).toEqual(['netzladen-and-dynamic-tariff']);
    // Fester Tarif -> kein Markt-Modus.
    expect(
      kinds({
        ...eigenverbrauchMitNetzladen,
        config: { ...eigenverbrauchMitNetzladen.config, tarifArt: 'fest' },
      }),
    ).toEqual(['eigenverbrauch']);
  });
});

// ---------------------------------------------------------------------------
// 4 · Multi-Modus
// ---------------------------------------------------------------------------

describe('Ausprägung: Multi-Modus', () => {
  it('aktiviert Peak + Markt + Eigenverbrauch + die Automation, kanonisch sortiert', () => {
    expect(kinds(MULTI)).toEqual([
      'lastspitzenkappung',
      'marktvermarktung',
      'eigenverbrauch',
      'automation',
    ]);
  });

  it('rendert vier Ströme — drei zugeordnet, die Automation ehrlich "—"', () => {
    const streams = anlageSurface(MULTI).moneyStreams;
    expect(streams.map((s) => s.id)).toEqual([
      'lastspitzen',
      'handel',
      'eigenverbrauchswert',
      'einspeisung',
      'automation',
    ]);
    expect(streams.filter((s) => s.unattributed).map((s) => s.id)).toEqual(['automation']);
  });

  it('ordnet die Cockpit-Blöcke deterministisch nach §1.3', () => {
    expect(anlageSurface(MULTI).cockpitBlocks.map((b) => b.id)).toEqual([
      'status',
      'peak-band',
      'erloes-komposition',
      'energiefluss',
      'handel',
      'eigenverbrauch',
      'geraete-automatik',
      'toolbox-pointer',
    ]);
  });

  it('trennt flow-getragene von stammdatengetragenen Modi (die Ehrlichkeitsregel)', () => {
    const modes = activeModes(MULTI);
    const markt = modes.find((m) => m.kind === 'marktvermarktung')!;
    expect(markt.origin).toBe('flow');
    expect(markt.flowRef).toEqual({ flowId: 'f-markt', name: 'Marktoptimierung' });
    expect(markt.manifest.steuerungCard.action).toBe('open-flow');
    expect(markt.manifest.steuerungCard.managed).toBe(false);

    const peak = modes.find((m) => m.kind === 'lastspitzenkappung')!;
    expect(peak.origin).toBe('masterdata');
    expect(peak.manifest.steuerungCard.action).toBe('none');

    const ev = modes.find((m) => m.kind === 'eigenverbrauch')!;
    expect(ev.origin).toBe('masterdata');
  });

  it('vereinigt die Deep-Views aller Modi (der Union-Beweis)', () => {
    const s = anlageSurface(MULTI);
    for (const view of [
      'live',
      'geraete',
      'telemetrie-historie',
      'lastspitzen',
      'fahrplan',
      'erloes-historie',
      'marktpreise',
      'prognosequalitaet',
      'flow-editor',
      'wetter',
    ] as const) {
      expect(s.deepViews).toContain(view);
    }
    // dedupliziert: erloes-historie kommt aus drei Modi, erscheint aber einmal.
    expect(new Set(s.deepViews).size).toBe(s.deepViews.length);
  });
});

// ---------------------------------------------------------------------------
// 5 · Neu / leer
// ---------------------------------------------------------------------------

describe('Ausprägung: Neu / leer', () => {
  it('hat keine Modi, keine Blöcke, keine Deep-Views — keine Platzhalter', () => {
    const s = anlageSurface(LEER);
    expect(s.modes).toEqual([]);
    expect(s.base.hasEntities).toBe(false);
    expect(s.base.blocks).toEqual([]);
    expect(s.base.telemetryChannels).toEqual([]);
    expect(s.cockpitBlocks).toEqual([]);
    expect(s.moneyStreams).toEqual([]);
    expect(s.deepViews).toEqual([]);
  });

  it('bleibt leer, auch wenn nichts geladen ist (fail-soft)', () => {
    expect(anlageSurface({}).modes).toEqual([]);
    expect(anlageSurface({}).base.hasEntities).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// base(entities) — die Captain-Präzisierung
// ---------------------------------------------------------------------------

describe('base(entities)', () => {
  it('enthält Status, Energiefluss, Geräte, Live und die Telemetrie-Historie', () => {
    const base = baseSurface([BATTERY, PRODUCER]);
    expect(base.hasEntities).toBe(true);
    expect(base.blocks.map((b) => b.id)).toEqual(['status', 'energiefluss', 'toolbox-pointer']);
    expect(base.deepViews).toEqual(['live', 'geraete', 'telemetrie-historie', 'wetter']);
    expect(base.blocks.every((b) => b.from === null)).toBe(true);
  });

  it('nimmt frei gemappte Modbus-Kanäle als vollwertige Telemetrie auf (MB-M1)', () => {
    const modbus = entity('e-mb', 'modbus-generic', ['kessel_temp_c', 'zaehler_kwh']);
    const base = baseSurface([BATTERY, modbus]);
    expect(base.telemetryChannels).toEqual([
      'battery_power_kw',
      'kessel_temp_c',
      'soc_pct',
      'zaehler_kwh',
    ]);
    expect(base.deepViews).toContain('telemetrie-historie');
  });

  it('verspricht keine Historie, wenn es keinen einzigen Kanal gibt', () => {
    const base = baseSurface([{ id: 'e', entityType: 'wallbox', capabilities: null }]);
    expect(base.hasEntities).toBe(true);
    expect(base.telemetryChannels).toEqual([]);
    expect(base.deepViews).not.toContain('telemetrie-historie');
  });

  it('dedupliziert und sortiert Kanäle deterministisch', () => {
    expect(telemetryChannels([PRODUCER, GRID, WALLBOX])).toEqual(['power_kw', 'pv_power_kw']);
    expect(telemetryChannels(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aktivierungsregeln im Detail
// ---------------------------------------------------------------------------

describe('activeModes: Aktivierungsregeln', () => {
  it('aktiviert Eigenverbrauch aus Speicher ∧ PV — fehlt eines, bleibt er aus', () => {
    const signals = { ...GEWERBE.signals!, hasLeistungspreis: false };
    const base = { ...GEWERBE, config: { plantKind: 'eigenverbrauch' as const } };
    expect(kinds({ ...base, signals })).toEqual(['eigenverbrauch']);
    expect(kinds({ ...base, signals: { ...signals, hasPv: false } })).toEqual([]);
    expect(kinds({ ...base, signals: { ...signals, hasStorage: false } })).toEqual([]);
  });

  it('aktiviert Eigenverbrauch auf einer DV-Anlage nur über einen expliziten Flow', () => {
    expect(hasMode(activeModes(MARKT), 'eigenverbrauch')).toBe(false);
    const mitFlow: AnlageSurfaceInput = {
      ...MARKT,
      flows: [
        flow('f-ev', 'Eigenverbrauch', [{ id: 'n1', type: 'vp.strategy.selfconsumption' }]),
      ],
    };
    const ev = activeModes(mitFlow).find((m) => m.kind === 'eigenverbrauch')!;
    expect(ev.signals).toEqual(['strategy-node']);
    expect(ev.origin).toBe('flow');
    expect(ev.flowRef).toEqual({ flowId: 'f-ev', name: 'Eigenverbrauch' });
  });

  it('aktiviert Lastspitzenkappung auch ohne Leistungspreis über den Strategie-Knoten', () => {
    const input: AnlageSurfaceInput = {
      signals: {
        hasStorage: false,
        hasPv: false,
        activeStrategyNodeTypes: ['vp.strategy.peakshaving'],
      },
      config: { leistungspreisEurKw: null },
      entities: [BATTERY],
    };
    const peak = activeModes(input)[0];
    expect(peak.kind).toBe('lastspitzenkappung');
    expect(peak.signals).toEqual(['strategy-node']);
    expect(peak.origin).toBe('flow');
    // Signal ohne auflösbaren Flow -> keine "Flow öffnen"-Affordanz.
    expect(peak.flowRef).toBeNull();
    expect(peak.manifest.steuerungCard.action).toBe('none');
  });

  it('nennt beide Signale, wenn Stammdaten UND Flow den Modus tragen (Flow gewinnt)', () => {
    const input: AnlageSurfaceInput = {
      ...GEWERBE,
      flows: [
        flow('f-ps', 'Lastspitzenkappung', [{ id: 'n1', type: 'vp.strategy.peakshaving' }]),
      ],
    };
    const peak = activeModes(input).find((m) => m.kind === 'lastspitzenkappung')!;
    expect(peak.signals).toEqual(['leistungspreis', 'strategy-node']);
    expect(peak.origin).toBe('flow');
    expect(peak.manifest.steuerungCard.managed).toBe(false);
    expect(peak.manifest.steuerungCard.action).toBe('open-flow');
  });

  it('behandelt einen 0-€ oder fehlenden Leistungspreis als NICHT aktiv', () => {
    for (const value of [0, null, undefined, Number.NaN]) {
      const input: AnlageSurfaceInput = {
        ...GEWERBE,
        signals: { ...GEWERBE.signals!, hasLeistungspreis: false },
        config: { plantKind: 'eigenverbrauch', leistungspreisEurKw: value as number | null },
      };
      expect(hasMode(activeModes(input), 'lastspitzenkappung')).toBe(false);
    }
  });

  it('macht die atypische Netznutzung zum reinen Karten-Modus ("in Vorbereitung")', () => {
    const input: AnlageSurfaceInput = {
      signals: {
        hasStorage: false,
        hasPv: false,
        activeStrategyNodeTypes: ['vp.strategy.atypical-grid'],
      },
      entities: [BATTERY],
    };
    const mode = activeModes(input)[0];
    expect(mode.kind).toBe('atypische-netznutzung');
    expect(mode.preview).toBe(true);
    expect(mode.manifest.cockpitBlock).toBeNull();
    expect(mode.manifest.moneyStreams).toEqual([]);
    expect(mode.manifest.deepViews).toEqual([]);
    expect(mode.manifest.steuerungCard.action).toBe('none');
    expect(mode.manifest.steuerungCard.subLine).toBe('In Vorbereitung.');
    // Ein Karten-Modus erzeugt keine Erlös-Komposition.
    expect(cockpitBlocks(baseSurface([BATTERY]), activeModes(input)).map((b) => b.id)).not.toContain(
      'erloes-komposition',
    );
  });

  it('zählt nur AKTIVE Flows — Entwürfe und stillgelegte Flows sind keine Modi', () => {
    const input: AnlageSurfaceInput = {
      ...LEER,
      entities: [BATTERY],
      flows: [
        { ...flow('f-d', 'Entwurf', [{ id: 'n', type: 'vp.entity.control' }]), activeVersion: null, latestLifecycle: 'draft' },
        { ...flow('f-r', 'Stillgelegt', [{ id: 'n', type: 'vp.strategy.market' }]), activeVersion: null, latestLifecycle: 'retired' },
      ],
    };
    expect(activeModes(input)).toEqual([]);
  });

  it('ist deterministisch — dieselbe Eingabe, dieselbe Reihenfolge', () => {
    expect(activeModes(MULTI).map((m) => m.key)).toEqual(activeModes(MULTI).map((m) => m.key));
    expect(activeModes({ ...MULTI, flows: [...MULTI.flows!].reverse() }).map((m) => m.key)).toEqual(
      activeModes(MULTI).map((m) => m.key),
    );
  });
});

// ---------------------------------------------------------------------------
// Komposition
// ---------------------------------------------------------------------------

describe('Komposition', () => {
  it('blendet die Erlös-Komposition nur ein, wenn ein zugeordneter Strom existiert', () => {
    const base = baseSurface([BATTERY]);
    expect(cockpitBlocks(base, []).map((b) => b.id)).not.toContain('erloes-komposition');
    expect(cockpitBlocks(base, activeModes(GEWERBE)).map((b) => b.id)).toContain(
      'erloes-komposition',
    );
  });

  it('taggt jeden Modus-Block mit seinem Modus, base-Blöcke bleiben ungetaggt', () => {
    const blocks = anlageSurface(MULTI).cockpitBlocks;
    const tagged = Object.fromEntries(blocks.map((b) => [b.id, b.from]));
    expect(tagged['peak-band']).toBe('Lastspitzenkappung');
    expect(tagged['handel']).toBe('Marktvermarktung');
    expect(tagged['eigenverbrauch']).toBe('Eigenverbrauch');
    expect(tagged['geraete-automatik']).toBe('Wallbox nur bei PV-Überschuss');
    expect(tagged['energiefluss']).toBeNull();
    expect(tagged['status']).toBeNull();
  });

  it('liefert ohne Entitäten auch mit aktiven Modi keine Cockpit-Blöcke', () => {
    expect(cockpitBlocks(baseSurface([]), activeModes(GEWERBE))).toEqual([]);
  });

  it('moneyStreams/deepViews arbeiten auf einer leeren Modus-Menge', () => {
    expect(moneyStreams([])).toEqual([]);
    expect(deepViews(baseSurface([BATTERY]), [])).toEqual([
      'live',
      'geraete',
      'telemetrie-historie',
      'wetter',
    ]);
  });
});
