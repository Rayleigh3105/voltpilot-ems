import { describe, expect, it } from 'vitest';
import {
  cockpitHero,
  cockpitWidgets,
  netzDirectionLabel,
  speicherStateLine,
  type CockpitWidgetsInput,
  type WidgetId,
} from './cockpitWidgets';
import { DASH } from './erloesKomposition';
import { anlageSurface, type AnlageSurfaceInput, type SurfaceEntity } from './surface';
import { leadBlock } from './leadSlot';
import type { EarningsSite, HistoryTotals } from './api';
import { NBSP } from './format';

/**
 * Portal v3 · M2 — der **Kachel-Beweis**.
 *
 * Der Anspruch (M2-Akzeptanz 4 + BUILD.md §4.1/§4.2): das Widget-Raster ist die
 * PROJEKTION — es gibt genau die Kacheln, deren Modus/Quelle wirklich existiert,
 * in kanonischer Reihenfolge; was fehlt, **entfällt** statt als 0 dazustehen.
 * Hier stehen die fünf Ausprägungen aus dem Read-Model samt ihrer NEGATIV-
 * Beweise (was NICHT erscheinen darf).
 */

const NOW = new Date('2026-07-22T12:00:00+02:00');

function entity(id: string, entityType: string, channels: string[]): SurfaceEntity {
  return {
    id,
    entityType,
    label: null,
    capabilities: { measure: channels.map((channel) => ({ channel })) },
  };
}

const PILOT_ENTITIES = [
  entity('e-batt', 'battery-hybrid', ['soc_pct', 'battery_power_kw', 'pv_power_kw']),
  entity('e-grid', 'grid-meter', ['power_kw']),
  entity('e-haus', 'house-load', ['load_kw']),
];

/** Privat: Speicher + PV, kein Markt, kein Peak. */
const PRIVAT: AnlageSurfaceInput = {
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
  entities: PILOT_ENTITIES,
};

/** Gewerbe: Leistungspreis → Lastspitzenkappung. */
const GEWERBE: AnlageSurfaceInput = {
  ...PRIVAT,
  signals: { ...PRIVAT.signals!, hasLeistungspreis: true },
  config: { ...PRIVAT.config!, leistungspreisEurKw: 95 },
};

/** Markt: Direktvermarktung (kein Eigenverbrauchs-Modus, report §3). */
const MARKT: AnlageSurfaceInput = {
  ...PRIVAT,
  signals: { ...PRIVAT.signals!, plantKind: 'direktvermarktung' },
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch', netzladenErlaubt: true },
};

/** Multi: Peak + Markt + Automation. */
const MULTI: AnlageSurfaceInput = {
  ...GEWERBE,
  signals: { ...GEWERBE.signals!, plantKind: 'direktvermarktung', hasControllableConsumer: true },
  config: {
    plantKind: 'direktvermarktung',
    tarifArt: 'dynamisch',
    netzladenErlaubt: true,
    leistungspreisEurKw: 95,
  },
  flows: [
    {
      flowId: 'f-wb',
      name: 'Wallbox nur bei PV-Überschuss',
      activeVersion: 1,
      latestLifecycle: 'active',
      latestDocument: {
        schema_version: '1.0',
        name: 'Wallbox nur bei PV-Überschuss',
        runtime: 'edge',
        nodes: [
          { id: 'n1', type: 'vp.entity.read', type_version: '1.0.0' },
          { id: 'n2', type: 'vp.entity.control', type_version: '1.0.0' },
        ],
        edges: [],
        triggers: [],
      },
    },
  ],
};

/** Leer: nie migriert. */
const LEER: AnlageSurfaceInput = { signals: undefined, config: undefined, entities: [] };

const TOTALS: HistoryTotals = {
  consumptionKwh: 18.4,
  pvGenerationKwh: 32.1,
  gridImportKwh: 3.2,
  gridExportKwh: 9.6,
  gridCostEur: 0.94,
  batterySavingsEur: 1.2,
  autarkiePct: 82,
  eigenverbrauchPct: 64,
};

const SNAPSHOT = { pvKw: 5.4, loadKw: 1.9, gridKw: -2.1, battKw: 1.4, socPct: 76, socAt: null };

function money(over: Partial<EarningsSite> = {}): EarningsSite {
  return {
    einspeiseErloesEur: 12.5,
    eigenverbrauchsWertEur: 4.5,
    gesamtertragEur: 17,
    savedEur: 3.25,
    arbitrageEur: null,
    anzulegenderWertCtKwh: null,
    peakShaving: null,
    ...over,
  } as unknown as EarningsSite;
}

