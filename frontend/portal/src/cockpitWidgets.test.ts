import { describe, expect, it } from 'vitest';
import {
  cockpitHero,
  cockpitWidgets,
  fahrplanZeile,
  heroChips,
  historyRangeForCockpit,
  mobileWidgets,
  preisZeile,
  stickyHead,
  type CockpitWidgetsInput,
  type WidgetDef,
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
    // Ohne ein echtes Handelsfenster wäre die Kachel nur die zweite Kopie der
    // `savedEur`-Unterzeile im Hero. Sie entfällt deshalb.
    expect(set).not.toContain('handel');
    expect(
      ids(MULTI, {
        slots: [
          { start: '2026-07-22T19:00:00+02:00', batteryKw: -4, gridKw: -4, pvKw: 0, priceEurMwh: 220 },
        ],
      }),
    ).toContain('handel');
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
    const w = cockpitWidgets(
      build(MULTI, {
        slots: [
          { start: '2026-07-22T19:00:00+02:00', batteryKw: -4, gridKw: -4, pvKw: 0, priceEurMwh: 220 },
        ],
      }),
    );
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

  it('stellt die Speicher-Aussage als UNTERZEILE, nie als eigenen Summanden', () => {
    const hero = cockpitHero({ totals: TOTALS, money: money(), range: 'month', now: NOW });
    expect(hero.money?.value).toBe(`17,00${NBSP}€`);
    // Erlöse-Konzept §3.5: derselbe Wert misst den GANZEN Speicher — „Steuerung"
    // ist erst `savedSteuerungEur`. Ohne Aufteilung steht deshalb nur Zeile 1.
    expect(hero.money?.attribution).toBe(`Speicher + 3,25${NBSP}€`);
    // Die Zurechnung wird NICHT zur Summe addiert.
    expect(hero.money?.value).not.toContain('20');
  });

  it('nennt die Aufteilung, sobald der Server sie liefert (Erlöse-Konzept §3.6)', () => {
    const hero = cockpitHero({
      totals: TOTALS,
      money: money({ savedSpeicherEur: 2.15, savedSteuerungEur: 1.1 }),
      range: 'month',
      now: NOW,
    });
    expect(hero.money?.attribution).toBe(
      `Speicher + 3,25${NBSP}€ · davon Steuerung + 1,10${NBSP}€`,
    );
    // Der volle Wortlaut hängt als Tooltip daran — nie zwei Formulierungen.
    expect(hero.money?.attributionTitel).toContain('stur arbeitenden Speicher');
  });

  it('zeigt am laufenden Tag den negativen Geldfluss als Zwischenstand plus geplanten Bestand', () => {
    const hero = cockpitHero({
      totals: TOTALS,
      money: money({
        savedEur: -2.84,
        range: 'day',
        to: '2026-07-23T00:00:00+02:00',
        speicherDeltaKwh: 44.2,
        speicherWertCtKwh: 18.9,
        speicherWertEur: 8.3538,
        speicherWertBasis: 'plan',
      }),
      range: 'day',
      now: NOW,
    });
    expect(hero.money?.attribution).toBe(`Zwischenstand Speicher − 2,84${NBSP}€`);
    expect(hero.money?.attributionInterim).toBe(true);
    expect(hero.money?.bestand?.text).toContain('Speicherenergie seit Tagesbeginn gespeichert');
    expect(hero.money?.bestand?.badge).toBe('Kein Abzug');
    // Der geplante Bestand bleibt daneben und verändert die gemessene Summe nie.
    expect(hero.money?.value).toBe(`17,00${NBSP}€`);
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

/**
 * Mobil-Umbau Stufe 2 — die Telefon-Fassung (abgenommenes Konzept
 * `data/vp-mobile-views-x1`, Sektion „Cockpit"; Captain-Go 09.08.2026).
 *
 * Der gemessene Befund war Wiederholung, nicht Layout: dieselbe Geld-Aussage
 * stand am Telefon VIERMAL auf 550 px. Diese Regeln beenden das — und dürfen
 * dabei nie eine Aussage verlieren, die sonst nirgends steht.
 */
describe('Mobil-Umbau Stufe 2 · die Telefon-Fassung des Cockpits', () => {
  const w = (id: WidgetId): WidgetDef => ({
    id,
    label: id,
    value: '1',
    sub: null,
    accent: 'money',
    lead: false,
    target: { sub: 'messwerte' } as WidgetDef['target'],
  });

  describe('mobileWidgets', () => {
    it('entfernt die zwei Geld-Kacheln — ihre Zahl steht in der Geld-Karte', () => {
      const out = mobileWidgets([w('erloes'), w('handel')], { hasRings: false });
      expect(out).toEqual([]);
    });

    it('entfernt die Wetter-Kachel — ihr Satz reist in der Fahrplan-Zeile', () => {
      expect(mobileWidgets([w('wetter')], { hasRings: false })).toEqual([]);
    });

    it('behält die Modus-Kacheln: sie tragen ihre EIGENE Aussage', () => {
      const out = mobileWidgets([w('lastspitze'), w('automatik')], { hasRings: true });
      expect(out.map((x) => x.id)).toEqual(['lastspitze', 'automatik']);
    });

    it('entfernt die Eigenverbrauchs-Kachel nur, wenn die Ringe wirklich dastehen', () => {
      // Mit Ringen ist „Autarkie heute" die zweite Kopie des Ring-Chips …
      expect(mobileWidgets([w('eigenverbrauch')], { hasRings: true })).toEqual([]);
      // … ohne Ringe (z. B. „Gesamt") ist die Kachel der EINZIGE Träger.
      expect(mobileWidgets([w('eigenverbrauch')], { hasRings: false }).map((x) => x.id)).toEqual([
        'eigenverbrauch',
      ]);
    });

    it('erfindet nie eine Kachel und lässt die Reihenfolge unangetastet', () => {
      const out = mobileWidgets([w('lastspitze'), w('erloes'), w('automatik')], {
        hasRings: false,
      });
      expect(out.map((x) => x.id)).toEqual(['lastspitze', 'automatik']);
    });
  });

  describe('heroChips', () => {
    it('macht aus den Ringen Chips und behält die Periode im title', () => {
      const view = cockpitHero({ totals: TOTALS, money: money(), range: 'day', now: NOW });
      const chips = heroChips(view.rings);
      expect(chips.map((c) => c.text)).toEqual([`Autarkie 82${NBSP}%`, `Eigenverbrauch 64${NBSP}%`]);
      // Die Periode geht nicht verloren - sie steht im title (und im Etikett
      // der Geld-Zeile derselben Karte).
      expect(chips[0].title).toBe(`Autarkie · Heute: 82${NBSP}%`);
    });

    it('ohne Ringe gibt es keine Chips (nie eine erfundene 0)', () => {
      expect(heroChips([])).toEqual([]);
    });
  });

  describe('fahrplanZeile', () => {
    const eur = (v: number) => `${v.toFixed(2).replace('.', ',')} €`;

    it('ohne Satz gibt es keine Zeile', () => {
      expect(fahrplanZeile({ sentence: null, savedEur: 5, eur })).toBeNull();
    });

    it('führt mit der schon abgeleiteten Erzählzeile und ergänzt den Vorteil', () => {
      const row = fahrplanZeile({ sentence: 'Jetzt Sonne speichern.', savedEur: 5.01, eur });
      expect(row).toEqual({ head: 'Jetzt Sonne speichern.', sub: 'Heute geplant: +5,01 €' });
    });

    it('nimmt den Wetter-Satz auf — aber nur, wenn er etwas erklärt', () => {
      const mit = fahrplanZeile({
        sentence: 'Jetzt Sonne speichern.',
        savedEur: 5.01,
        weatherWhy: 'Ab 16 Uhr sonniger.',
        eur,
      });
      expect(mit?.sub).toBe('Heute geplant: +5,01 € · Ab 16 Uhr sonniger.');
      const ohne = fahrplanZeile({ sentence: 'Jetzt Sonne speichern.', weatherWhy: null, eur });
      expect(ohne?.sub).toBeNull();
    });

    it('behauptet keinen Vorteil unterhalb der Anzeige-Schwelle', () => {
      const row = fahrplanZeile({ sentence: 'Ruhe.', savedEur: 0.004, eur });
      expect(row?.sub).toBeNull();
      const nan = fahrplanZeile({ sentence: 'Ruhe.', savedEur: Number.NaN, eur });
      expect(nan?.sub).toBeNull();
    });
  });

  describe('preisZeile', () => {
    it('ohne Preis gibt es keine Zeile', () => {
      expect(preisZeile({ jetztWert: null, urteilLabel: 'günstig' })).toBeNull();
    });

    it('nennt Preis + Urteil oben, Bezugspreis + Tageshoch darunter', () => {
      const row = preisZeile({
        jetztWert: '−2,0 ct/kWh',
        urteilLabel: 'Negativpreis',
        bezug: '18,4 ct/kWh',
        bezugDetail: '(Börsenpreis −2,0 + Netzentgelte/Abgaben 20,4)',
        hoch: 'Tageshoch 15,0 ct (19:15)',
      });
      expect(row).toEqual({
        head: 'Börsenpreis −2,0 ct/kWh · Negativpreis',
        sub: 'Ihr Bezugspreis jetzt 18,4 ct/kWh (Börsenpreis −2,0 + Netzentgelte/Abgaben 20,4). Tageshoch 15,0 ct (19:15).',
      });
    });

    it('lässt weg, was der Server nicht liefert — statt es zu erfinden', () => {
      expect(preisZeile({ jetztWert: '11,9 ct/kWh', urteilLabel: null })).toEqual({
        head: 'Börsenpreis 11,9 ct/kWh',
        sub: null,
      });
    });
  });

  describe('stickyHead', () => {
    it('trägt die zwei Anker: Geld und Zustand', () => {
      const head = stickyHead({
        money: { label: 'Verdient · Heute', value: '10,60 €', attribution: null },
        status: { text: 'Alles läuft.', tone: 'ok' },
      });
      expect(head).toEqual({
        value: '10,60 €',
        label: 'Verdient · Heute',
        status: 'Alles läuft.',
        tone: 'ok',
      });
    });

    it('ohne beide Anker gibt es keinen Kopf', () => {
      expect(stickyHead({ money: null, status: null })).toBeNull();
    });

    it('behauptet ohne Geld keine Zahl — und ohne Zustand keinen Satz', () => {
      expect(stickyHead({ money: null, status: { text: 'Gerät meldet sich nicht.', tone: 'warn' } }))
        .toEqual({ value: null, label: null, status: 'Gerät meldet sich nicht.', tone: 'warn' });
      const nurGeld = stickyHead({
        money: { label: 'Verdient · Juli', value: '1,00 €', attribution: null },
        status: null,
      });
      expect(nurGeld?.status).toBeNull();
      expect(nurGeld?.tone).toBe('off');
    });
  });
});
