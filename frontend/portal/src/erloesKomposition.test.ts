import { describe, expect, it } from 'vitest';

import type { EarningsSite, SiteEarnings } from './api';
import {
  DASH,
  ERLOES_HISTORIE,
  STREAM_SOURCES,
  billingPeriodLabel,
  erloesAufklapper,
  erloesErgebnis,
  geplanteErsparnisNotiz,
  erloesKomposition,
  geldVerlauf,
  preisTreiber,
  verlaufSchritt,
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
        config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
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

  it('V4: „Gesamt" nennt den abgedeckten Zeitraum statt „Gesamt gesamt"', () => {
    const streams = moneyStreams(
      activeModes({
        signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
        config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
      }),
    );
    const view = erloesKomposition({
      streams,
      money: money({
        eigenverbrauchsWertEur: 41,
        einspeiseErloesEur: 12,
        firstCoveredDate: '2026-07-03',
      }),
      range: 'all',
      at: NOW,
      now: NOW,
    });
    expect(view.totals[0].label).toBe('seit 3. Juli 2026');
    expect(view.totals[0].label).not.toContain('Gesamt gesamt');
  });

  it('V4: ohne bekanntes Startdatum bleibt es beim schlichten „Gesamt gesamt"', () => {
    // Nie ein erfundenes Datum - lieber die alte, ehrliche Formulierung.
    const streams = moneyStreams(
      activeModes({
        signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
        config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
      }),
    );
    const view = erloesKomposition({
      streams,
      money: money({ eigenverbrauchsWertEur: 41, firstCoveredDate: null }),
      range: 'all',
      at: NOW,
      now: NOW,
    });
    expect(view.totals[0].label).toBe('Gesamt gesamt');
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
        config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
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
        config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
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

// ===========================================================================
// Welt B · die Erlöse-HISTORIE einer Anlage (F1)
// ===========================================================================

/** Die Antwort des anlagen-scharfen Endpunkts, mit gutmütigen Vorgaben. */
function siteMoney(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return {
    siteId: 's1',
    name: 'Solarpark Dachau',
    range: 'month',
    from: '2026-07-01T00:00:00Z',
    to: '2026-08-01T00:00:00Z',
    plantKind: 'direktvermarktung',
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    tarifPriced: false,
    anzulegenderWertCtKwh: null,
    coveredSlots: 2400,
    firstCoveredDate: '2026-07-01',
    reason: null,
    einspeiseErloesEur: 1059.4,
    eigenverbrauchsWertEur: null,
    stromkostenEur: 60.14,
    nettoErgebnisEur: 999.26,
    savedEur: 161.44,
    arbitrageEur: null,
    pvShiftEur: null,
    baselineEur: 100,
    actualEur: -999.26,
    marktpraemieEur: null,
    bezugspreisCtKwh: 4.9,
    realizedExportCtKwh: 8.88,
    marketValueSolarCtKwh: 5.92,
    marketValueProvisional: true,
    bezogenKwh: 1227.3,
    eingespeistKwh: 9573.8,
    selbstverbrauchKwh: 97.3,
    batterieBewegtKwh: 4147.2,
    gesamtertragEur: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [],
    peakShaving: null,
    ...over,
  };
}

describe('erloesErgebnis · Karte 1 der Erlöse-Welt', () => {
  it('führt mit dem Netto-Ergebnis und macht seine Herkunft nachrechenbar', () => {
    const view = erloesErgebnis({ money: siteMoney(), periodLabel: 'Juli 2026' });

    expect(view.titel).toBe('Ergebnis · Juli 2026');
    expect(view.nettoEur).toBe(999.26);
    // Das Vorzeichen ist ein eigenes Zeichen, der Betrag steht ohne Minus.
    expect(view.nettoText).toBe(`+ 999,26${NBSP}€`);
    expect(view.richtung).toBe('ertrag');

    const ids = view.rows.map((r) => r.id);
    expect(ids).toEqual(['einspeisung', 'eigenverbrauchswert', 'stromkosten']);
    // Die gezeigten Zeilen ERGEBEN die große Zahl (+ 1.059,40 − 60,14).
    const rechnung = view.rows
      .filter((r) => r.period === 'range' && r.eur != null)
      .reduce((acc, r) => acc + (r.vorzeichen === 'minus' ? -(r.eur as number) : (r.eur as number)), 0);
    expect(rechnung).toBeCloseTo(view.nettoEur as number, 6);
  });

  it('zeigt die Zurechnung der Steuerung als UNTERZEILE, nie als weiteren Summanden', () => {
    const view = erloesErgebnis({ money: siteMoney(), periodLabel: 'Juli 2026' });
    expect(view.steering).toContain('161,44');
    expect(view.steering).toContain('durch VoltPilots Steuerung');
    expect(view.steeringTitel).toContain('ohne Speicher');
    // savedEur darf in keiner Komposition-Zeile auftauchen.
    expect(view.rows.some((r) => r.eur === 161.44)).toBe(false);
  });

  it('schreibt „—" statt einer erfundenen Null und nennt den Grund', () => {
    const view = erloesErgebnis({
      money: siteMoney({ eigenverbrauchsWertEur: null, tarifArt: 'ohne', tarifPriced: false }),
      periodLabel: 'Juli 2026',
    });
    const zeile = view.rows.find((r) => r.id === 'eigenverbrauchswert');
    expect(zeile?.valueText).toBe(DASH);
    expect(zeile?.eur).toBeNull();
    expect(zeile?.note).toContain('Ohne hinterlegten Stromtarif');
    expect(zeile?.note).toContain('97,3');
    expect(view.footnote).not.toBeNull();
  });

  it('führt die vermiedenen Leistungskosten mit EIGENER Periode und addiert sie nie mit', () => {
    const view = erloesErgebnis({
      money: siteMoney({
        peakShaving: {
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: 80,
          baselinePeakKw: 95,
          avoidedKw: 15,
          avoidedEur: 1800,
          history: [],
        },
      }),
      periodLabel: 'Juli 2026',
    });
    const peak = view.rows.find((r) => r.id === 'lastspitzen');
    expect(peak?.period).toBe('billing-period');
    expect(peak?.periodLabel).toBe('Abrechnungsjahr 2026');
    // Die große Zahl bleibt das Zeitraum-Ergebnis - 1.800 € sind NICHT drin.
    expect(view.nettoEur).toBe(999.26);
    expect(view.periodNote).toContain('nicht zu einer Summe addiert');
    // Und erst JETZT trägt jede Zeile ihr Perioden-Etikett sichtbar.
    expect(view.mehrerePerioden).toBe(true);
  });

  it('wiederholt den Zeitraum nicht an jeder Zeile, wenn es nur einen gibt', () => {
    const view = erloesErgebnis({ money: siteMoney(), periodLabel: 'Juli 2026' });
    expect(view.mehrerePerioden).toBe(false);
    expect(view.periodNote).toBeNull();
    // Das Etikett bleibt als DATUM da - nur die Oberfläche zeigt es dann nicht.
    expect(view.rows[0].periodLabel).toBe('Juli 2026');
  });

  it('nennt bei einem leeren Zeitraum den Grund, statt eine Null zu zeigen', () => {
    const view = erloesErgebnis({
      money: siteMoney({
        coveredSlots: 0,
        reason: 'no_prices',
        einspeiseErloesEur: null,
        eigenverbrauchsWertEur: null,
        stromkostenEur: null,
        nettoErgebnisEur: null,
        savedEur: null,
      }),
      periodLabel: 'Juli 2026',
    });
    expect(view.nettoEur).toBeNull();
    expect(view.nettoText).toBe(DASH);
    expect(view.leerText).toContain('Börsenpreise');
    expect(view.steering).toBeNull();
  });

  it('bleibt bei einem Verlust vorzeichen-ehrlich', () => {
    const view = erloesErgebnis({
      money: siteMoney({ einspeiseErloesEur: 10, stromkostenEur: 22.4, nettoErgebnisEur: -12.4 }),
      periodLabel: 'Januar 2026',
    });
    expect(view.nettoText).toBe(`− 12,40${NBSP}€`);
    expect(view.richtung).toBe('kosten');
    expect(view.nettoSatz).toContain('mehr gekostet');
  });
});

describe('preisTreiber · Karte 3 „Was den Preis gemacht hat"', () => {
  it('stellt den erzielten Marktwert dem Monatsdurchschnitt gegenüber', () => {
    const zeilen = preisTreiber({ money: siteMoney() });
    const erzielt = zeilen.find((z) => z.id === 'marktwert');
    expect(erzielt?.wert).toBe('8,9 ct/kWh');
    expect(erzielt?.note).toBe('3,0 ct über dem Monatsdurchschnitt');
    const markt = zeilen.find((z) => z.id === 'monatsmarktwert');
    expect(markt?.wert).toBe('5,9 ct/kWh');
    expect(markt?.note).toContain('vorläufig');
  });

  it('benennt den Ø Bezugspreis samt seiner Bewertungsgrundlage', () => {
    const spot = preisTreiber({ money: siteMoney() }).find((z) => z.id === 'bezugspreis');
    expect(spot?.wert).toBe('4,9 ct/kWh');
    expect(spot?.note).toContain('Börsenpreis');

    const tarif = preisTreiber({ money: siteMoney({ tarifPriced: true, tarifArt: 'dynamisch' }) })
      .find((z) => z.id === 'bezugspreis');
    expect(tarif?.note).toContain('Stromtarif');
  });

  it('sagt bei fehlender Zurechnung „—" MIT Grund - nie eine erfundene Null', () => {
    const zeilen = preisTreiber({ money: siteMoney(), netzladenErlaubt: false });
    const praemie = zeilen.find((z) => z.id === 'marktpraemie');
    expect(praemie?.wert).toBe(DASH);
    expect(praemie?.vorhanden).toBe(false);
    expect(praemie?.note).toContain('anzulegender Wert');

    const arbitrage = zeilen.find((z) => z.id === 'arbitrage');
    expect(arbitrage?.wert).toBe(DASH);
    expect(arbitrage?.note).toContain('Sonnenstrom');

    const erlaubt = preisTreiber({ money: siteMoney(), netzladenErlaubt: true })
      .find((z) => z.id === 'arbitrage');
    expect(erlaubt?.note).toContain('nicht aus dem Netz geladen');
  });

  it('weist eine vorhandene Marktprämie mit ihrer Rechnung aus - und als BEREITS ENTHALTEN', () => {
    const praemie = preisTreiber({
      money: siteMoney({ marktpraemieEur: 212.4, anzulegenderWertCtKwh: 8.11 }),
    }).find((z) => z.id === 'marktpraemie');
    expect(praemie?.wert).toBe(`+ 212,40${NBSP}€`);
    expect(praemie?.note).toContain('8,11 − 5,92 = 2,19');
    expect(praemie?.hinweise.join(' ')).toContain('bereits im Einspeise-Erlös');
  });

  // Der reale Kundenfall vom 05.08.2026 - die Null war richtig und sah aus wie
  // ein Defekt. Details/Zustände: `marktpraemie.test.ts`.
  it('erklärt eine berechnete Null, statt sie nackt stehen zu lassen', () => {
    const praemie = preisTreiber({
      money: siteMoney({
        marktpraemieEur: 0,
        anzulegenderWertCtKwh: 6.9,
        marketValueSolarCtKwh: 7.0,
        marketValueProvisional: true,
      }),
      siteId: 's1',
    }).find((z) => z.id === 'marktpraemie');

    expect(praemie?.wert).toBe(`0,00${NBSP}€`);
    expect(praemie?.vorhanden).toBe(true);
    expect(praemie?.note).toContain('voll aus dem Markt');
    expect(praemie?.hinweise.join(' ')).toContain('kann sich noch ändern');
  });

  it('bietet den Weg zum fehlenden anzulegenden Wert an - aber nur mit bekannter Anlage', () => {
    const mit = preisTreiber({ money: siteMoney(), siteId: 's1' }).find(
      (z) => z.id === 'marktpraemie',
    );
    expect(mit?.href).toBe('#/anlage/s1/technik?abschnitt=geld');

    const ohne = preisTreiber({ money: siteMoney() }).find((z) => z.id === 'marktpraemie');
    expect(ohne?.href).toBeNull();
  });
});

describe('geldVerlauf · Karte 2 „Geld im Verlauf"', () => {
  const buckets = [
    {
      start: '2026-07-01T00:00:00Z',
      einspeiseErloesEur: 30,
      eigenverbrauchsWertEur: 5,
      stromkostenEur: 10,
      nettoEur: 25,
    },
    {
      start: '2026-07-02T00:00:00Z',
      einspeiseErloesEur: 20,
      eigenverbrauchsWertEur: null,
      stromkostenEur: 4,
      nettoEur: 16,
    },
  ];

  it('stapelt Erlöse nach oben, Kosten nach unten - und summiert die Linie auf', () => {
    const view = geldVerlauf(buckets, 'month');
    expect(view.leer).toBe(false);
    expect(view.reihen.map((r) => r.id)).toEqual([
      'einspeisung',
      'eigenverbrauchswert',
      'stromkosten',
    ]);
    expect(view.reihen[0].data).toEqual([30, 20]);
    // Ein fehlender Teil trägt 0 zum STAPEL bei (der Balken existiert), er wird
    // nie erfunden - die Zeile in Karte 1 sagt „—".
    expect(view.reihen[1].data).toEqual([5, 0]);
    // Kosten zeigen nach unten.
    expect(view.reihen[2].data).toEqual([-10, -4]);
    expect(view.kumuliert).toEqual([25, 41]);
    expect(view.kumuliertText).toBe(`kumuliert + 41,00${NBSP}€`);
  });

  it('bindet den Maßstab an den Zeitraum (P6) - das Jahr zeigt Monate', () => {
    expect(verlaufSchritt('day')).toBe('Stunde');
    expect(verlaufSchritt('week')).toBe('Tag');
    expect(verlaufSchritt('month')).toBe('Tag');
    expect(verlaufSchritt('year')).toBe('Monat');
    expect(verlaufSchritt('all')).toBe('Monat');
    expect(geldVerlauf(buckets, 'year').untertitel).toContain('Je Monat');
  });

  it('bleibt bei einem leeren Zeitraum ehrlich leer', () => {
    const view = geldVerlauf([], 'month');
    expect(view.leer).toBe(true);
    expect(view.kumuliert).toEqual([]);
    expect(view.kumuliertText).toBeNull();
  });
});

/**
 * **Die Mobil-Fassung der Geld-Welt** (Konzept `data/vp-mobile-views-x1` §6):
 * acht gleichrangige Karten über 7,3 Bildschirme werden ein Ergebnis-Falz plus
 * benannte Aufklapper. Umgeordnet, nicht gekürzt.
 */
describe('erloesAufklapper', () => {
  const voll = {
    hatSoVerdient: true,
    hatPreisTreiber: true,
    istTag: true,
    hatTagesdaten: true,
  };

  it('nennt am Tag alle vier - in der Reihenfolge des Konzepts', () => {
    expect(erloesAufklapper(voll).map((a) => a.id)).toEqual([
      'so-verdient',
      'preis-treiber',
      'speicher-preis',
      'tagesprotokoll',
    ]);
    expect(erloesAufklapper(voll)[0].titel).toBe('So verdient Ihre Anlage · der Markt-Vergleich');
  });

  it('lässt weg, was es auf dieser Anlage gar nicht gibt', () => {
    // Keine Direktvermarktung: kein Markt-Vergleich (S9).
    expect(erloesAufklapper({ ...voll, hatSoVerdient: false }).map((a) => a.id)).not.toContain(
      'so-verdient',
    );
    // Woche/Monat/Jahr: der Tagesnachweis und das Protokoll existieren nicht.
    expect(erloesAufklapper({ ...voll, istTag: false }).map((a) => a.id)).toEqual([
      'so-verdient',
      'preis-treiber',
    ]);
  });

  it('verspricht nichts, wofür die Antwort fehlt', () => {
    // Ein Tag OHNE Historie-Antwort: die zwei Tages-Aufklapper wären leer.
    expect(erloesAufklapper({ ...voll, hatTagesdaten: false }).map((a) => a.id)).toEqual([
      'so-verdient',
      'preis-treiber',
    ]);
    expect(
      erloesAufklapper({
        hatSoVerdient: false,
        hatPreisTreiber: false,
        istTag: false,
        hatTagesdaten: false,
      }),
    ).toEqual([]);
  });
});

describe('geplanteErsparnisNotiz', () => {
  it('behält das Abzeichen „Geplant" und sagt, dass sie NICHT gemessen ist', () => {
    const n = geplanteErsparnisNotiz(4.12, 'Fr., 24.07.2026');
    expect(n.badge).toBe('Geplant');
    expect(n.vorhanden).toBe(true);
    expect(n.wertText).toBe(`+ 4,12${NBSP}€`);
    expect(n.satz).toContain('nicht gemessen');
    // Sie verweist auf die gemessene Zahl, statt sich mit ihr zu vermischen.
    expect(n.satz).toContain('Ergebnis');
  });

  it('sagt ohne Fahrplan „—" MIT Grund - nie eine erfundene Null', () => {
    const n = geplanteErsparnisNotiz(null, 'Juli 2026');
    expect(n.wertText).toBe(DASH);
    expect(n.vorhanden).toBe(false);
    expect(n.satz).toContain('Juli 2026');
    expect(n.satz).toContain('kein Batterie-Fahrplan');
    // Auch die leere Notiz bleibt beschriftet.
    expect(n.badge).toBe('Geplant');
  });

  it('bleibt beim Vorzeichen als eigenem Zeichen, auch wenn geplant verloren wird', () => {
    expect(geplanteErsparnisNotiz(-1.5, 'Juli 2026').wertText).toBe(`− 1,50${NBSP}€`);
  });
});