function build(
  site: AnlageSurfaceInput,
  over: Partial<CockpitWidgetsInput> = {},
): CockpitWidgetsInput {
  const surface = anlageSurface(site);
  return {
    blocks: surface.cockpitBlocks,
    modes: surface.modes,
    lead: leadBlock(surface.cockpitBlocks),
    channels: surface.base.telemetryChannels,
    snapshot: SNAPSHOT,
    dayTotals: TOTALS,
    money: money(),
    streams: surface.moneyStreams,
    range: 'month',
    now: NOW,
    slots: [],
    ...over,
  };
}

function ids(site: AnlageSurfaceInput, over: Partial<CockpitWidgetsInput> = {}): WidgetId[] {
  return cockpitWidgets(build(site, over)).map((w) => w.id);
}

describe('Das Widget-Raster folgt der Projektion', () => {
  it('Privat: Fluss-Kacheln + Erlöse + Eigenverbrauch — KEIN Handel, KEINE Lastspitze', () => {
    const set = ids(PRIVAT);
    expect(set).toContain('erzeugung');
    expect(set).toContain('speicher');
    expect(set).toContain('haus');
    expect(set).toContain('netz');
    expect(set).toContain('eigenverbrauch');
    // Negativ-Beweise.
    expect(set).not.toContain('handel');
    expect(set).not.toContain('lastspitze');
    expect(set).not.toContain('automatik');
  });

  it('Gewerbe: die Lastspitze-Kachel existiert nur MIT Peak-Sicht', () => {
    // Modul aktiv, aber noch keine Peak-Sicht geladen → keine erfundene Kachel.
    expect(ids(GEWERBE)).not.toContain('lastspitze');
    const withPeak = ids(GEWERBE, {
      peak: {
        currentLabel: '12,0 kW',
        fresh: true,
        targetLabel: '15,0 kW',
        hasTarget: true,
        fillPct: 60,
        limitPct: 80,
        scaleMaxLabel: '18,0 kW',
        breach: false,
        metrics: [{ label: 'Vermiedene Spitze', value: '4,0 kW' }],
        note: null,
      },
    });
    expect(withPeak).toContain('lastspitze');
    // Die Führung markiert, ohne umzusortieren: Peak steht vorn.
    expect(withPeak[0]).toBe('lastspitze');
  });

  it('Markt: Handel statt Eigenverbrauch (ein Park kennt kein „Haus"-Modus)', () => {
    const set = ids(MARKT, {
      slots: [
        { start: '2026-07-22T11:00:00+02:00', batteryKw: -4, gridKw: -4, pvKw: 0, priceEurMwh: 220 },
      ],
    });
    expect(set).toContain('handel');
    expect(set).not.toContain('eigenverbrauch');
  });

  it('Multi: alle Modus-Kacheln, Automatik inklusive', () => {
    const set = ids(MULTI);
    expect(set).toContain('automatik');
    expect(set).toContain('handel');
  });

  it('Leer (nie migriert): das Raster ist leer — keine einzige Platzhalter-Kachel', () => {
    expect(cockpitWidgets(build(LEER))).toEqual([]);
    // Auch mit vollen Live-Daten: ohne Blöcke gibt es keine Kacheln.
    expect(cockpitWidgets({ ...build(LEER), snapshot: SNAPSHOT, dayTotals: TOTALS })).toEqual([]);
  });

  it('ist deterministisch: dieselbe Eingabe ergibt dieselbe Reihenfolge', () => {
    expect(ids(MULTI)).toEqual(ids(MULTI));
  });
});

