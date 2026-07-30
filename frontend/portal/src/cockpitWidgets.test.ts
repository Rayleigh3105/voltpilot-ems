import { describe, expect, it } from 'vitest';
import {
  cockpitHero,
  cockpitWidgets,
  historyRangeForCockpit,
  type CockpitWidgetsInput,
  type WidgetId,
} from './cockpitWidgets';
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
 * Beweise (was NICHT erscheinen darf). Seit dem Cockpit+Live-Merge (Option A,
 * R2) gibt es KEINE Fluss-Kacheln mehr — das Komponenten-Board im Cockpit ist
 * die eine Live-Wert-Fläche; das Raster trägt nur Geld-/Modus-Kacheln.
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
  tarifArt: 'dynamisch',
  batterySavingsPlannedEur: 1.2,
  autarkiePct: 82,
  eigenverbrauchPct: 64,
};

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
  it('Privat: kein Handel, keine Lastspitze, KEIN Eigenverbrauchs-Widget (Grundverhalten)', () => {
    const set = ids(PRIVAT);
    // Eigenverbrauch ist kein Modus mehr (report §3.3) - kein Modus-Block, also
    // keine EV-Kachel im Raster (der Wert lebt in den Hero-Ringen/der MoneyView).
    expect(set).not.toContain('eigenverbrauch');
    expect(set).not.toContain('handel');
    expect(set).not.toContain('lastspitze');
    expect(set).not.toContain('automatik');
  });

  it('R2 (Cockpit+Live-Merge): es gibt KEINE Fluss-Kacheln mehr — nie', () => {
    // Das Komponenten-Board ist die eine Live-Wert-Fläche; die vier früheren
    // Fluss-Kacheln (Erzeugung/Speicher/Haus/Netz) existieren im Raster nicht.
    for (const site of [PRIVAT, GEWERBE, MARKT, MULTI]) {
      const set: string[] = ids(site);
      for (const gone of ['erzeugung', 'speicher', 'haus', 'netz']) {
        expect(set).not.toContain(gone);
      }
    }
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
    // Auch mit vollen Tages-/Wetterdaten: ohne Blöcke gibt es keine Kacheln.
    expect(
      cockpitWidgets({
        ...build(LEER),
        dayTotals: TOTALS,
        weather: { nextHourTempC: 21, why: 'Sonnig bis 18 Uhr.' },
      }),
    ).toEqual([]);
  });

  it('ist deterministisch: dieselbe Eingabe ergibt dieselbe Reihenfolge', () => {
    expect(ids(MULTI)).toEqual(ids(MULTI));
  });
});

describe('Ehrlichkeit: weglassen statt 0', () => {
  it('die Wetter-Kachel erscheint nur mit Wetterdaten', () => {
    expect(ids(PRIVAT)).not.toContain('wetter');
    expect(ids(PRIVAT, { weather: { nextHourTempC: 21, why: null } })).toContain('wetter');
    expect(ids(PRIVAT, { weather: { nextHourTempC: null, why: null } })).not.toContain('wetter');
  });

  it('jede Kachel trägt ihr Absprung-Ziel — auf ihre Seite (kein Modal)', () => {
    const w = cockpitWidgets(build(MULTI));
    const target = (id: WidgetId) => w.find((x) => x.id === id)?.target;
    expect(target('erloes')).toEqual({ kind: 'sub', sub: 'erloese' });
    expect(target('handel')).toEqual({ kind: 'sub', sub: 'fahrplan' });
    expect(target('automatik')).toEqual({ kind: 'sub', sub: 'steuerung' });
  });
});

