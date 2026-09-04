import { describe, expect, it } from 'vitest';
import { hashForRoute, pageRoute, parseRoute } from './nav';
import { WELTEN } from './historieWelten';
import type { EarningsSite, EarningsVergleich, History, HistoryBucket, Site } from './api';
import {
  abdeckung,
  earningsRangeFor,
  erloeseAggregat,
  hatGeldWelt,
  messwerteAggregat,
  PORTFOLIO_TABELLE_KEYS,
  PORTFOLIO_WELTEN,
  portfolioHash,
  portfolioRange,
  portfolioRanges,
  portfolioVergleich,
  portfolioWeltForPage,
  flottenSatz,
  SPEICHER_JE_ANLAGE,
  zeilenHinweis,
  type PortfolioHistoryInput,
} from './portfolioHistorie';

/**
 * **Die zwei Welten eine Ebene höher** (PR G): Σ oben, Anlagen darunter, Klick
 * öffnet dieselbe Welt der Anlage im gleichen Zeitraum. Die Regeln, die hier
 * festgenagelt sind, sind die Ehrlichkeitsregeln der Ebene — eine Anlage ohne
 * Daten ist nie eine 0, und eine gemischte Abdeckung wird benannt.
 */

// --- Testdaten ---------------------------------------------------------------

function site(over: Partial<Site> & { id: string; name: string }): Site {
  return {
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    netzladenErlaubt: false,
    maxFeedInKw: null,
    ...over,
  };
}

function bucket(over: Partial<HistoryBucket>): HistoryBucket {
  return {
    start: '2026-07-24T10:00:00Z',
    pvKwh: null,
    loadKwh: null,
    gridImportKwh: null,
    gridExportKwh: null,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
    ...over,
  };
}

function history(buckets: HistoryBucket[]): History {
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    buckets,
    totals: {
      consumptionKwh: null,
      pvGenerationKwh: null,
      gridImportKwh: null,
      gridExportKwh: null,
      gridCostEur: null,
      tarifArt: 'ohne',
      batterySavingsPlannedEur: null,
      autarkiePct: null,
      eigenverbrauchPct: null,
    },
    protocol: [],
    plan: [],
  };
}

function earningsSite(over: Partial<EarningsSite> & { id: string; name: string }): EarningsSite {
  return {
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
    tarifArt: 'ohne',
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
    ...over,
  };
}

// --- Die Welten selbst -------------------------------------------------------

describe('die zwei Portfolio-Welten', () => {
  it('erben Name, Icon und Abzeichen von der Anlagen-Welt (nie ein zweiter Name)', () => {
    for (const id of ['messwerte', 'erloese'] as const) {
      expect(PORTFOLIO_WELTEN[id].label).toBe(WELTEN[id].label);
      expect(PORTFOLIO_WELTEN[id].icon).toBe(WELTEN[id].icon);
      expect(PORTFOLIO_WELTEN[id].badge).toBe(WELTEN[id].badge);
    }
    // ...sprechen aber über die Ebene, nicht über eine Anlage.
    expect(PORTFOLIO_WELTEN.messwerte.lead).toContain('alle Ihre Anlagen');
    expect(PORTFOLIO_WELTEN.erloese.lead).toContain('alle Ihre Anlagen');
  });

  it('sind über ihre eigene Seite auffindbar', () => {
    expect(portfolioWeltForPage('portfolio-messwerte')?.id).toBe('messwerte');
    expect(portfolioWeltForPage('portfolio-erloese')?.id).toBe('erloese');
    expect(portfolioWeltForPage('portfolio')).toBeNull();
    expect(portfolioWeltForPage('uebersicht')).toBeNull();
  });
});

