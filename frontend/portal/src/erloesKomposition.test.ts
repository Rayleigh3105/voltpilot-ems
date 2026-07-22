import { describe, expect, it } from 'vitest';

import type { EarningsSite } from './api';
import {
  DASH,
  ERLOES_HISTORIE,
  STREAM_SOURCES,
  billingPeriodLabel,
  erloesKomposition,
} from './erloesKomposition';
import { NBSP } from './format';
import { activeModes, moneyStreams, type MoneyStream } from './surface';

const NOW = new Date('2026-07-21T10:00:00Z');

function money(over: Partial<EarningsSite> = {}): EarningsSite {
  return {
    id: 's1',
    name: 'Hof Lindenberg',
    plantKind: 'eigenverbrauch',
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
    tarifParamCtKwh: 18,
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
    ...over,
  };
}

/** Ein aktiver Flow OHNE Strategie-Knoten = eine Automation (M0 §1.2). */
function automationFlow() {
  return {
    flowId: 'f1',
    name: 'Wallbox bei PV-Überschuss',
    activeVersion: 1,
    latestLifecycle: 'active',
    latestDocument: {
      schemaVersion: '1.0',
      flowId: 'f1',
      flowVersion: 1,
      siteId: 's1',
      name: 'Wallbox bei PV-Überschuss',
      lifecycle: 'active',
      nodes: [{ id: 'n1', type: 'vp.entity.control', config: {} }],
      edges: [],
      claims: [],
    } as never,
  };
}

/** Die Ströme einer Multi-Modus-Anlage, direkt aus dem M0-Read-Model. */
function multiModusStreams(): MoneyStream[] {
  return moneyStreams(
    activeModes({
      signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
      config: {
        plantKind: 'direktvermarktung',
        tarifArt: 'dynamisch',
        netzladenErlaubt: true,
        leistungspreisEurKw: 120,
      },
      flows: [],
      entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
    }),
  );
}