describe('Der Hero', () => {
  it('trägt Autarkie und Eigenverbrauch als Ringe', () => {
    const hero = cockpitHero({ totals: TOTALS, money: money(), range: 'month', now: NOW });
    expect(hero.rings.map((r) => r.id)).toEqual(['autarkie', 'eigenverbrauch']);
    expect(hero.rings[0].valueText).toBe(`82${NBSP}%`);
    expect(hero.rings[0].pct).toBe(82);
  });

  it('lässt einen Ring WEG, wenn der Zeitraum-Wert fehlt (nie 0 %)', () => {
    const hero = cockpitHero({
      totals: { ...TOTALS, autarkiePct: null },
      money: money(),
      range: 'month',
      now: NOW,
    });
    expect(hero.rings.map((r) => r.id)).toEqual(['eigenverbrauch']);
    const none = cockpitHero({ totals: null, money: null, range: 'month', now: NOW });
    expect(none.rings).toEqual([]);
    expect(none.money).toBeNull();
    // V13: statt eines wortlosen Höhensprungs steht dort der Grund.
    expect(none.ringsNote).toContain('Juli');
    expect(hero.ringsNote).toBeNull(); // es GIBT einen Ring
  });

  it('V13: „Gesamt" sagt, wo Autarkie/Eigenverbrauch stattdessen zu finden sind', () => {
    const gesamt = cockpitHero({ totals: null, money: money(), range: 'all', now: NOW });
    expect(gesamt.rings).toEqual([]);
    expect(gesamt.ringsNote).toContain('Monat oder Jahr');
    // nie eine erfundene 0
    expect(gesamt.ringsNote).not.toContain('0 %');
  });

  it('stellt die Steuerungs-Zurechnung als UNTERZEILE, nie als eigenen Summanden', () => {
    const hero = cockpitHero({ totals: TOTALS, money: money(), range: 'month', now: NOW });
    expect(hero.money?.value).toBe(`17,00${NBSP}€`);
    expect(hero.money?.attribution).toContain('durch VoltPilots Steuerung');
    // Die Zurechnung wird NICHT zur Summe addiert.
    expect(hero.money?.value).not.toContain('20');
  });

  it('nennt keine Fahrplan-Zeile ohne Plan', () => {
    expect(cockpitHero({ range: 'month', now: NOW }).planSentence).toBeNull();
  });
});

describe('Die Ring-Kennzahlen folgen dem gewählten Zeitraum (v3.2 M1)', () => {
  it('trägt die Periode im Ring-Etikett wie die Geld-Zeile', () => {
    // Monat: "· Juli" (aktueller Berlin-Monat), Geld ebenso.
    const monat = cockpitHero({ totals: TOTALS, money: money(), range: 'month', now: NOW });
    expect(monat.rings.map((r) => r.label)).toEqual([
      'Autarkie · Juli',
      'Eigenverbrauch · Juli',
    ]);
    expect(monat.money?.label).toBe('Verdient · Juli');

    // Heute: das Tages-Etikett.
    const heute = cockpitHero({ totals: TOTALS, money: money(), range: 'day', now: NOW });
    expect(heute.rings.map((r) => r.label)).toEqual([
      'Autarkie · Heute',
      'Eigenverbrauch · Heute',
    ]);

    // Jahr: die Jahreszahl.
    const jahr = cockpitHero({ totals: TOTALS, money: money(), range: 'year', now: NOW });
    expect(jahr.rings.map((r) => r.label)).toEqual([
      'Autarkie · 2026',
      'Eigenverbrauch · 2026',
    ]);
  });

  it('nennt für einen getippten Vormonat dessen Namen (at)', () => {
    const mai = cockpitHero({
      totals: TOTALS,
      money: money(),
      range: 'month',
      at: new Date('2026-05-01T12:00:00+02:00'),
      now: NOW,
    });
    expect(mai.rings[0].label).toBe('Autarkie · Mai');
    expect(mai.money?.label).toBe('Verdient · Mai');
  });

  it('bildet den Zeitraum-Tab auf den Historie-Bereich ab; „Gesamt" hat keinen', () => {
    expect(historyRangeForCockpit('day')).toBe('day');
    expect(historyRangeForCockpit('month')).toBe('month');
    expect(historyRangeForCockpit('year')).toBe('year');
    // „Gesamt" (all) → kein All-Zeit-Historie-Endpunkt → keine Ringe.
    expect(historyRangeForCockpit('all')).toBeNull();
  });
});