describe('die Zeiträume je Welt', () => {
  it('bietet der Messwerte-Welt alle vier an', () => {
    expect(portfolioRanges('messwerte').map((r) => r.id)).toEqual([
      'day',
      'week',
      'month',
      'year',
    ]);
  });

  it('bietet der Erlöse-Welt KEINE Woche an - ihr Endpunkt kennt keine', () => {
    expect(portfolioRanges('erloese').map((r) => r.id)).toEqual(['day', 'month', 'year']);
    // Ein Lesezeichen mit `z=woche` landet sichtbar auf dem Monat, statt
    // Monatszahlen unter dem Wort „Woche" zu zeigen.
    expect(portfolioRange('erloese', 'week')).toBe('month');
    expect(portfolioRange('erloese', 'year')).toBe('year');
    expect(portfolioRange('messwerte', 'week')).toBe('week');
  });

  it('übersetzt den Zeitraum in die Vokabel des Geld-Endpunkts', () => {
    expect(earningsRangeFor('day')).toBe('day');
    expect(earningsRangeFor('month')).toBe('month');
    expect(earningsRangeFor('year')).toBe('year');
    expect(earningsRangeFor('week')).toBe('month');
  });
});

describe('die Adressen der Portfolio-Ebene', () => {
  it('nimmt den Zeitraum in den Wechsel-Link mit', () => {
    expect(portfolioHash('messwerte', 'month', '2026-05-01')).toBe(
      '#/portfolio/messwerte?z=monat&at=2026-05-01',
    );
    expect(portfolioHash('erloese', 'day')).toBe('#/portfolio/erloese?z=tag');
    // Auch der Link klemmt eine Woche in der Erlöse-Welt auf den Monat.
    expect(portfolioHash('erloese', 'week')).toBe('#/portfolio/erloese?z=monat');
  });

  it('ist zweistufig adressiert und geht sauber hin und zurück', () => {
    expect(parseRoute('#/portfolio')).toEqual(pageRoute('portfolio'));
    expect(parseRoute('#/portfolio/messwerte')).toEqual(pageRoute('portfolio-messwerte'));
    expect(parseRoute('#/portfolio/erloese?z=monat')).toEqual(pageRoute('portfolio-erloese'));
    expect(hashForRoute(pageRoute('portfolio-messwerte'))).toBe('#/portfolio/messwerte');
    expect(hashForRoute(pageRoute('portfolio-erloese'))).toBe('#/portfolio/erloese');
    // Ein unbekannter zweiter Abschnitt landet auf der Landung, nie im Leeren.
    expect(parseRoute('#/portfolio/quatsch')).toEqual(pageRoute('portfolio'));
  });
});

describe('hatGeldWelt: der Nav-Eintrag der Erlöse-Welt', () => {
  it('erscheint, sobald EINE Anlage einen Geld-Modus hat', () => {
    const privat = site({ id: 'a', name: 'Hof' });
    const dv = site({ id: 'b', name: 'Park', plantKind: 'direktvermarktung' });
    expect(hatGeldWelt([privat])).toBe(false);
    expect(hatGeldWelt([privat, dv])).toBe(true);
  });

  it('kennt die drei Stammdaten-Signale der Anlagen-Regel', () => {
    expect(hatGeldWelt([site({ id: 'a', name: 'A', leistungspreisEurKw: 120 })])).toBe(true);
    expect(
      hatGeldWelt([site({ id: 'b', name: 'B', netzladenErlaubt: true, tarifArt: 'dynamisch' })]),
    ).toBe(true);
    // Netzladen ALLEIN (ohne dynamischen Tarif) ist kein Geld-Modus.
    expect(hatGeldWelt([site({ id: 'c', name: 'C', netzladenErlaubt: true })])).toBe(false);
    expect(hatGeldWelt([])).toBe(false);
  });
});

describe('abdeckung: gemischte Datenlage wird BENANNT', () => {
  it('schweigt, wenn alle Anlagen Daten tragen', () => {
    expect(abdeckung(['daten', 'daten']).satz).toBeNull();
  });

  it('nennt die Zahl, sobald eine Anlage fehlt', () => {
    const a = abdeckung(['daten', 'daten', 'leer']);
    expect(a.mitDaten).toBe(2);
    expect(a.gesamt).toBe(3);
    expect(a.satz).toBe('2 von 3 Anlagen mit Daten in diesem Zeitraum');
  });

  it('trennt einen FEHLER von einer leeren Anlage', () => {
    const a = abdeckung(['daten', 'fehler']);
    expect(a.fehler).toBe(1);
    expect(a.satz).toBe(
      '1 von 2 Anlagen mit Daten in diesem Zeitraum · 1 Anlage konnte nicht geladen werden',
    );
  });
});

