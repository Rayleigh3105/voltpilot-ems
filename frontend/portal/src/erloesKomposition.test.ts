import { describe, expect, it } from 'vitest';

import type { EarningsSite, SiteEarnings } from './api';
import {
  DASH,
  ERLOES_HISTORIE,
  STREAM_SOURCES,
  BESTAND_BADGE,
  bestandZeile,
  billingPeriodLabel,
  erloesAufklapper,
  erloesErgebnis,
  geplanteErsparnisNotiz,
  steeringChip,
  erloesKomposition,
  geldVerlauf,
  verlaufKern,
  verlaufSchritt,
} from './erloesKomposition';
import { NBSP } from './format';
import { ebene2 } from './erloesEbenen';
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
      // Gerechnet wird mit dem GEZEIGTEN Zeichen und dem GEZEIGTEN Betrag —
      // seit B1 sind das zwei getrennte Dinge.
      .reduce(
        (acc, r) => acc + (r.vorzeichen === 'minus' ? -1 : 1) * Math.abs(r.eur as number),
        0,
      );
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

  it('schreibt „—“ statt einer erfundenen Null - und nennt seit E7 nur noch fehlende Daten', () => {
    // Seit dem Captain-Entscheid E7 (02.09.2026) bewertet der Server den
    // Eigenverbrauch IMMER mit dem Bezugspreis der Karte. Ein fehlender Wert
    // heißt damit fehlende Daten - „ohne hinterlegten Stromtarif" wäre seither
    // eine Falschaussage über eine Anlage, die sehr wohl bewertet würde.
    const view = erloesErgebnis({
      money: siteMoney({ eigenverbrauchsWertEur: null, tarifArt: 'ohne', tarifPriced: false }),
      periodLabel: 'Juli 2026',
    });
    const zeile = view.rows.find((r) => r.id === 'eigenverbrauchswert');
    expect(zeile?.valueText).toBe(DASH);
    expect(zeile?.eur).toBeNull();
    expect(zeile?.note).toBe('Noch keine Daten.');
    expect(zeile?.note).not.toContain('Stromtarif');
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

/**
 * **P6 · die Karte „Was den Preis gemacht hat" ist ENTFALLEN** (Konzept
 * `vp-erloese-seite-konzept-e2` §3.1, E5): dieselbe Preiswahrheit stand zweimal
 * auf der Seite. Ihre Zeilen wohnen jetzt in Ebene 2 der Ergebnis-Karte.
 *
 * Diese Tests ersetzen die früheren `preisTreiber`-Tests: sie prüfen, dass der
 * INHALT den Umzug überlebt hat — die Ableitung selbst nagelt
 * `erloesEbenen.test.ts` fest.
 */
describe('E5 · die Preise sind in Ebene 2 umgezogen', () => {
  const zeile = (money: SiteEarnings, label: string, netzladen: boolean | null = null) =>
    ebene2({ money, netzladenErlaubt: netzladen }).zeilen.find((z) => z.label === label);

  it('trägt Bezugspreis, Monatsmarktwert und anzulegenden Wert', () => {
    const money = siteMoney({ anzulegenderWertCtKwh: 8.11 });
    expect(zeile(money, 'Bezugspreis')?.wert).toContain(`4,9${NBSP}ct`);
    expect(zeile(money, 'Monatsmarktwert Solar')?.wert).toContain(`5,92${NBSP}ct`);
    expect(zeile(money, 'Monatsmarktwert Solar')?.wert).toContain('vorläufig');
    expect(zeile(money, 'Anzulegender Wert')?.wert).toContain(`8,11${NBSP}ct`);
  });

  it('trägt die Netzladen-Aussage — samt ihrer Zahl, wo es eine gibt', () => {
    // Nur Sonnenstrom: der Hinweis steht, eine Handels-Zahl gibt es nicht.
    expect(zeile(siteMoney(), 'Speicher', false)?.wert).toBe('lädt nur Sonnenstrom');
    // Darf netzladen UND hat gehandelt: die Zahl der früheren Preis-Zeile
    // „davon durch Netzladen" reist mit, statt verloren zu gehen.
    expect(zeile(siteMoney({ arbitrageEur: 12.4 }), 'Speicher', true)?.wert).toBe(
      `darf aus dem Netz laden · davon durch Netzladen + 12,40${NBSP}€`,
    );
    // Darf netzladen, aber der Endpunkt rechnet nichts zu: kein „+ 0,00 €",
    // das einen Handel behauptet, den es nicht gab.
    expect(zeile(siteMoney(), 'Speicher', true)?.wert).toBe('darf aus dem Netz laden');
  });

  it('nennt die Marktwert-Größen NUR bei Direktvermarktung (E11 / Befund B9)', () => {
    const eeg = siteMoney({
      plantKind: 'eigenverbrauch',
      exportVerguetungPriced: true,
      anzulegenderWertCtKwh: 8.11,
    });
    const labels = ebene2({ money: eeg, netzladenErlaubt: null }).zeilen.map((z) => z.label);
    expect(labels).not.toContain('Monatsmarktwert Solar');
    expect(labels).not.toContain('Anzulegender Wert');
    expect(labels).not.toContain('Marktprämie');
    // Stattdessen steht dort, was die Anlage WIRKLICH bekommt.
    expect(zeile(eeg, 'Einspeisepreis')?.wert).toContain('feste Vergütung (EEG)');
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

  // --- B8 · die Legende bewirbt nur, was gezeichnet wird ------------------
  it('lässt eine durchgehend leere Reihe WEG (Befund B8)', () => {
    // Eine Anlage ohne hinterlegten Tarif: der Wert des Eigenverbrauchs ist in
    // JEDEM Eimer null — er zeichnet keinen Balken und stand trotzdem in der
    // Legende.
    const ohneTarif = buckets.map((b) => ({ ...b, eigenverbrauchsWertEur: null }));
    expect(geldVerlauf(ohneTarif, 'month').reihen.map((r) => r.id)).toEqual([
      'einspeisung',
      'stromkosten',
    ]);
    // Eine Reihe, die auch nur EINMAL etwas trägt, bleibt.
    expect(geldVerlauf(buckets, 'month').reihen.map((r) => r.id)).toContain(
      'eigenverbrauchswert',
    );
  });

  it('behält bei einem durchgehend leeren Stapel alle drei Reihen', () => {
    // Sonst stünde ein Diagramm ganz ohne Legende da — die schlechtere Auskunft.
    const leer = buckets.map((b) => ({
      ...b,
      einspeiseErloesEur: 0,
      eigenverbrauchsWertEur: 0,
      stromkostenEur: 0,
    }));
    expect(geldVerlauf(leer, 'month').reihen).toHaveLength(3);
  });

  // --- K1 · die Kernaussage des Verlaufs ---------------------------------
  it('nennt den stärksten Eimer und seinen Träger — nicht die Summe (K1)', () => {
    const k = verlaufKern(geldVerlauf(buckets, 'month'), 'month')!;
    // Der 1. Juli trägt netto 25 € (30 + 5 − 10), der 2. nur 16 €.
    expect(k.wert).toBe(`25,00${NBSP}€`);
    expect(k.satz).toContain('am 1. Juli');
    expect(k.satz).toContain('der Einspeisung');
    // Die SUMME des Zeitraums steht eine Karte höher — nie hier.
    expect(k.satz).not.toContain('41,00');
  });

  it('sagt den GRUND statt einen Spitzen-Eimer zu erfinden', () => {
    const leer = buckets.map((b) => ({
      ...b,
      einspeiseErloesEur: 0,
      eigenverbrauchsWertEur: 0,
      stromkostenEur: 0,
    }));
    const k = verlaufKern(geldVerlauf(leer, 'month'), 'month')!;
    expect(k.wert).toBeNull();
    expect(k.satz).toBeNull();
    expect(k.grund).toContain('noch nichts zusammengekommen');
  });

  it('rendert ohne Eimer GAR NICHTS — die Karte hat ihren eigenen Leer-Satz', () => {
    expect(verlaufKern(geldVerlauf([], 'month'), 'month')).toBeNull();
  });

  it('nennt Stunden am Tag und Monate im Jahr', () => {
    const tag = [
      { start: '2026-07-01T09:00:00Z', einspeiseErloesEur: 1, eigenverbrauchsWertEur: 0, stromkostenEur: 0, nettoEur: 1 },
      { start: '2026-07-01T10:00:00Z', einspeiseErloesEur: 8, eigenverbrauchsWertEur: 0, stromkostenEur: 0, nettoEur: 8 },
    ];
    // 10:00 UTC = 12 Uhr Berlin. Das Wort „Uhr" kommt aus dem Gebietsschema —
    // ein eigenes Suffix ergäbe „12 Uhr Uhr" (Browser-Befund).
    const satz = verlaufKern(geldVerlauf(tag, 'day'), 'day')!.satz!;
    expect(satz).toContain('um 12 Uhr');
    expect(satz).not.toContain('Uhr Uhr');
    expect(verlaufKern(geldVerlauf(tag, 'year'), 'year')!.satz).toContain('im Juli 2026');
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
    istTag: true,
    hatTagesdaten: true,
  };

  // P6/E5: „preis-treiber" ist ENTFALLEN — die Preise wohnen in Ebene 2 der
  // Ergebnis-Karte, also auch am Telefon (ein Aufklapper im Aufklapper wäre
  // dieselbe Wahrheit zweimal).
  it('nennt am Tag alle drei - in der Reihenfolge des Konzepts', () => {
    expect(erloesAufklapper(voll).map((a) => a.id)).toEqual([
      'so-verdient',
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
    ]);
  });

  it('verspricht nichts, wofür die Antwort fehlt', () => {
    // Ein Tag OHNE Historie-Antwort: die zwei Tages-Aufklapper wären leer.
    expect(erloesAufklapper({ ...voll, hatTagesdaten: false }).map((a) => a.id)).toEqual([
      'so-verdient',
    ]);
    expect(
      erloesAufklapper({ hatSoVerdient: false, istTag: false, hatTagesdaten: false }),
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

// ===========================================================================
// Das BESTANDSKONTO (Diagnose vp-tagesbild-minus-f3 §6)
// ===========================================================================

describe('bestandZeile', () => {
  /** 21.08.2026, 12:19: 24 % → 92 % an 65 kWh, λ 18,9 ct ⇒ 44,2 kWh ⇒ ≈ +8,35 €. */
  const laufenderTag = {
    speicherDeltaKwh: 44.2,
    speicherWertCtKwh: 18.9,
    speicherWertEur: 8.3538,
    speicherWertBasis: 'plan',
    to: '2026-08-22T00:00:00Z',
    range: 'day',
  };
  const JETZT = new Date('2026-08-21T10:19:00Z');

  it('nennt am LAUFENDEN Tag die Menge und ihren Plan-Wert', () => {
    const z = bestandZeile(laufenderTag, JETZT);
    expect(z).not.toBeNull();
    expect(z?.text).toBe(
      `44,2${NBSP}kWh Speicherenergie seit Tagesbeginn gespeichert · Planwert 8,35${NBSP}€`,
    );
    expect(z?.badge).toBe(BESTAND_BADGE);
    expect(z?.titel).toContain('Speicherwert dieser Viertelstunde');
    expect(z?.titel).toContain(`18,9${NBSP}ct/kWh`);
    expect(z?.titel).toContain('wird nicht vom Verdienst abgezogen');
    expect(z?.deltaKwh).toBeCloseTo(44.2, 6);
    expect(z?.wertEur).toBeCloseTo(8.3538, 6);
  });

  it('zeigt die genutzte Speicherenergie nicht als Minus unter dem Verdienst', () => {
    const z = bestandZeile(
      {
        ...laufenderTag,
        speicherDeltaKwh: -28.6,
        speicherWertCtKwh: 20.2,
        speicherWertEur: -5.7772,
      },
      JETZT,
    );
    expect(z?.text).toBe(
      `28,6${NBSP}kWh Speicherenergie seit Tagesbeginn genutzt · Planwert 5,78${NBSP}€`,
    );
    expect(z?.text).not.toMatch(/[+−-]\s*5,78/);
    expect(z?.badge).toBe('Kein Abzug');
  });

  it('behält den intern signierten Planwert für die fachliche Rechnung', () => {
    const z = bestandZeile(laufenderTag, JETZT);
    expect(-4.69 + (z?.wertEur ?? 0)).toBeCloseTo(3.66, 2);
  });

  it('sagt am ABGESCHLOSSENEN Tag den FK2-Wortlaut - in BEIDEN Vorzeichen', () => {
    const vorbei = new Date('2026-08-22T09:00:00Z');
    expect(bestandZeile(laufenderTag, vorbei)?.text).toBe(
      `44,2${NBSP}kWh Speicherenergie für den Folgetag gespeichert · Planwert 8,35${NBSP}€`,
    );
    const entnommen = bestandZeile(
      { ...laufenderTag, speicherDeltaKwh: -16.9, speicherWertEur: -2.6195 },
      vorbei,
    );
    expect(entnommen?.text).toBe(
      `16,9${NBSP}kWh Speicherenergie aus dem Vortag genutzt · Planwert 2,62${NBSP}€`,
    );
  });

  it('spricht über einen längeren Zeitraum ZEITRAUM-neutral', () => {
    const monat = { ...laufenderTag, range: 'month', to: '2026-08-01T00:00:00Z' };
    expect(bestandZeile(monat, new Date('2026-08-15T00:00:00Z'))?.text).toContain(
      '44,2\u00a0kWh Speicherenergie im Zeitraum gespeichert',
    );
  });

  it('nennt am laufenden Zeitraum die Nutzung seit Tagesbeginn, nie den Vortag', () => {
    const z = bestandZeile({ ...laufenderTag, speicherDeltaKwh: -12.4, speicherWertEur: -2.34 }, JETZT);
    expect(z?.text).toContain('Speicherenergie seit Tagesbeginn genutzt');
    expect(z?.text).not.toContain('Vortag');
  });

  it('lässt die MENGE stehen, wenn es keine Bewertung gibt - die kWh sind gemessen', () => {
    const z = bestandZeile(
      { ...laufenderTag, speicherWertEur: null, speicherWertCtKwh: null, speicherWertBasis: null },
      JETZT,
    );
    expect(z?.text).toBe(
      `44,2${NBSP}kWh Speicherenergie seit Tagesbeginn gespeichert · Planwert noch nicht verfügbar`,
    );
    expect(z?.badge).toBeNull();
    expect(z?.titel).toBeNull();
    expect(z?.wertEur).toBeNull();
  });

  it('sagt, WOMIT bewertet wurde - und übersetzt kein unbekanntes Wort', () => {
    expect(bestandZeile({ ...laufenderTag, speicherWertBasis: 'terminal' }, JETZT)?.titel).toContain(
      'am Ende des Fahrplans',
    );
    expect(bestandZeile({ ...laufenderTag, speicherWertBasis: 'irgendwas' }, JETZT)?.titel).toBeNull();
  });

  it('schweigt ohne Bestand, im Rauschen und bei einem ÄLTEREN Backend', () => {
    expect(bestandZeile(null, JETZT)).toBeNull();
    expect(bestandZeile({}, JETZT)).toBeNull();
    expect(bestandZeile({ ...laufenderTag, speicherDeltaKwh: 0 }, JETZT)).toBeNull();
    expect(bestandZeile({ ...laufenderTag, speicherDeltaKwh: 0.3 }, JETZT)).toBeNull();
    expect(bestandZeile({ ...laufenderTag, speicherDeltaKwh: null }, JETZT)).toBeNull();
  });

  it('zeigt einen belegten Planwert unter einem Cent als solchen', () => {
    const z = bestandZeile({ ...laufenderTag, speicherWertEur: 0.001 }, JETZT);
    expect(z?.text).toContain(`Planwert < 0,01${NBSP}€`);
    expect(z?.badge).toBe('Kein Abzug');
    expect(z?.titel).toContain('wird nicht vom Verdienst abgezogen');
    expect(z?.deltaKwh).toBeCloseTo(44.2, 6);
  });
});

describe('erloesErgebnis · das Bestandskonto', () => {
  it('zeigt es NEBEN der Zurechnung und rechnet es NIE in die grosse Zahl', () => {
    const v = erloesErgebnis({
      money: siteMoney({
        range: 'day',
        to: '2026-08-22T00:00:00Z',
        nettoErgebnisEur: 14.98,
        savedEur: -4.69,
        speicherDeltaKwh: 44.2,
        speicherWertCtKwh: 18.9,
        speicherWertEur: 8.3538,
        speicherWertBasis: 'plan',
      }),
      periodLabel: 'Fr., 21.08.2026',
      now: new Date('2026-08-21T10:19:00Z'),
    });
    expect(v.bestand?.text).toContain('Speicherenergie seit Tagesbeginn gespeichert');
    expect(v.steering).toContain('VoltPilots Steuerung');
    // Die grosse Zahl bleibt die gemessene Kasse.
    expect(v.nettoEur).toBeCloseTo(14.98, 6);
  });

  it('bleibt ohne die Felder zeichengleich zu vorher (älteres Backend)', () => {
    const v = erloesErgebnis({ money: siteMoney(), periodLabel: 'Juli 2026' });
    expect(v.bestand).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * P0 · die drei Defekte der Live-Karte (Konzept `vp-erloese-seite-konzept-e2`
 * §2.3 B1/B2/B6, Entscheid E8). Die Vektoren sind die Fixtures des Konzepts
 * (`derived.json`): `dv-praemie-ruht` (Negativpreis-Tag), `dv-tag-laufend`
 * (laufender Tag mit negativer Zurechnung) und `eeg-ohne-tarif` (tariflose
 * Anlage mit dem Produktions-Standardsatz).
 * ------------------------------------------------------------------------- */

/** `dv-praemie-ruht` — Direktvermarktung, Negativpreis-Tag (Mo., 24.08.2026). */
function praemieRuht(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return siteMoney({
    range: 'day',
    from: '2026-08-23T22:00:00Z',
    to: '2026-08-24T22:00:00Z',
    tarifArt: 'fest',
    tarifParamCtKwh: 25,
    tarifPriced: true,
    einspeiseErloesEur: -1.42,
    eigenverbrauchsWertEur: 30.1,
    stromkostenEur: 0.98,
    nettoErgebnisEur: 27.7,
    savedEur: 6.8,
    marktpraemieEur: 0.61,
    selbstverbrauchKwh: 120.4,
    ...over,
  });
}

/** `dv-tag-laufend` — der Screenshot-Fall: laufender Tag, Zurechnung negativ. */
function tagLaufend(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return siteMoney({
    range: 'day',
    from: '2026-09-01T22:00:00Z',
    to: '2026-09-02T22:00:00Z',
    tarifArt: 'fest',
    tarifParamCtKwh: 25,
    tarifPriced: true,
    einspeiseErloesEur: 26.134,
    eigenverbrauchsWertEur: 38.684,
    stromkostenEur: 1.585,
    nettoErgebnisEur: 63.233,
    savedEur: -2.67,
    marktpraemieEur: 4.79,
    selbstverbrauchKwh: 154.736,
    ...over,
  });
}

/** `eeg-ohne-tarif` — kein Stromtarif hinterlegt, aber tariflich bewertet. */
function ohneTarif(over: Partial<SiteEarnings> = {}): SiteEarnings {
  return siteMoney({
    range: 'day',
    from: '2026-08-31T22:00:00Z',
    to: '2026-09-01T22:00:00Z',
    plantKind: 'eigenverbrauch',
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    tarifPriced: true,
    einspeiseErloesEur: 1.995,
    eigenverbrauchsWertEur: null,
    stromkostenEur: 1.118,
    nettoErgebnisEur: 0.877,
    savedEur: 3.4,
    marktpraemieEur: null,
    selbstverbrauchKwh: 18.2,
    ...over,
  });
}

describe('P0/B1 · das Vorzeichen einer Zeile kommt aus dem WERT', () => {
  it('zeigt einen negativen Einspeise-Erlös als Abzug, nicht als Gutschrift', () => {
    const v = erloesErgebnis({
      money: praemieRuht(),
      periodLabel: 'Mo., 24.08.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    const e = v.rows.find((r) => r.id === 'einspeisung')!;
    expect(e.eur).toBe(-1.42);
    // Die ROLLE bleibt eine Einnahme - das gezeigte ZEICHEN folgt dem Wert.
    expect(e.rolle).toBe('plus');
    expect(e.vorzeichen).toBe('minus');
    expect(e.valueText).toBe(`1,42${NBSP}€`);
    expect(e.gegenlaeufig).toBe(true);
  });

  it('zeigt eine Bezugs-Gutschrift als Plus statt als Abzug', () => {
    const v = erloesErgebnis({
      money: tagLaufend({
        tarifArt: 'dynamisch',
        tarifParamCtKwh: null,
        stromkostenEur: -0.4,
        nettoErgebnisEur: 26.134 + 38.684 + 0.4,
      }),
      periodLabel: 'Mi., 02.09.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    const k = v.rows.find((r) => r.id === 'stromkosten')!;
    expect(k.rolle).toBe('minus');
    expect(k.vorzeichen).toBe('plus');
    expect(k.valueText).toBe(`0,40${NBSP}€`);
  });

  it('rechnet mit dem gezeigten Zeichen und dem gezeigten Betrag auf das Netto', () => {
    const v = erloesErgebnis({
      money: praemieRuht(),
      periodLabel: 'Mo., 24.08.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    const summe = v.rows
      .filter((r) => r.period === 'range' && r.eur != null)
      .reduce(
        (acc, r) => acc + (r.vorzeichen === 'minus' ? -1 : 1) * Math.abs(r.eur as number),
        0,
      );
    expect(summe).toBeCloseTo(v.nettoEur as number, 6);
  });

  it('zeichnet für eine gegenläufige Zeile keinen Balken und schrumpft die anderen nicht', () => {
    const v = erloesErgebnis({
      money: praemieRuht(),
      periodLabel: 'Mo., 24.08.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    expect(v.rows.find((r) => r.id === 'einspeisung')!.barFraction).toBe(0);
    // Der Maßstab ist die größte GEZEICHNETE Zeile (30,10 €), nicht die
    // gegenläufige - sonst hinge der ganze Stapel an einem Balken, den es
    // gar nicht gibt.
    expect(v.rows.find((r) => r.id === 'eigenverbrauchswert')!.barFraction).toBe(1);
    expect(v.rows.find((r) => r.id === 'stromkosten')!.barFraction).toBeCloseTo(0.98 / 30.1, 6);
  });

  it('lässt eine Anlage ohne negative Zeile Zeichen für Zeichen wie vorher', () => {
    const v = erloesErgebnis({ money: siteMoney(), periodLabel: 'Juli 2026' });
    expect(v.rows.map((r) => r.vorzeichen)).toEqual(['plus', 'plus', 'minus']);
    expect(v.rows.every((r) => r.vorzeichen === r.rolle)).toBe(true);
    expect(v.rows.some((r) => r.gegenlaeufig)).toBe(false);
  });
});

describe('P0/B2 · der Steuerungs-Chip trägt seinen Ton (E8)', () => {
  it('ist bei einem Plus grün wie bisher', () => {
    const v = erloesErgebnis({
      money: praemieRuht(),
      periodLabel: 'Mo., 24.08.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    expect(v.steering).toBe(`davon 6,80${NBSP}€ durch VoltPilots Steuerung`);
    expect(v.steeringTon).toBe('ok');
  });

  it('nennt ein Minus im LAUFENDEN Zeitraum einen Zwischenstand — neutral, nie grün', () => {
    const v = erloesErgebnis({
      money: tagLaufend(),
      periodLabel: 'Mi., 02.09.2026',
      // 02.09. 12:19 MESZ — der Tag läuft noch (`to` ist 22:00 UTC).
      now: new Date('2026-09-02T10:19:00Z'),
    });
    expect(v.steeringTon).toBe('neutral');
    expect(v.steering).toBe(`VoltPilots Steuerung: −2,67${NBSP}€ — Zwischenstand`);
  });

  it('färbt ein Minus im ABGESCHLOSSENEN Zeitraum bernstein und sagt „weniger als"', () => {
    const v = erloesErgebnis({
      money: tagLaufend(),
      periodLabel: 'Mi., 02.09.2026',
      // Derselbe Tag, einen Tag später betrachtet: jetzt ist er abgeschlossen.
      now: new Date('2026-09-03T10:19:00Z'),
    });
    expect(v.steeringTon).toBe('warn');
    expect(v.steering).toBe(`VoltPilots Steuerung: 2,67${NBSP}€ weniger als ohne Steuerung`);
  });

  it('sagt ohne Zurechnung gar nichts — kein Chip, kein Ton', () => {
    const v = erloesErgebnis({
      money: tagLaufend({ savedEur: null }),
      periodLabel: 'Mi., 02.09.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    expect(v.steering).toBeNull();
    expect(v.steeringTon).toBeNull();
    expect(v.steeringFormel).toBeNull();
  });

  it('ist als reine Ableitung für sich prüfbar', () => {
    expect(steeringChip(0.004, false)).toBeNull();
    expect(steeringChip(null, false)).toBeNull();
    expect(steeringChip(2.67, true)?.ton).toBe('ok');
    expect(steeringChip(-2.67, true)?.ton).toBe('neutral');
    expect(steeringChip(-2.67, false)?.ton).toBe('warn');
  });
});

describe('P0/B6b · „Ihr Stromtarif" nur, wo es EINEN gibt', () => {
  // ⚠ B6a („Ohne hinterlegten Stromtarif nicht bewertet") ist mit PR 592 (E7,
  // 02.09.2026) HINFÄLLIG geworden: der Server bewertet den Eigenverbrauch
  // seither IMMER zum Bezugspreis der Karte, ein fehlender Wert heißt also
  // wirklich fehlende Daten. Der Vektor bleibt als Wächter dieser Entscheidung.
  it('behauptet bei fehlendem Wert keinen fehlenden Tarif mehr (E7)', () => {
    const v = erloesErgebnis({
      money: ohneTarif(),
      periodLabel: 'Di., 01.09.2026',
      now: new Date('2026-09-02T12:05:00Z'),
    });
    const r = v.rows.find((x) => x.id === 'eigenverbrauchswert')!;
    expect(r.eur).toBeNull();
    expect(r.note).toBe('Noch keine Daten.');
    expect(r.note).not.toContain('Stromtarif');
  });

  it('B6b · nennt den Standard-Satz beim Namen, statt einen Kundentarif zu behaupten', () => {
    const v = erloesErgebnis({
      money: ohneTarif(),
      periodLabel: 'Di., 01.09.2026',
      now: new Date('2026-09-02T12:05:00Z'),
    });
    expect(v.rows.find((x) => x.id === 'stromkosten')!.note).toBe('bewertet zum Standard-Satz');
  });

  it('bleibt bei einem echten Kundentarif bei „Ihrem Stromtarif"', () => {
    const v = erloesErgebnis({
      money: tagLaufend(),
      periodLabel: 'Mi., 02.09.2026',
      now: new Date('2026-09-02T10:19:00Z'),
    });
    expect(v.rows.find((x) => x.id === 'stromkosten')!.note).toBe('bewertet zu Ihrem Stromtarif');
  });

  it('bleibt ohne tarifliche Bewertung beim Börsenpreis', () => {
    const v = erloesErgebnis({
      money: ohneTarif({ tarifPriced: false }),
      periodLabel: 'Di., 01.09.2026',
      now: new Date('2026-09-02T12:05:00Z'),
    });
    expect(v.rows.find((x) => x.id === 'stromkosten')!.note).toBe(
      'bewertet zum Börsenpreis der jeweiligen Viertelstunde',
    );
  });
});
