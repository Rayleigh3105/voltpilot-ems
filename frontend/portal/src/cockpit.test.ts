import { describe, expect, it } from 'vitest';
import {
  automationRows,
  cockpitStack,
  coverUntil,
  dominantWindow,
  eigenverbrauchBlock,
  handelBlock,
  hasBlock,
  planWindows,
  projectionActive,
  windowHours,
  TELEMETRIE_HISTORIE,
  type CockpitSlot,
} from './cockpit';
import { leadBlock } from './leadSlot';
import type { EarningsSite } from './api';
import type { FlowDocument } from './flows/model';
import {
  activeModes,
  anlageSurface,
  type AnlageSurfaceInput,
  type SurfaceEntity,
  type SurfaceFlow,
} from './surface';

// ---------------------------------------------------------------------------
// Fixtures — die fünf Ausprägungen (report §3), gespiegelt zu surface.test.ts
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
  return { flowId, name, activeVersion: 1, latestLifecycle: 'active', latestDocument: doc(nodes) };
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

const PRIVAT: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: true,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: false,
  },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', netzladenErlaubt: false },
  flows: [
    flow('f-wb', 'Wallbox nur bei PV-Überschuss', [
      { id: 'n1', type: 'vp.entity.read' },
      { id: 'n2', type: 'vp.entity.control' },
    ]),
  ],
  entities: [BATTERY, PRODUCER, GRID, WALLBOX],
};

const GEWERBE: AnlageSurfaceInput = {
  signals: {
    hasStorage: true,
    hasPv: true,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: true,
  },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest', leistungspreisEurKw: 120 },
  flows: [],
  entities: [BATTERY, PRODUCER, GRID],
};

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
  },
  entities: [BATTERY, PRODUCER, GRID],
};

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

const LEER: AnlageSurfaceInput = {
  signals: {
    hasStorage: false,
    hasPv: false,
    hasControllableConsumer: false,
    activeStrategyNodeTypes: [],
    plantKind: 'eigenverbrauch',
    hasLeistungspreis: false,
  },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' },
  entities: [],
};

/** Der gerenderte Stapel einer Ausprägung: Block-Ids in Reihenfolge. */
function stackIds(input: AnlageSurfaceInput): string[] {
  const s = anlageSurface(input);
  return cockpitStack(s.cockpitBlocks, leadBlock(s.cockpitBlocks)).map((b) => b.id);
}

// ---------------------------------------------------------------------------
// §1.3 — die deterministische Blockreihenfolge
// ---------------------------------------------------------------------------