// --- Welt A · Messwerte ------------------------------------------------------

describe('messwerteAggregat', () => {
  const mitDaten: PortfolioHistoryInput = {
    siteId: 'a',
    name: 'Solarpark Dachau',
    history: history([
      bucket({ pvKwh: 10, loadKwh: 4, gridImportKwh: 1, gridExportKwh: 7, batteryChargeKwh: 2 }),
      bucket({ pvKwh: 6, loadKwh: 2, gridImportKwh: 0, gridExportKwh: 4, batteryDischargeKwh: 1 }),
    ]),
  };
  const zweite: PortfolioHistoryInput = {
    siteId: 'b',
    name: 'Hof Lindenberg',
    history: history([bucket({ pvKwh: 4, loadKwh: 3, gridImportKwh: 2, gridExportKwh: 1 })]),
  };
  const ohneDaten: PortfolioHistoryInput = { siteId: 'c', name: 'Neubau', history: history([]) };
  const kaputt: PortfolioHistoryInput = {
    siteId: 'd',
    name: 'Störung',
    history: null,
    fehler: true,
  };

  it('summiert über die Anlagen, die den Kanal getragen haben', () => {
    const a = messwerteAggregat([mitDaten, zweite]);
    const byKey = new Map(a.summen.map((s) => [s.key, s]));
    expect(byKey.get('erzeugt')?.kwh).toBe(20);
    expect(byKey.get('verbraucht')?.kwh).toBe(9);
    expect(byKey.get('bezogen')?.kwh).toBe(3);
    expect(byKey.get('eingespeist')?.kwh).toBe(12);
    expect(byKey.get('erzeugt')?.anlagen).toBe(2);
    expect(a.leer).toBe(false);
  });

  it('zählt eine Anlage OHNE Daten nie als 0 - sie steht mit ihrem Grund da', () => {
    const a = messwerteAggregat([mitDaten, ohneDaten]);
    const erzeugt = a.summen.find((s) => s.key === 'erzeugt');
    // Die Summe ist die der EINEN messenden Anlage, nicht ein Mittel über zwei.
    expect(erzeugt?.kwh).toBe(16);
    expect(erzeugt?.anlagen).toBe(1);
    expect(a.abdeckung.satz).toBe('1 von 2 Anlagen mit Daten in diesem Zeitraum');
    const zeile = a.zeilen.find((z) => z.siteId === 'c');
    expect(zeile?.zustand).toBe('leer');
    expect(zeile?.hinweis).toBe('Keine Messwerte in diesem Zeitraum.');
    expect(zeile?.werte).toEqual([null, null, null, null]);
  });

  it('unterscheidet einen fehlgeschlagenen Abruf von „keine Daten"', () => {
    const a = messwerteAggregat([mitDaten, kaputt]);
    const zeile = a.zeilen.find((z) => z.siteId === 'd');
    expect(zeile?.zustand).toBe('fehler');
    expect(zeile?.hinweis).toBe('Konnte nicht geladen werden.');
    expect(a.abdeckung.fehler).toBe(1);
    expect(a.abdeckung.satz).toContain('konnte nicht geladen werden');
  });

  it('ist LEER (nicht 0), solange keine Anlage einen Kanal getragen hat', () => {
    const a = messwerteAggregat([ohneDaten, kaputt]);
    expect(a.leer).toBe(true);
    expect(a.summen.every((s) => s.kwh == null)).toBe(true);
  });

  it('trägt je Zeile die vier Tabellenwerte und den Mini-Trend', () => {
    const a = messwerteAggregat([mitDaten]);
    const zeile = a.zeilen[0];
    expect(PORTFOLIO_TABELLE_KEYS).toEqual(['erzeugt', 'verbraucht', 'bezogen', 'eingespeist']);
    expect(zeile.werte).toEqual([16, 6, 1, 11]);
    expect(zeile.spark).toEqual([10, 6]);
    expect(zeile.hinweis).toBeNull();
  });
});

