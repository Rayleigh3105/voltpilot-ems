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
  it('aktiviert nur eine Automation je Regel (Eigenverbrauch ist Grundverhalten, kein Modus)', () => {
    expect(kinds(PRIVAT)).toEqual(['automation', 'automation']);
    const automations = activeModes(PRIVAT).filter((m) => m.kind === 'automation');
    expect(automations.map((m) => m.label)).toEqual([
      'Heizstab-Zeitplan',
      'Wallbox nur bei PV-Überschuss',
    ]);
    expect(automations.every((m) => m.origin === 'flow')).toBe(true);
    expect(automations[0].flowRef?.flowId).toBe('f-hz');
  });

  it('zeigt Telemetrie-Historie UND Fahrplan (base), aber NIRGENDS Marktpreise oder Prognose', () => {
    const s = anlageSurface(PRIVAT);
    expect(s.deepViews).toContain('telemetrie-historie');
    // Hotfix 2026-07-29: die Anlage hat einen Speicher, also plant der
    // Optimierer für sie - der Fahrplan gehört ihr, ganz ohne Modus.
    expect(s.deepViews).toContain('fahrplan');
    // Fester Tarif, keine Vermarktung: Marktwissen bleibt aus.
    expect(s.deepViews).not.toContain('marktpreise');
    expect(s.deepViews).not.toContain('prognosequalitaet');
    expect(s.deepViews).not.toContain('lastspitzen');
  });

  it('führt mit dem Energiefluss-Hub — kein Peak-Band, kein Handel-Block, kein EV-Block', () => {
    const ids = anlageSurface(PRIVAT).cockpitBlocks.map((b) => b.id);
    // Eigenverbrauch ist Grundverhalten: kein eigener Modus, also kein
    // Erlös-Strom und kein Eigenverbrauchs-Block - nur base + Geräte-Automatik.
    expect(ids).toEqual([
      'status',
      'energiefluss',
      'geraete-automatik',
      'toolbox-pointer',
    ]);
    expect(ids).not.toContain('peak-band');
    expect(ids).not.toContain('handel');
    expect(ids).not.toContain('eigenverbrauch');
    // Zwei Regeln, EIN Geräte-Automatik-Block - dann ohne einzelnen "von"-Tag.
    const automatik = anlageSurface(PRIVAT).cockpitBlocks.find(
      (b) => b.id === 'geraete-automatik',
    )!;
    expect(automatik.from).toBeNull();
  });

  it('hat KEINEN zugeordneten Geld-Strom (nur die unzugeordneten Automationen)', () => {
    const streams = anlageSurface(PRIVAT).moneyStreams;
    // Der Eigenverbrauchs-Wert wird von der MoneyView aus den Earnings gezeigt,
    // nicht als Modus-Strom projiziert (report §3.3).
    expect(streams.filter((s) => !s.unattributed)).toEqual([]);
    const automation = streams.filter((s) => s.unattributed);
    expect(automation).toHaveLength(2);
    expect(automation.every((s) => s.sources.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 · Gewerbe
// ---------------------------------------------------------------------------

describe('Ausprägung: Gewerbe', () => {
  it('aktiviert nur die Lastspitzenkappung (Eigenverbrauch ist Grundverhalten)', () => {
    expect(kinds(GEWERBE)).toEqual(['lastspitzenkappung']);
  });

  it('führt mit dem Peak-Band und zeigt den Lastspitzen-Strom mit seiner Periode', () => {
    const s = anlageSurface(GEWERBE);
    const ids = s.cockpitBlocks.map((b) => b.id);
    expect(ids[0]).toBe('status');
    expect(ids[1]).toBe('peak-band');
    expect(ids).not.toContain('handel');
    expect(ids).not.toContain('eigenverbrauch');
    expect(ids).not.toContain('geraete-automatik');
    expect(s.moneyStreams.map((m) => [m.id, m.period])).toEqual([
      ['lastspitzen', 'billing-period'],
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
    // MIG §5: die DV-Anlage weist aus, was sie WIRKLICH verdient hat -
    // Einspeise-Erlös (+ EV-Wert, hier ist ein dynamischer Tarif hinterlegt).
    // `savedEur` ist die Zurechnung UNTER dem Erlös, kein eigener Summand.
    expect(markt.manifest.moneyStreams.map((m) => m.sources)).toEqual([
      ['einspeiseErloesEur'],
      ['eigenverbrauchsWertEur'],
    ]);
    expect(markt.manifest.moneyStreams[0].attribution).toBe('steering');
  });

  it('MIG §5: ohne hinterlegten Tarif entfällt die EV-Wert-Zeile (statt ewiger "—")', () => {
    const ohneTarif: AnlageSurfaceInput = {
      ...MARKT,
      config: { ...MARKT.config!, tarifArt: 'ohne', netzladenErlaubt: false },
    };
    const markt = activeModes(ohneTarif).find((m) => m.kind === 'marktvermarktung')!;
    expect(markt.manifest.moneyStreams.map((m) => m.id)).toEqual(['einspeisung']);
  });

  it('MIG §5: zeigt Einspeise-Erlös + EV-Wert je einmal (Markt-Modus, dyn. Tarif)', () => {
    // Der Eigenverbrauchswert reist als Strom des Markt-Manifests (kein eigener
    // EV-Modus mehr, report §3.3) - jeder Strom erscheint genau einmal.
    const streams = anlageSurface(MARKT).moneyStreams;
    expect(streams.map((s) => s.id)).toEqual(['einspeisung', 'eigenverbrauchswert']);
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
    // Fester Tarif -> kein Markt-Modus (und Eigenverbrauch ist kein Modus mehr).
    expect(
      kinds({
        ...eigenverbrauchMitNetzladen,
        config: { ...eigenverbrauchMitNetzladen.config, tarifArt: 'fest' },
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4 · Multi-Modus
// ---------------------------------------------------------------------------

describe('Ausprägung: Multi-Modus', () => {
  it('aktiviert Peak + Markt + die Automation, kanonisch sortiert (kein EV-Modus)', () => {
    expect(kinds(MULTI)).toEqual([
      'lastspitzenkappung',
      'marktvermarktung',
      'automation',
    ]);
  });

  it('rendert vier Ströme — drei zugeordnet, die Automation ehrlich "—"', () => {
    // Der Markt-Modus (dyn. Tarif) trägt Einspeise-Erlös + EV-Wert, Peak den
    // Lastspitzen-Strom; die Automation bleibt unzugeordnet ("—").
    const streams = anlageSurface(MULTI).moneyStreams;
    expect(streams.map((s) => s.id)).toEqual([
      'lastspitzen',
      'einspeisung',
      'eigenverbrauchswert',
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
    const base = baseSurface({ entities: [PRODUCER, GRID] });
    expect(base.hasEntities).toBe(true);
    expect(base.blocks.map((b) => b.id)).toEqual(['status', 'energiefluss', 'toolbox-pointer']);
    expect(base.deepViews).toEqual(['live', 'geraete', 'telemetrie-historie', 'wetter']);
    expect(base.blocks.every((b) => b.from === null)).toBe(true);
  });

  it('nimmt frei gemappte Modbus-Kanäle als vollwertige Telemetrie auf (MB-M1)', () => {
    const modbus = entity('e-mb', 'modbus-generic', ['kessel_temp_c', 'zaehler_kwh']);
    const base = baseSurface({ entities: [BATTERY, modbus] });
    expect(base.telemetryChannels).toEqual([
      'battery_power_kw',
      'kessel_temp_c',
      'soc_pct',
      'zaehler_kwh',
    ]);
    expect(base.deepViews).toContain('telemetrie-historie');
  });

  it('verspricht keine Historie, wenn es keinen einzigen Kanal gibt', () => {
    const base = baseSurface({ entities: [{ id: 'e', entityType: 'wallbox', capabilities: null }] });
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
// Der Captain-Hotfix 2026-07-29: Fahrplan + Marktpreise sind Basis
// ---------------------------------------------------------------------------

describe('base: der Fahrplan hängt am Speicher, nicht am Modus (Hotfix 2026-07-29)', () => {
  /** Der GEMELDETE Vorfall: DV → Eigenverbrauch, fester Tarif, kein Modus mehr. */
  const UMGESTELLT: AnlageSurfaceInput = {
    signals: {
      hasStorage: true,
      hasPv: true,
      hasControllableConsumer: false,
      activeStrategyNodeTypes: [],
      plantKind: 'eigenverbrauch',
      hasLeistungspreis: false,
    },
    config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false },
    flows: [],
    entities: [BATTERY, PRODUCER],
  };

  it('hält den Fahrplan, obwohl KEIN einziger Modus mehr aktiv ist', () => {
    const s = anlageSurface(UMGESTELLT);
    expect(s.modes).toEqual([]);
    expect(s.base.deepViews).toContain('fahrplan');
    expect(s.deepViews).toContain('fahrplan');
  });

  it('zeigt einer Anlage OHNE Speicher keinen Fahrplan an der Basis', () => {
    const ohneSpeicher = anlageSurface({
      ...UMGESTELLT,
      signals: { ...UMGESTELLT.signals!, hasStorage: false },
      entities: [PRODUCER, GRID],
    });
    expect(ohneSpeicher.base.deepViews).not.toContain('fahrplan');
  });

  it('erkennt den Speicher auch dann, wenn die Profil-Antwort fehlt (fail-soft)', () => {
    // `api.usageProfile` ist fail-soft; ohne diesen Rückfall fiele der Fahrplan
    // bei einem Netz-Schluckauf aus der Navigation - genau die Fehlerklasse,
    // die der Hotfix behebt. Die Regel ist dieselbe wie serverseitig
    // (`topology.defaultRole`: soc_pct/battery_power_kw ⇒ Speicher).
    expect(baseSurface({ entities: [BATTERY] }).deepViews).toContain('fahrplan');
    expect(baseSurface({ entities: [entity('e', 'irgendwas', ['soc_pct'])] }).deepViews)
      .toContain('fahrplan');
    expect(baseSurface({ entities: [PRODUCER, GRID] }).deepViews).not.toContain('fahrplan');
  });

  it('zeigt Marktpreise bei dynamischem Tarif auch ohne Markt-Modus', () => {
    const boersentarif = anlageSurface({
      ...UMGESTELLT,
      config: { ...UMGESTELLT.config, tarifArt: 'dynamisch' },
    });
    expect(boersentarif.modes).toEqual([]);
    expect(boersentarif.base.deepViews).toContain('marktpreise');
    // Prognosequalität + Erlös-Historie bleiben modusgebunden (feedback.md).
    expect(boersentarif.deepViews).not.toContain('prognosequalitaet');
    expect(boersentarif.deepViews).not.toContain('erloes-historie');
  });

  it('zeigt bei festem/keinem Tarif KEINE Marktpreise', () => {
    expect(anlageSurface(UMGESTELLT).deepViews).not.toContain('marktpreise');
    expect(
      anlageSurface({ ...UMGESTELLT, config: { plantKind: 'eigenverbrauch' } }).deepViews,
    ).not.toContain('marktpreise');
  });

  it('dedupliziert: der Markt-Modus doppelt die Basis-Ansichten nicht', () => {
    const markt = anlageSurface({
      ...UMGESTELLT,
      config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
    });
    expect(hasMode(markt.modes, 'marktvermarktung')).toBe(true);
    expect(markt.deepViews.filter((v) => v === 'fahrplan')).toHaveLength(1);
    expect(markt.deepViews.filter((v) => v === 'marktpreise')).toHaveLength(1);
  });

  it('lässt eine Markt-Anlage OHNE Speicher ihren Fahrplan über den Modus behalten', () => {
    // Reichweite wird nie kleiner: ein DV-Park ohne Batterie behält den Zugang,
    // den er heute hat - er kommt dann eben aus dem Modus-Manifest.
    const park = anlageSurface({
      signals: {
        hasStorage: false,
        hasPv: true,
        activeStrategyNodeTypes: [],
        plantKind: 'direktvermarktung',
      },
      config: { plantKind: 'direktvermarktung', tarifArt: 'fest' },
      entities: [PRODUCER],
    });
    expect(park.base.deepViews).not.toContain('fahrplan');
    expect(park.deepViews).toContain('fahrplan');
  });

  it('erfindet auf einer nie migrierten Anlage nichts', () => {
    // Weder Signale noch Entitäten ⇒ kein Speicher-Nachweis ⇒ keine neue Ansicht.
    expect(anlageSurface({}).deepViews).toEqual([]);
    expect(
      anlageSurface({ config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' } }).deepViews,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Aktivierungsregeln im Detail
// ---------------------------------------------------------------------------

describe('activeModes: Aktivierungsregeln', () => {
  it('Speicher ∧ PV allein aktiviert KEINEN Modus (Eigenverbrauch ist Grundverhalten)', () => {
    // Eigenverbrauch ist kein wählbarer/abgeleiteter Modus mehr (report §3.3):
    // eine reine PV+Speicher-Haushaltsanlage ohne Markt/Peak trägt keine Modus-
    // Karte - ihre Eigenverbrauchs-Kennzahlen zeigt die MoneyView.
    const signals = { ...GEWERBE.signals!, hasLeistungspreis: false };
    const base = { ...GEWERBE, config: { plantKind: 'eigenverbrauch' as const } };
    expect(kinds({ ...base, signals })).toEqual([]);
    expect(kinds({ ...base, signals: { ...signals, hasPv: false } })).toEqual([]);
    expect(kinds({ ...base, signals: { ...signals, hasStorage: false } })).toEqual([]);
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
    expect(
      cockpitBlocks(baseSurface({ entities: [BATTERY] }), activeModes(input)).map((b) => b.id),
    ).not.toContain('erloes-komposition');
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
    const base = baseSurface({ entities: [BATTERY] });
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
    expect(tagged['geraete-automatik']).toBe('Wallbox nur bei PV-Überschuss');
    expect(tagged['energiefluss']).toBeNull();
    expect(tagged['status']).toBeNull();
  });

  it('liefert ohne Entitäten auch mit aktiven Modi keine Cockpit-Blöcke', () => {
    expect(cockpitBlocks(baseSurface({ entities: [] }), activeModes(GEWERBE))).toEqual([]);
  });

  it('moneyStreams/deepViews arbeiten auf einer leeren Modus-Menge', () => {
    expect(moneyStreams([])).toEqual([]);
    // Der Speicher bringt seit dem Hotfix 2026-07-29 den Fahrplan mit - ganz
    // ohne Modus (die Ansichten stehen in der kanonischen Reihenfolge).
    expect(deepViews(baseSurface({ entities: [BATTERY] }), [])).toEqual([
      'live',
      'geraete',
      'telemetrie-historie',
      'fahrplan',
      'wetter',
    ]);
  });
});

// ---------------------------------------------------------------------------
// v3.1-M1: ModeManifest.settings (additive Container-Ansprüche, report §2)
// ---------------------------------------------------------------------------

describe('ModeManifest.settings (v3.1-M1, additiv)', () => {
  it('markt beansprucht Speicherschonung + Netzladen + anzulegenden Wert + Tarif', () => {
    const markt = activeModes(MARKT)[0];
    expect(markt.manifest.settings).toEqual([
      'speicherschonung',
      'netzladen',
      'anzulegender-wert',
      'stromtarif',
    ]);
  });

  it('lastspitzenkappung beansprucht die drei Read-only-Ids', () => {
    const peak = activeModes(GEWERBE).find((m) => m.kind === 'lastspitzenkappung')!;
    expect(peak.manifest.settings).toEqual([
      'leistungspreis',
      'abrechnung-leistung',
      'lastspitzen-reserve',
    ]);
  });

  it('atypische Netznutzung und Automation beanspruchen keine Einstellung', () => {
    const atyp = activeModes({
      signals: { hasStorage: false, hasPv: false, activeStrategyNodeTypes: ['vp.strategy.atypical-grid'] },
      entities: [BATTERY],
    })[0];
    expect(atyp.manifest.settings).toEqual([]);
    const auto = activeModes(PRIVAT).find((m) => m.kind === 'automation')!;
    expect(auto.manifest.settings).toEqual([]);
  });

  it('eine leere Projektion trägt nirgends Settings (v1 byte-gleich)', () => {
    for (const mode of anlageSurface(LEER).modes) {
      expect(mode.manifest.settings).toEqual([]);
    }
    expect(anlageSurface(LEER).modes).toEqual([]);
  });
});

describe('M3-Overlay: `profileStates` ist rein additiv', () => {
  it('ohne profileStates ist das Ergebnis byte-gleich zu vorher', () => {
    for (const input of [PRIVAT, GEWERBE, MARKT, MULTI, LEER]) {
      const ohne = anlageSurface(input);
      expect(anlageSurface({ ...input, profileStates: null })).toEqual(ohne);
      expect(anlageSurface({ ...input, profileStates: undefined })).toEqual(ohne);
      expect(anlageSurface({ ...input, profileStates: {} })).toEqual(ohne);
    }
  });

  it('`aus` unterdrückt genau den einen Modus, alles andere bleibt', () => {
    const ohne = anlageSurface(MULTI);
    const aus = anlageSurface({ ...MULTI, profileStates: { marktvermarktung: 'aus' } });
    expect(ohne.modes.map((m) => m.kind)).toContain('marktvermarktung');
    expect(aus.modes.map((m) => m.kind)).not.toContain('marktvermarktung');
    expect(aus.modes.map((m) => m.kind)).toEqual(
      ohne.modes.map((m) => m.kind).filter((k) => k !== 'marktvermarktung'),
    );
  });
});