describe('cockpitStack — die kanonische Reihenfolge (report §1.3)', () => {
  it('Multi-Modus rendert Peak → Erlös → Energiefluss → Handel → Automatik (kein EV-Block)', () => {
    expect(stackIds(MULTI)).toEqual([
      'peak-band',
      'erloes-komposition',
      'energiefluss',
      'handel',
      'geraete-automatik',
    ]);
  });

  it('Status und Toolbox-Zeile sind keine Kartenblöcke (Kopf bzw. Fußzeile)', () => {
    const s = anlageSurface(MULTI);
    expect(s.cockpitBlocks.map((b) => b.id)).toContain('status');
    expect(s.cockpitBlocks.map((b) => b.id)).toContain('toolbox-pointer');
    expect(stackIds(MULTI)).not.toContain('status');
    expect(stackIds(MULTI)).not.toContain('toolbox-pointer');
  });

  it('sortiert unabhängig von der Eingabereihenfolge (kein Flackern)', () => {
    const s = anlageSurface(MULTI);
    const shuffled = [...s.cockpitBlocks].reverse();
    expect(cockpitStack(shuffled, null).map((b) => b.id)).toEqual(stackIds(MULTI));
  });

  it('jeder Block trägt sein „von"-Tag; Basis-Blöcke sagen „Entitäten"', () => {
    const s = anlageSurface(MULTI);
    const views = cockpitStack(s.cockpitBlocks, null);
    const byId = Object.fromEntries(views.map((v) => [v.id, v]));
    expect(byId['handel'].fromTag).toBe('Marktvermarktung');
    expect(byId['handel'].isBase).toBe(false);
    expect(byId['peak-band'].fromTag).toBe('Lastspitzenkappung');
    expect(byId['energiefluss'].fromTag).toBe('Komponenten');
    expect(byId['energiefluss'].isBase).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §1.3 — die N-äre Führungsregel (peak → money → flow)
// ---------------------------------------------------------------------------

describe('leadBlock — peak → money → flow', () => {
  const lead = (input: AnlageSurfaceInput) => leadBlock(anlageSurface(input).cockpitBlocks);

  it('eine Peak-Anlage führt mit dem Peak-Band', () => {
    expect(lead(GEWERBE)).toBe('peak-band');
    expect(lead(MULTI)).toBe('peak-band');
  });

  it('ohne Peak führt Geld', () => {
    expect(lead(MARKT)).toBe('erloes-komposition');
  });

  it('eine reine Privat-/Fluss-Anlage führt mit dem Hub', () => {
    // Eigenverbrauch ist kein Geld-Modus mehr (report §3.3), also führt schon
    // eine reine PV+Speicher+Automation-Anlage mit dem Hub - hier eine Anlage
    // ganz ohne Geld-Modus: Entitäten + nur eine Automation.
    const nurAutomation: AnlageSurfaceInput = {
      signals: {
        hasStorage: false,
        hasPv: false,
        hasControllableConsumer: true,
        activeStrategyNodeTypes: [],
        plantKind: 'eigenverbrauch',
        hasLeistungspreis: false,
      },
      config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' },
      flows: [
        flow('f-wb', 'Wallbox-Regel', [
          { id: 'n1', type: 'vp.entity.read' },
          { id: 'n2', type: 'vp.entity.control' },
        ]),
      ],
      entities: [WALLBOX, GRID],
    };
    expect(lead(nurAutomation)).toBe('energiefluss');
    expect(stackIds(nurAutomation)).toEqual(['energiefluss', 'geraete-automatik']);
  });

  it('„Neu / leer" hat keinen führenden Block (das Cockpit ist der Einrichtungspfad)', () => {
    expect(lead(LEER)).toBeNull();
    expect(stackIds(LEER)).toEqual([]);
  });

  it('markiert genau EINEN Block als führend, ohne die Reihenfolge zu ändern', () => {
    const s = anlageSurface(MULTI);
    const views = cockpitStack(s.cockpitBlocks, leadBlock(s.cockpitBlocks));
    expect(views.filter((v) => v.lead).map((v) => v.id)).toEqual(['peak-band']);
    expect(views.map((v) => v.id)).toEqual(stackIds(MULTI));
  });
});

// ---------------------------------------------------------------------------
// §3 — die Ausprägungen halten (Kategoriefehler unmöglich)
// ---------------------------------------------------------------------------

describe('Ausprägungen (report §3)', () => {
  it('Privat: Hub + Automatik — KEIN Peak, KEIN Handel, KEIN EV-Block', () => {
    const ids = stackIds(PRIVAT);
    expect(ids).toContain('energiefluss');
    expect(ids).toContain('geraete-automatik');
    expect(ids).not.toContain('eigenverbrauch');
    expect(ids).not.toContain('peak-band');
    expect(ids).not.toContain('handel');
  });

  it('Park (Marktvermarktung): Handel — KEIN Eigenverbrauchs-/„Haus"-Block', () => {
    const ids = stackIds(MARKT);
    expect(ids).toContain('handel');
    expect(ids).not.toContain('eigenverbrauch');
    expect(ids).not.toContain('peak-band');
    expect(ids).not.toContain('geraete-automatik');
  });

  it('Gewerbe: Peak, kein Handel, keine Automatik, kein EV-Block', () => {
    const ids = stackIds(GEWERBE);
    expect(ids).toEqual(['peak-band', 'erloes-komposition', 'energiefluss']);
  });
});

// ---------------------------------------------------------------------------
// §2.2 — Drill-ins; Telemetrie-Historie ist BASIS, getrennt von der Erlös-Historie
// ---------------------------------------------------------------------------

describe('Block-Drill-ins (report §2.2 + feedback.md)', () => {
  const drills = (input: AnlageSurfaceInput) => {
    const s = anlageSurface(input);
    return cockpitStack(s.cockpitBlocks, null).flatMap((b) =>
      b.drillIns.map((d) => `${b.id}:${d.sub}:${d.label}`),
    );
  };

  it('die Tiefen-Sichten hängen an ihrem besitzenden Block', () => {
    const d = drills(MULTI);
    expect(d).toContain('peak-band:lastspitzen:Lastspitzen im Detail');
    expect(d).toContain('erloes-komposition:erloese:Erlöse im Detail');
    // Cockpit+Live-Merge (Option A): die Live-Tiefe lebt IM Cockpit selbst
    // (Komponenten-Board) — der Energiefluss-Block behält nur den
    // Kanal-Verlauf-Drill-in; ein „Live im Detail"-Absprung existiert nicht mehr.
    expect(d).toContain('energiefluss:messwerte:Verlauf');
    expect(d.some((x) => x.includes(':live:'))).toBe(false);
    expect(d).toContain('handel:fahrplan:Ganzer Fahrplan');
    expect(d).toContain('geraete-automatik:steuerung:Steuerung');
  });

  it('die Telemetrie-Historie („Verlauf") hängt am BASIS-Block — in JEDEM Modus', () => {
    for (const input of [PRIVAT, GEWERBE, MARKT, MULTI]) {
      const s = anlageSurface(input);
      const hub = cockpitStack(s.cockpitBlocks, null).find((b) => b.id === 'energiefluss');
      expect(hub?.isBase).toBe(true);
      expect(hub?.drillIns).toContainEqual(TELEMETRIE_HISTORIE);
    }
  });

  it('sie ist NICHT die Erlös-Historie — und seit H1 auch eine andere ROUTE', () => {
    // Zwei Welten (Captain-Struktur H1, 30.07.2026): die Trennung, die dieses
    // Modul beschreibt, ist jetzt auch eine der Adressen — Telemetrie-Verlauf
    // auf `messwerte`, Geld auf `erloese`.
    const s = anlageSurface(MARKT);
    const views = cockpitStack(s.cockpitBlocks, null);
    const hub = views.find((b) => b.id === 'energiefluss');
    const geld = views.find((b) => b.id === 'erloes-komposition');
    const verlauf = hub?.drillIns.find((d) => d.label === 'Verlauf');
    const erloes = geld?.drillIns[0];
    expect(verlauf?.sub).toBe('messwerte');
    expect(erloes?.sub).toBe('erloese');
    expect(verlauf?.label).not.toBe(erloes?.label);
    expect(verlauf?.hint).toMatch(/getrennt von den Erlösen/);
  });

  it('kein Modus beansprucht die Telemetrie-Historie', () => {
    for (const input of [PRIVAT, GEWERBE, MARKT, MULTI]) {
      for (const mode of activeModes(input)) {
        expect(mode.manifest.deepViews).not.toContain('telemetrie-historie');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §6.2 — der v1-Riegel
// ---------------------------------------------------------------------------

describe('projectionActive — der v1-Rückfall (report §6.2)', () => {
  it('eine nie migrierte Anlage bleibt v1', () => {
    expect(projectionActive({ hasEntities: false, adaptive: false })).toBe(false);
    expect(projectionActive({ hasEntities: false, adaptive: true })).toBe(false);
  });

  it('beide Tore müssen offen sein', () => {
    expect(projectionActive({ hasEntities: true, adaptive: false })).toBe(false);
    expect(projectionActive({ hasEntities: true, adaptive: true })).toBe(true);
  });

  it('null/undefined (älteres Backend, Ladefehler) fällt auf v1 zurück', () => {
    expect(projectionActive({ hasEntities: null, adaptive: null })).toBe(false);
    expect(projectionActive({ hasEntities: undefined, adaptive: undefined })).toBe(false);
    expect(projectionActive({ hasEntities: true, adaptive: undefined })).toBe(false);
  });

  it('„Neu / leer" erzeugt keinen Stapel', () => {
    expect(projectionActive({ hasEntities: anlageSurface(LEER).base.hasEntities, adaptive: true })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Handel-Block
// ---------------------------------------------------------------------------

const DAY = '2026-07-21';
const NOW = new Date(`${DAY}T12:00:00`);

function slot(hhmm: string, batteryKw: number, gridKw: number, priceEurMwh: number | null): CockpitSlot {
  return { start: `${DAY}T${hhmm}:00`, batteryKw, gridKw, pvKw: 0, curtailKw: 0, priceEurMwh };
}

/** Nachts günstig laden (02–04), abends verkaufen (19–21). */
const TRADING_DAY: CockpitSlot[] = [
  slot('02:00', 4, 4, 40),
  slot('02:15', 4, 4, 40),
  slot('02:30', 4, 4, 40),
  slot('02:45', 4, 4, 40),
  slot('03:00', 4, 4, 40),
  slot('19:00', -6, -6, 120),
  slot('19:15', -6, -6, 120),
  slot('19:30', -6, -6, 120),
  slot('20:00', -6, -6, 120),
];

function money(overrides: Partial<EarningsSite> = {}): EarningsSite {
  return {
    id: 's-1',
    name: 'Solarpark Dachau',
    plantKind: 'direktvermarktung',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: null,
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 0,
    firstCoveredDate: null,
    reason: null,
    dailySaved: [],
    tarifArt: 'dynamisch',
    tarifParamCtKwh: null,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    gesamtertragEur: null,
    selbstverbrauchKwh: null,
    eingespeistKwh: null,
    batterieBewegtKwh: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [],
    monthlyStrip: [],
    ...overrides,
  };
}

describe('handelBlock — die Handels-Erzählung aus BESTEHENDEN Daten', () => {
  it('nennt Verdienst, Ladefenster und geplanten Verkauf', () => {
    const view = handelBlock({
      money: money({ savedEur: 38.4, arbitrageEur: 21.1 }),
      slots: TRADING_DAY,
      now: NOW,
      periodLabel: 'Heute',
    });
    expect(view.tiles.map((t) => t.label)).toEqual(['Durch Steuerung · Heute', 'Geladen', 'Verkauf geplant']);
    expect(view.tiles[0].value).toContain('38,40');
    expect(view.tiles[0].sub).toContain('21,10');
    expect(view.tiles[1].value).toBe('02–04 Uhr');
    expect(view.tiles[1].sub).toBe('Ø 4,00 ct/kWh');
    expect(view.tiles[2].value).toBe('19–21 Uhr');
    expect(view.tiles[2].sub).toBe('Ø 12,00 ct/kWh erwartet');
  });

  it('zeigt das Marktprämien-Kleingedruckte nur bei hinterlegtem anzulegendem Wert', () => {
    expect(
      handelBlock({ money: money({ savedEur: 1 }), slots: [], now: NOW, periodLabel: 'Heute' })
        .praemieNote,
    ).toBeNull();
    expect(
      handelBlock({
        money: money({ savedEur: 1, anzulegenderWertCtKwh: 8.11 }),
        slots: [],
        now: NOW,
        periodLabel: 'Heute',
      }).praemieNote,
    ).toMatch(/Marktprämie/);
  });

  it('erfindet nichts: ohne Zahlen entfällt die Kachel, ohne Kacheln der Inhalt', () => {
    const view = handelBlock({ money: money(), slots: [], now: NOW, periodLabel: 'Heute' });
    expect(view.tiles).toEqual([]);
    expect(view.isEmpty).toBe(true);
  });

  it('ohne Preisdaten bleibt die Ø-Preis-Zeile weg (statt 0 ct/kWh)', () => {
    const view = handelBlock({
      money: money(),
      slots: [slot('02:00', 4, 4, null), slot('02:15', 4, 4, null)],
      now: NOW,
      periodLabel: 'Heute',
    });
    expect(view.tiles[0].label).toBe('Geladen');
    expect(view.tiles[0].sub).toBeNull();
  });
});

describe('planWindows / windowHours', () => {
  it('fasst zusammenhängende Slots zu einem Fenster zusammen', () => {
    const w = planWindows(TRADING_DAY, 'laden', NOW);
    expect(w).toHaveLength(1);
    expect(windowHours(w[0])).toBe('02–04 Uhr');
  });

  it('trennt bei einer echten Lücke', () => {
    const w = planWindows(
      [slot('02:00', 4, 4, 40), slot('06:00', 4, 4, 40), slot('06:15', 5, 5, 40)],
      'laden',
      NOW,
    );
    expect(w).toHaveLength(2);
    expect(dominantWindow(w)).toBe(w[1]);
  });

  it('ignoriert Slots des Vortages/Folgetages', () => {
    expect(
      planWindows([{ start: '2026-07-20T02:00:00', batteryKw: 9, gridKw: 9 }], 'laden', NOW),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Eigenverbrauchs-Block
// ---------------------------------------------------------------------------

describe('eigenverbrauchBlock — Autarkie · PV-Nutzung · reicht-bis', () => {
  it('rendert die drei Kacheln aus den Historie-Totals + dem Fahrplan', () => {
    const view = eigenverbrauchBlock({
      autarkiePct: 82,
      eigenverbrauchPct: 64,
      gridImportKwh: 1.8,
      slots: TRADING_DAY,
      now: NOW,
    });
    expect(view.tiles.map((t) => t.label)).toEqual([
      'Autarkie heute',
      'PV selbst genutzt',
      'Heute Abend',
    ]);
    expect(view.tiles[0].value).toContain('82');
    expect(view.tiles[0].sub).toContain('1,8');
    expect(view.tiles[2].sub).toBe('Speicher reicht bis ca. 21 Uhr');
  });

  it('erfindet keine 0 %: ohne Totals entfallen die Kacheln', () => {
    const view = eigenverbrauchBlock({
      autarkiePct: null,
      eigenverbrauchPct: undefined,
      slots: [],
      now: NOW,
    });
    expect(view.tiles).toEqual([]);
    expect(view.isEmpty).toBe(true);
  });

  it('coverUntil sieht nur noch BEVORSTEHENDE Entlade-Slots', () => {
    expect(coverUntil(TRADING_DAY, NOW)).toBe('21 Uhr');
    // Nach dem letzten Entladen wird nichts mehr behauptet.
    expect(coverUntil(TRADING_DAY, new Date(`${DAY}T22:00:00`))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Geräte-Automatik
// ---------------------------------------------------------------------------

describe('automationRows', () => {
  it('eine Zeile je Automation, ohne erfundene €-Zurechnung', () => {
    const rows = automationRows(activeModes(MULTI));
    expect(rows.map((r) => r.name)).toEqual(['Wallbox nur bei PV-Überschuss']);
    expect(rows[0].line).not.toMatch(/€/);
  });

  it('Strategie-Modi sind keine Automationen', () => {
    expect(automationRows(activeModes(GEWERBE))).toEqual([]);
  });
});

describe('hasBlock', () => {
  it('erkennt vorhandene Blöcke und toleriert null', () => {
    const blocks = anlageSurface(MULTI).cockpitBlocks;
    expect(hasBlock(blocks, 'handel')).toBe(true);
    expect(hasBlock(blocks, 'toolbox-pointer')).toBe(true);
    expect(hasBlock(anlageSurface(PRIVAT).cockpitBlocks, 'handel')).toBe(false);
    expect(hasBlock(null, 'handel')).toBe(false);
  });
});