describe('Ehrlichkeit: weglassen statt 0', () => {
  it('ohne Kanal und ohne Wert entfällt die Kachel ganz', () => {
    // Eine reine PV-Anlage ohne Speicher-Kanal und ohne SoC.
    const surface = anlageSurface({
      ...PRIVAT,
      entities: [entity('e-pv', 'producer', ['pv_power_kw'])],
    });
    const set = cockpitWidgets({
      ...build(PRIVAT),
      blocks: surface.cockpitBlocks,
      channels: surface.base.telemetryChannels,
      snapshot: { pvKw: 5.4, loadKw: null, gridKw: null, battKw: null, socPct: null, socAt: null },
    }).map((w) => w.id);
    expect(set).toContain('erzeugung');
    expect(set).not.toContain('speicher');
    expect(set).not.toContain('haus');
    expect(set).not.toContain('netz');
  });

  it('mit Kanal, aber ohne aktuellen Wert steht „—" — nie eine 0', () => {
    const w = cockpitWidgets(
      build(PRIVAT, {
        snapshot: { pvKw: null, loadKw: null, gridKw: null, battKw: null, socPct: null, socAt: null },
      }),
    );
    const erz = w.find((x) => x.id === 'erzeugung')!;
    expect(erz.value).toBe(DASH);
    const netz = w.find((x) => x.id === 'netz')!;
    expect(netz.value).toBe(DASH);
    expect(netz.sub).toBeNull();
  });

  it('die Wetter-Kachel erscheint nur mit Wetterdaten', () => {
    expect(ids(PRIVAT)).not.toContain('wetter');
    expect(ids(PRIVAT, { weather: { nextHourTempC: 21, why: null } })).toContain('wetter');
    expect(ids(PRIVAT, { weather: { nextHourTempC: null, why: null } })).not.toContain('wetter');
  });

  it('beide Modal-Gesichter lesen dieselbe Zahl wie die Kachel', () => {
    const speicher = cockpitWidgets(build(PRIVAT)).find((w) => w.id === 'speicher')!;
    expect(speicher.value).toBe(`76${NBSP}%`);
    expect(speicher.modal.jetzt.rows[0]).toMatchObject({ label: 'Ladestand', value: `76${NBSP}%` });
    // Das Verlauf-Gesicht erfindet keine zweite Ableitung, es zeigt den Weg.
    expect(speicher.modal.verlauf.rows).toEqual([]);
    expect(speicher.modal.verlauf.drillIn?.sub).toBe('live');
  });

  it('der Umgang mit dem Speicher erscheint nur, wenn er bekannt ist', () => {
    const without = cockpitWidgets(build(PRIVAT)).find((w) => w.id === 'speicher')!;
    expect(without.modal.jetzt.rows.map((r) => r.label)).not.toContain('Umgang mit dem Speicher');
    const withIt = cockpitWidgets(build(PRIVAT, { speicherschonung: 'schonend' })).find(
      (w) => w.id === 'speicher',
    )!;
    expect(withIt.modal.jetzt.rows.map((r) => r.value)).toContain('Schonend');
  });
});

describe('Vorzeichen erreichen den Kunden nie', () => {
  it('der Speicher-Zustand ist ein Wort, keine Richtung', () => {
    expect(speicherStateLine(2)).toBe(`lädt mit 2,0${NBSP}kW`);
    expect(speicherStateLine(-2)).toBe(`entlädt mit 2,0${NBSP}kW`);
    expect(speicherStateLine(0)).toBe('ruht gerade');
    expect(speicherStateLine(null)).toBeNull();
  });

  it('das Netz nennt Bezug/Einspeisung, nie ein Minus', () => {
    expect(netzDirectionLabel(3)).toBe('Netzbezug');
    expect(netzDirectionLabel(-3)).toBe('Einspeisung');
    expect(netzDirectionLabel(0)).toBe('ausgeglichen');
    expect(netzDirectionLabel(undefined)).toBeNull();
    const netz = cockpitWidgets(build(PRIVAT)).find((w) => w.id === 'netz')!;
    expect(netz.value).toBe(`2,1${NBSP}kW`);
    expect(netz.sub).toBe('Einspeisung');
  });
});

describe('Der Hero', () => {
  it('trägt Autarkie und Eigenverbrauch als Ringe', () => {
    const hero = cockpitHero({ dayTotals: TOTALS, money: money(), range: 'month', now: NOW });
    expect(hero.rings.map((r) => r.id)).toEqual(['autarkie', 'eigenverbrauch']);
    expect(hero.rings[0].valueText).toBe(`82${NBSP}%`);
    expect(hero.rings[0].pct).toBe(82);
  });

  it('lässt einen Ring WEG, wenn der Tageswert fehlt (nie 0 %)', () => {
    const hero = cockpitHero({
      dayTotals: { ...TOTALS, autarkiePct: null },
      money: money(),
      range: 'month',
      now: NOW,
    });
    expect(hero.rings.map((r) => r.id)).toEqual(['eigenverbrauch']);
    const none = cockpitHero({ dayTotals: null, money: null, range: 'month', now: NOW });
    expect(none.rings).toEqual([]);
    expect(none.money).toBeNull();
  });

  it('stellt die Steuerungs-Zurechnung als UNTERZEILE, nie als eigenen Summanden', () => {
    const hero = cockpitHero({ dayTotals: TOTALS, money: money(), range: 'month', now: NOW });
    expect(hero.money?.value).toBe(`17,00${NBSP}€`);
    expect(hero.money?.attribution).toContain('durch VoltPilots Steuerung');
    // Die Zurechnung wird NICHT zur Summe addiert.
    expect(hero.money?.value).not.toContain('20');
  });

  it('nennt keine Fahrplan-Zeile ohne Plan', () => {
    expect(cockpitHero({ range: 'month', now: NOW }).planSentence).toBeNull();
  });
});