// --- Welt B · Erlöse ---------------------------------------------------------

describe('erloeseAggregat', () => {
  const dachau = earningsSite({
    id: 'a',
    name: 'Solarpark Dachau',
    einspeiseErloesEur: 900,
    eigenverbrauchsWertEur: 99.26,
    gesamtertragEur: 999.26,
    // Stromkosten 40 EUR => actual = stromkosten - einspeise = -860; das Netto
    // ist 900 + 99,26 - 40 = 959,26 (die Identitaet, die `nettoEur` fuehrt).
    actualEur: -860,
    savedEur: 161.44,
    savedSpeicherEur: 93.2,
    savedSteuerungEur: 68.24,
    eingespeistKwh: 9573.8,
    coveredSlots: 2880,
    series: [
      { start: '2026-07-01T00:00:00Z', gesamtertragEur: 400 },
      { start: '2026-07-02T00:00:00Z', gesamtertragEur: 599.26 },
    ],
  });
  const lindenberg = earningsSite({
    id: 'b',
    name: 'Hof Lindenberg',
    einspeiseErloesEur: 62.21,
    gesamtertragEur: 62.21,
    // Stromkosten 12,21 EUR => actual = -50; Netto = 62,21 - 12,21 = 50,00.
    actualEur: -50,
    savedEur: 16.79,
    savedSpeicherEur: 9.5,
    savedSteuerungEur: 7.29,
    eingespeistKwh: 1028.3,
    coveredSlots: 859,
  });
  const ohne = earningsSite({ id: 'c', name: 'Neubau', reason: 'no_data' });

  it('macht die große Zahl zur Summe der GEZEIGTEN Teile', () => {
    const a = erloeseAggregat([dachau, lindenberg]);
    expect(a.einspeiseEur).toBeCloseTo(962.21, 6);
    expect(a.eigenverbrauchEur).toBeCloseTo(99.26, 6);
    expect(a.stromkostenEur).toBeCloseTo(52.21, 6);
    // Die grosse Zahl ist seit E9 das Ergebnis UNTERM STRICH — und die drei
    // gezeigten Teile ergeben sie exakt.
    expect(a.nettoEur).toBeCloseTo(1009.26, 6);
    expect(
      (a.einspeiseEur ?? 0) + (a.eigenverbrauchEur ?? 0) - (a.stromkostenEur ?? 0),
    ).toBeCloseTo(a.nettoEur ?? 0, 6);
    // Die Steuerung ist eine ZURECHNUNG - sie steckt schon darin. ⚠ Seit dem
    // 04.09.2026 misst sie gegen DENSELBEN Speicher ohne smarte Steuerung
    // (68,24 + 7,29), nie mehr gegen eine Anlage OHNE Speicher (178,23).
    expect(a.steuerungEur).toBeCloseTo(75.53, 6);
    expect(a.coveredSlots).toBe(3739);
  });

  it('zählt eine Anlage ohne bewertete Viertelstunde nie als 0', () => {
    const a = erloeseAggregat([dachau, ohne]);
    expect(a.nettoEur).toBeCloseTo(959.26, 6);
    expect(a.abdeckung.satz).toBe('1 von 2 Anlagen mit Daten in diesem Zeitraum');
    // Sie fehlt in der Summe UND wird gezaehlt, damit die Flaeche sie nennen
    // kann statt sie stillschweigend als 0 mitzufuehren.
    expect(a.ohneErgebnis).toBe(1);
    const zeile = a.zeilen.find((z) => z.siteId === 'c');
    expect(zeile?.zustand).toBe('leer');
    expect(zeile?.nettoEur).toBeNull();
    expect(zeile?.hinweis).toBe('Keine Messwerte in diesem Zeitraum.');
  });

  it('nennt den Grund, den der Endpunkt nennt', () => {
    expect(zeilenHinweis('missing_channels')).toContain('Messwerte');
    expect(zeilenHinweis('no_prices')).toContain('Börsenpreise');
    expect(zeilenHinweis(null)).toBe('Keine Messwerte in diesem Zeitraum.');
  });

  it('führt die ergiebigste Anlage oben, Anlagen ohne Zahlen am Ende', () => {
    const a = erloeseAggregat([lindenberg, ohne, dachau]);
    expect(a.zeilen.map((z) => z.siteId)).toEqual(['a', 'b', 'c']);
    expect(a.zeilen[0].spark).toEqual([400, 599.26]);
  });

  it('führt auch die Anlagen, die der Endpunkt gar nicht nennt', () => {
    const a = erloeseAggregat([dachau], [
      { id: 'a', name: 'Solarpark Dachau' },
      { id: 'z', name: 'Ganz neue Anlage' },
    ]);
    expect(a.zeilen.map((z) => z.siteId)).toEqual(['a', 'z']);
    expect(a.zeilen[1].zustand).toBe('leer');
    expect(a.nettoEur).toBeCloseTo(959.26, 6);
    // Eine Anlage, die der Endpunkt gar nicht nennt, ist keine Anlage OHNE
    // Ergebnis — sie hat nur (noch) keine Antwort.
    expect(a.ohneErgebnis).toBe(0);
  });

  it('ist LEER, solange keine Anlage etwas Bewertetes trägt', () => {
    const a = erloeseAggregat([ohne]);
    expect(a.leer).toBe(true);
    expect(a.nettoEur).toBeNull();
    expect(a.stromkostenEur).toBeNull();
    expect(a.steuerungEur).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Der Vergleich der Flotten-Zahl (P6 · E3 · Befund B13)
// ---------------------------------------------------------------------------

describe('portfolioVergleich: gleiche Stunde oder gar nichts', () => {
  // Ein Zeitpunkt MITTEN im laufenden Tag; `anchor` ist derselbe Tag.
  const now = new Date('2026-09-03T09:12:00+02:00');
  const heute = new Date('2026-09-03T12:00:00+02:00');
  const server = (o: Partial<EarningsVergleich> = {}): EarningsVergleich => ({
    modus: 'gleicher_zeitpunkt',
    bisStunde: 9,
    jetztEur: 50.9,
    vorherEur: 67.71,
    ...o,
  });

  it('nimmt am laufenden Tag den Server-Wert und nennt die Schnitt-Stunde', () => {
    const v = portfolioVergleich({
      range: 'day',
      anchor: heute,
      now,
      server: server(),
      jetztEur: 50.9,
      vorherEur: 400,
    });
    expect(v?.modus).toBe('gleicher_zeitpunkt');
    expect(v?.bisStunde).toBe(9);
    expect(v?.jetztEur).toBe(50.9);
    // ⚠ Der VORTAG kommt vom Server (bis zur gleichen Stunde), nie aus dem
    //   zweiten Abruf mit dem VOLLEN Vortag (400) — genau das war B13.
    expect(v?.vorherEur).toBe(67.71);
    // ⚠ `eurAmount` setzt ein GESCHÜTZTES Leerzeichen vor das €-Zeichen —
    //   deshalb eine Regex statt eines Literals.
    expect(v?.betraege).toMatch(/^Bis 9 Uhr: heute 50,90\s€ · gestern 67,71\s€$/);
    expect(v?.satz).toContain('bis 9 Uhr');
  });

  it('wertet am laufenden Tag NICHT — der Chip bleibt neutral', () => {
    const v = portfolioVergleich({
      range: 'day',
      anchor: heute,
      now,
      server: server(),
      jetztEur: 50.9,
      vorherEur: 67.71,
    });
    expect(v?.chip?.wertung).toBe('neutral');
    expect(v?.chip?.richtung).toBe('weniger');
  });

  it('BEFUND B13: ohne Server-Wert bleibt die Zeile am laufenden Tag WEG', () => {
    // Die alte Seite rechnete hier 0,53 € gegen 3,35 € und schrieb
    // „532 % mehr als am Vortag" über einen halben Tag.
    expect(
      portfolioVergleich({
        range: 'day',
        anchor: heute,
        now,
        server: null,
        jetztEur: 3.35,
        vorherEur: 0.53,
      }),
    ).toBeNull();
  });

  it('ein abgeschlossener Tag wird gewertet und nennt keine Stunde', () => {
    const gestern = new Date('2026-09-02T12:00:00+02:00');
    const v = portfolioVergleich({
      range: 'day',
      anchor: gestern,
      now,
      server: { modus: 'ganze_periode', bisStunde: null, jetztEur: 10.6, vorherEur: 0.4 },
      jetztEur: 10.6,
      vorherEur: 0.4,
    });
    expect(v?.modus).toBe('ganze_periode');
    expect(v?.bisStunde).toBeNull();
    expect(v?.betraege).toBeNull();
    // Mehr unterm Strich ist eindeutig besser — hier DARF gewertet werden.
    expect(v?.chip?.wertung).toBe('gut');
  });

  it('eine laufende Woche/ein laufender Monat bekommen NUR die zwei Beträge', () => {
    for (const range of ['week', 'month', 'year'] as const) {
      const v = portfolioVergleich({
        range,
        anchor: heute,
        now,
        // Der Server liefert für diese Zeiträume per Vertrag nichts.
        server: null,
        jetztEur: 39.3,
        vorherEur: 41.1,
      });
      expect(v?.modus).toBe('nur_betraege');
      expect(v?.chip).toBeNull();
      expect(v?.betraege).toMatch(/^bisher 39,30\s€ · ganze[sr]? /);
    }
  });

  it('ohne Vergleichsperiode gibt es gar keine Zeile', () => {
    expect(
      portfolioVergleich({
        range: 'month',
        anchor: heute,
        now,
        server: null,
        jetztEur: 39.3,
        vorherEur: null,
      }),
    ).toBeNull();
  });

  it('ein unvollständiger Server-Block wird NICHT als gleiche Stunde gelesen', () => {
    // `bisStunde: null` bei `gleicher_zeitpunkt` wäre ein Widerspruch — dann
    // gilt die B13-Regel und die Zeile bleibt am laufenden Tag weg.
    expect(
      portfolioVergleich({
        range: 'day',
        anchor: heute,
        now,
        server: server({ bisStunde: null }),
        jetztEur: 3.35,
        vorherEur: 0.53,
      }),
    ).toBeNull();
  });
});

describe('flottenSatz: der Satz nennt die BEITRAGENDEN Anlagen', () => {
  it('hängt die Zahl an und schluckt den Punkt', () => {
    expect(flottenSatz('Heute bisher unterm Strich.', 3)).toBe(
      'Heute bisher unterm Strich · 3 Anlagen',
    );
  });

  it('bleibt bei einer Anlage im Singular', () => {
    expect(flottenSatz('Juli 2026 unterm Strich.', 1)).toBe('Juli 2026 unterm Strich · 1 Anlage');
  });

  it('nennt eine leere Flotte ehrlich mit 0', () => {
    expect(flottenSatz('Heute bisher unterm Strich.', 0)).toBe(
      'Heute bisher unterm Strich · 0 Anlagen',
    );
  });

  it('der Hinweis der Speicher-Karte nennt den ORT, nie eine Zahl', () => {
    // ⚠ Er ersetzt die Zeile „davon Steuerung", die es im Portfolio nicht
    //   geben kann (der Flotten-Endpunkt führt die Aufteilung nicht als Summe).
    expect(SPEICHER_JE_ANLAGE).toBe('je Anlage in der Tabelle');
    expect(SPEICHER_JE_ANLAGE).not.toMatch(/\d/);
  });
});