describe('erloesKomposition — Multi-Modus-Komposition', () => {
  it('rendert je Modus eine Zeile aus den bestehenden Earnings-Feldern', () => {
    const streams = multiModusStreams();
    const view = erloesKomposition({
      streams,
      money: money({
        savedEur: 89,
        arbitrageEur: 12,
        einspeiseErloesEur: 301.46,
        eigenverbrauchsWertEur: 41,
        peakShaving: {
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: 31.4,
          baselinePeakKw: 40.4,
          avoidedKw: 9,
          avoidedEur: 1204,
          history: [],
        },
      }),
      range: 'month',
      at: NOW,
      now: NOW,
    });

    // Kanonische Modus-Reihenfolge aus M0: Peak vor Markt (Eigenverbrauch ist
    // auf einer reinen DV-Anlage nicht aktiv).
    // MIG §5: die DV-Anlage weist ihren ECHTEN Erlös aus, nicht nur das
    // Steuerungs-Delta - das steht als Zurechnung UNTER der Zeile.
    expect(view.rows.map((r) => r.id)).toEqual([
      'lastspitzen',
      'einspeisung',
      'eigenverbrauchswert',
    ]);
    expect(view.rows[0].valueText).toBe(`1.204,00${NBSP}€`);
    expect(view.rows[1].valueText).toBe(`301,46${NBSP}€`);
    expect(view.rows[1].note).toContain(`davon 89,00${NBSP}€ durch VoltPilots Steuerung`);
    expect(view.rows[2].valueText).toBe(`41,00${NBSP}€`);
    expect(view.isEmpty).toBe(false);
  });

  it('skaliert die Balken NUR innerhalb einer Periode', () => {
    const view = erloesKomposition({
      streams: multiModusStreams(),
      money: money({
        savedEur: 89,
        einspeiseErloesEur: 89,
        peakShaving: {
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: null,
          baselinePeakKw: null,
          avoidedKw: 9,
          avoidedEur: 1204,
          history: [],
        },
      }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    // Beide sind in ihrer eigenen Periode die größte Zeile -> je voller Balken.
    // Ein Jahresstand darf einen Monatswert nie optisch erschlagen.
    expect(view.rows.find((r) => r.id === 'lastspitzen')?.barFraction).toBe(1);
    expect(view.rows.find((r) => r.id === 'einspeisung')?.barFraction).toBe(1);
  });

  it('stapelt die vier Modi der Ausprägung "Multi-Modus" (report §3)', () => {
    // Hof Lindenberg: Peak + Markt (Netzladen auf dynamischem Tarif, F4) +
    // Eigenverbrauch + eine Wallbox-Regel -> fünf Ströme, vier Modi.
    const streams = moneyStreams(
      activeModes({
        signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
        config: { tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: 120 },
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
        flows: [automationFlow()],
      }),
    );
    const view = erloesKomposition({
      streams,
      money: money({
        savedEur: 89,
        eigenverbrauchsWertEur: 41,
        einspeiseErloesEur: 12,
        peakShaving: {
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: null,
          baselinePeakKw: null,
          avoidedKw: 9,
          avoidedEur: 1204,
          history: [],
        },
      }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    // Seit MIG §5 nennen Markt- und Eigenverbrauchs-Modus dieselben Ströme;
    // jeder erscheint GENAU EINMAL - sonst wäre derselbe Euro doppelt summiert.
    expect(view.rows.map((r) => r.id)).toEqual([
      'lastspitzen',
      'einspeisung',
      'eigenverbrauchswert',
      'automation',
    ]);
    // Zeitraum-Summe = 12 + 41 (die Automation zählt ehrlich nicht mit),
    // der Jahresstand steht daneben - nie in derselben Zahl.
    const byPeriod = Object.fromEntries(view.totals.map((t) => [t.period, t]));
    expect(byPeriod['range'].eur).toBe(53);
    expect(byPeriod['billing-period'].eur).toBe(1204);
  });

  it('spiegelt die im M0-Manifest deklarierten Quellen (Drift-Wächter)', () => {
    for (const s of multiModusStreams()) {
      expect(STREAM_SOURCES[s.id]).toEqual(s.sources);
    }
  });
});

describe('erloesKomposition — Perioden-Disziplin (die tragende Regel)', () => {
  const withBothPeriods = () =>
    erloesKomposition({
      streams: multiModusStreams(),
      money: money({
        savedEur: 89,
        einspeiseErloesEur: 89,
        peakShaving: {
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: null,
          baselinePeakKw: null,
          avoidedKw: 9,
          avoidedEur: 1204,
          history: [],
        },
      }),
      range: 'month',
      at: NOW,
      now: NOW,
    });

  it('etikettiert jede Zeile mit IHRER Periode', () => {
    const view = withBothPeriods();
    const peak = view.rows.find((r) => r.id === 'lastspitzen')!;
    const erloes = view.rows.find((r) => r.id === 'einspeisung')!;
    expect(peak.period).toBe('billing-period');
    expect(peak.periodLabel).toBe('Abrechnungsjahr 2026');
    expect(erloes.period).toBe('range');
    expect(erloes.periodLabel).toBe('Juli');
    expect(peak.periodLabel).not.toBe(erloes.periodLabel);
  });

  it('summiert NIE quer über Perioden — eine Summe je Periode', () => {
    const view = withBothPeriods();
    expect(view.totals).toHaveLength(2);
    const byPeriod = Object.fromEntries(view.totals.map((t) => [t.period, t]));
    expect(byPeriod['range'].eur).toBe(89);
    expect(byPeriod['billing-period'].eur).toBe(1204);
    // Die verbotene Zahl: 89 + 1204 taucht nirgends auf.
    expect(view.totals.some((t) => t.eur === 1293)).toBe(false);
    expect(byPeriod['billing-period'].label).toBe('Abrechnungsjahr 2026 gesamt');
  });

  it('sagt den Perioden-Mix laut, sobald mehrere Perioden im Stapel stehen', () => {
    const view = withBothPeriods();
    expect(view.periodNote).toContain('Juli');
    expect(view.periodNote).toContain('Abrechnungsjahr 2026');
    expect(view.periodNote).toContain('nicht zu einer Summe');
  });

  it('lässt den Hinweis weg, wenn alle Zeilen dieselbe Periode haben', () => {
    const streams = moneyStreams(
      activeModes({
        signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
        config: {},
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
      }),
    );
    const view = erloesKomposition({
      streams,
      money: money({ eigenverbrauchsWertEur: 41, einspeiseErloesEur: 12 }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    expect(view.rows.map((r) => r.period)).toEqual(['range', 'range']);
    expect(view.periodNote).toBeNull();
    expect(view.totals).toHaveLength(1);
    expect(view.totals[0].eur).toBe(53);
  });

  it('benennt eine monatliche Abrechnungsperiode korrekt', () => {
    expect(
      billingPeriodLabel(
        money({
          peakShaving: {
            leistungspreisEurKw: 9,
            abrechnung: 'monat',
            periodStart: '2026-07-01',
            peakKw: null,
            baselinePeakKw: null,
            avoidedKw: null,
            avoidedEur: null,
            history: [],
          },
        }),
      ),
    ).toBe('Abrechnungsmonat Juli 2026');
    // Ohne PS-4-Block wird kein Zeitraum erfunden.
    expect(billingPeriodLabel(money())).toBe('Abrechnungsperiode');
    expect(billingPeriodLabel(null)).toBe('Abrechnungsperiode');
  });
});

describe('erloesKomposition — ehrliches „—"', () => {
  const automationStreams = () =>
    moneyStreams(
      activeModes({
        signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
        config: {},
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
        flows: [automationFlow()],
      }),
    );

  it('zeigt für Automationen „—" statt einer erfundenen Zahl', () => {
    const view = erloesKomposition({
      streams: automationStreams(),
      money: money({ eigenverbrauchsWertEur: 41, einspeiseErloesEur: 12 }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    const auto = view.rows.find((r) => r.id === 'automation')!;
    expect(auto.state).toBe('unattributed');
    expect(auto.valueText).toBe(DASH);
    expect(auto.eur).toBeNull();
    expect(auto.barFraction).toBe(0);
    expect(view.footnote).not.toBeNull();
  });

  it('zieht eine nicht zugerechnete Zeile nicht in die Summe', () => {
    const view = erloesKomposition({
      streams: automationStreams(),
      money: money({ eigenverbrauchsWertEur: 41, einspeiseErloesEur: 12 }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    const total = view.totals.find((t) => t.period === 'range')!;
    expect(total.eur).toBe(53);
    expect(total.contributingRows).toBe(2);
  });

  it('zeigt „—" auch für einen (noch) nicht berechenbaren Strom', () => {
    const streams = moneyStreams(
      activeModes({
        signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
        config: {},
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
      }),
    );
    // 'ohne'-Tarif: eigenverbrauchsWertEur ist null - niemals ein Euro erfunden.
    const view = erloesKomposition({
      streams,
      money: money({ tarifArt: 'ohne', eigenverbrauchsWertEur: null, einspeiseErloesEur: 12 }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    const ev = view.rows.find((r) => r.id === 'eigenverbrauchswert')!;
    expect(ev.state).toBe('unavailable');
    expect(ev.valueText).toBe(DASH);
    expect(ev.note).toBe('Noch keine Daten.');
    expect(view.totals[0].eur).toBe(12);
  });

  it('behandelt fehlende Earnings-Daten als „—", nicht als 0', () => {
    const view = erloesKomposition({
      streams: multiModusStreams(),
      money: null,
      range: 'month',
      at: NOW,
      now: NOW,
    });
    expect(view.rows.every((r) => r.valueText === DASH)).toBe(true);
    expect(view.totals.every((t) => t.eur === null)).toBe(true);
    expect(view.drillIn).toBeNull();
  });
});

describe('erloesKomposition — Leerfall & Drill-in', () => {
  it('ist leer, wenn kein Geld-Modus aktiv ist ("Neu / leer")', () => {
    const streams = moneyStreams(activeModes({ signals: null, config: null, entities: [] }));
    expect(streams).toEqual([]);
    const view = erloesKomposition({ streams, money: null, range: 'month', at: NOW, now: NOW });
    expect(view.isEmpty).toBe(true);
    expect(view.rows).toEqual([]);
    expect(view.totals).toEqual([]);
    expect(view.periodNote).toBeNull();
    expect(view.footnote).toBeNull();
    expect(view.drillIn).toBeNull();
  });

  it('bietet die ERLÖS-Historie an — sichtbar abgegrenzt vom Telemetrie-Verlauf', () => {
    const view = erloesKomposition({
      streams: multiModusStreams(),
      money: money({ savedEur: 89, einspeiseErloesEur: 301.46 }),
      range: 'month',
      at: NOW,
      now: NOW,
    });
    expect(view.drillIn).toEqual(ERLOES_HISTORIE);
    expect(view.drillIn?.label).toContain('Erlöse');
    expect(view.drillIn?.hint).toContain('Erlös-Historie');
    expect(view.drillIn?.hint).toContain('Telemetrie');
  });

  it('nennt den gewählten Zeitraum in der Überschrift', () => {
    const view = erloesKomposition({
      streams: multiModusStreams(),
      money: money({ savedEur: 1, einspeiseErloesEur: 1 }),
      range: 'day',
      at: NOW,
      now: NOW,
    });
    expect(view.title).toBe('Ertrag · Heute — alle Ströme');
  });
});
