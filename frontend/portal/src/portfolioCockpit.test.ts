import { describe, expect, it } from 'vitest';
import type { Earnings, Overview, OverviewSite } from './api';
import {
  CANONICAL_PORTFOLIO,
  PORTFOLIO_BAUSTEINE,
  anwendungenVonAnlage,
  bausteinHatWert,
  ladestandFussnote,
  portfolioAnwendungen,
  portfolioDichte,
  portfolioKennzahlen,
  pvJetztFussnote,
  ruheSatz,
  tabellenSpalten,
  verfuegbareBausteine,
} from './portfolioCockpit';

/**
 * Anwendungs-Programm Stufe 4 — die reine Schicht des Portfolio-Cockpits.
 *
 * Der Kern dieser Datei ist die EHRLICHKEIT der Zusammenfassung: Energie darf
 * man summieren, einen Prozentsatz nicht — und was keine Anlage beigetragen
 * hat, ist `null` und verschwindet, statt als „—" dazustehen (genau der
 * Zustand, den §4.3 „Gewerbe, reines Monitoring, 3 Filialen" beschreibt).
 */

const JETZT = new Date('2026-08-24T12:00:00Z');

function anlage(over: Partial<OverviewSite> & { id: string }): OverviewSite {
  return {
    name: over.id,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: JETZT.toISOString(),
    live: null,
    plannedSavingsTodayEur: null,
    ...over,
  } as OverviewSite;
}

function live(pvKw: number | null, socPct: number | null = null, ts: Date = JETZT) {
  return { ts: ts.toISOString(), pvKw, loadKw: null, gridKw: null, socPct };
}

function overview(sites: OverviewSite[], totals: Partial<Overview['totals']> = {}): Overview {
  return {
    sites,
    totals: {
      sites: sites.length,
      devices: sites.length,
      online: sites.length,
      plannedSavingsTodayEur: null,
      liveSitesCovered: sites.length,
      storageCapacityKwh: null,
      storagePowerKw: null,
      ...totals,
    },
    dailySavings: [],
  } as unknown as Overview;
}

const LEER = portfolioKennzahlen(null, null, JETZT);

// ---------------------------------------------------------------------------
// Dichte: die EINZIGE Wirkung der Betriebsart (E5)
// ---------------------------------------------------------------------------

describe('portfolioDichte', () => {
  it('gibt dem Betreiber die Tabelle und jedem anderen die ruhigen Karten', () => {
    expect(portfolioDichte('betreiber')).toBe('tabelle');
    expect(portfolioDichte('endkunde')).toBe('karten');
  });

  it('ein UNBEKANNTER Rahmen fällt auf die Karten - das Bild der FleetUebersicht', () => {
    // Bestandsneutralität: jede Organisation ohne gesetzte Betriebsart sieht
    // damit dieselbe Dichte wie vor Stufe 4.
    expect(portfolioDichte(null)).toBe('karten');
    expect(portfolioDichte(undefined)).toBe('karten');
  });
});

// ---------------------------------------------------------------------------
// Katalog: die Aggregationsregel steht am Baustein
// ---------------------------------------------------------------------------

describe('der Portfolio-Baustein-Katalog', () => {
  it('jeder Baustein sagt, WIE er zusammenfasst - aus einem geschlossenen Vokabular', () => {
    expect(PORTFOLIO_BAUSTEINE.length).toBeGreaterThanOrEqual(8);
    for (const b of PORTFOLIO_BAUSTEINE) {
      expect(['summe', 'gewichtet', 'je_anlage'], b.id).toContain(b.aggregation);
      // Ohne den Satz wäre die Art eine Behauptung, die niemand nachlesen kann.
      expect(b.aggregation_regel, b.id).toBeTruthy();
    }
  });

  it('GENAU EIN Baustein mittelt - und er trägt sein Gewicht', () => {
    // Ein zweiter „gewichtet"-Eintrag wäre der Hinweis darauf, dass jemand
    // einen Prozentsatz gemittelt hat; ein ungewichtetes Mittel gibt es im
    // Vokabular gar nicht.
    const gewichtet = PORTFOLIO_BAUSTEINE.filter((b) => b.aggregation === 'gewichtet');
    expect(gewichtet.map((b) => b.id)).toEqual(['speicher']);
    expect(gewichtet[0].aggregation_regel).toContain('GEWICHTET');
  });

  it('die kanonische Reihenfolge nennt jeden Baustein GENAU einmal', () => {
    const katalog = PORTFOLIO_BAUSTEINE.map((b) => b.id).sort();
    expect([...CANONICAL_PORTFOLIO].sort()).toEqual(katalog);
    expect(new Set(CANONICAL_PORTFOLIO).size).toBe(CANONICAL_PORTFOLIO.length);
  });

  it('führt mit dem Flotten-Status und endet mit den Anlagen', () => {
    expect(CANONICAL_PORTFOLIO[0]).toBe('flotten-status');
    expect(CANONICAL_PORTFOLIO[CANONICAL_PORTFOLIO.length - 1]).toBe('anlagen');
  });
});

// ---------------------------------------------------------------------------
// Die Anwendungen der FLOTTE
// ---------------------------------------------------------------------------

describe('portfolioAnwendungen', () => {
  it('vereinigt über die Anlagen - EINE Anlage genügt', () => {
    const o = overview([
      anlage({ id: 'a', anwendungen: ['monitoring'] }),
      anlage({ id: 'b', anwendungen: ['monitoring', 'lastspitzenkappung'] }),
    ]);
    expect(portfolioAnwendungen(o).sort()).toEqual(['lastspitzenkappung', 'monitoring']);
  });

  it('nimmt den SERVER beim Wort: eine abgeschaltete Anwendung bleibt draußen', () => {
    // Der gespeicherte Kundenwille liegt allein auf dem Server. Diese Anlage
    // HAT einen Speicher, hat den Fahrplan aber abgeschaltet - die Fläche darf
    // ihm nicht widersprechen.
    const o = overview([
      anlage({
        id: 'a',
        anwendungen: ['monitoring'],
        roleCounts: { pv: 1, storage: 1, consumer: 0, grid: 1 },
      }),
    ]);
    expect(portfolioAnwendungen(o)).toEqual(['monitoring']);
  });

  it('ein ÄLTERES Backend ohne das Feld sagt lieber zu wenig als zu viel', () => {
    const ohneFeld = anlage({
      id: 'a',
      roleCounts: { pv: 1, storage: 1, consumer: 0, grid: 1 },
    });
    const ids = anwendungenVonAnlage(ohneFeld);
    expect(ids).toContain('monitoring');
    expect(ids).toContain('speicher-fahrplan');
    // Nichts, was die Zeile nicht belegt.
    expect(ids).not.toContain('lastspitzenkappung');
  });

  it('ohne Übersicht ist die Menge leer, nie geraten', () => {
    expect(portfolioAnwendungen(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Die Kennzahlen: Σ nur, wo Σ ehrlich ist
// ---------------------------------------------------------------------------

describe('portfolioKennzahlen', () => {
  it('summiert die Energie des Tages über die Anlagen', () => {
    const o = overview([
      anlage({
        id: 'a',
        energyToday: { pvKwh: 100, loadKwh: 180, gridImportKwh: 90, gridExportKwh: 10 },
      }),
      anlage({
        id: 'b',
        energyToday: { pvKwh: 212, loadKwh: 360, gridImportKwh: 150, gridExportKwh: 2 },
      }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.erzeugungHeuteKwh).toBe(312);
    expect(k.verbrauchHeuteKwh).toBe(540);
    // Bezug und Einspeisung GETRENNT - nie saldiert.
    expect(k.bezugHeuteKwh).toBe(240);
    expect(k.einspeisungHeuteKwh).toBe(12);
  });

  it('ein fehlender Kanal trägt NICHTS bei - nie eine erfundene 0', () => {
    const o = overview([
      anlage({
        id: 'a',
        energyToday: { pvKwh: 100, loadKwh: null, gridImportKwh: null, gridExportKwh: null },
      }),
      anlage({ id: 'b', energyToday: null }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.erzeugungHeuteKwh).toBe(100);
    expect(k.verbrauchHeuteKwh).toBeNull();
    expect(k.bezugHeuteKwh).toBeNull();
  });

  it('der Ladestand ist mit der KAPAZITÄT gewichtet, nicht je Anlage gemittelt', () => {
    // Ein 10-kWh-Haus auf 100 % und ein 120-kWh-Betrieb auf 20 %: das
    // ungewichtete Mittel wäre 60 %, die Flotte hält aber 10+24 = 34 kWh von
    // 130 kWh = 26,15 %.
    const o = overview([
      anlage({ id: 'haus', storageCapacityKwh: 10, live: live(null, 100) }),
      anlage({ id: 'betrieb', storageCapacityKwh: 120, live: live(null, 20) }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.ladestandPct).toBeCloseTo((100 * 10 + 20 * 120) / 130, 6);
    expect(k.ladestandPct).not.toBeCloseTo(60, 1);
    expect(k.ladestandAnlagen).toBe(2);
  });

  it('eine Anlage OHNE gepflegte Kapazität hat kein Gewicht und geht nicht ein', () => {
    const o = overview([
      anlage({ id: 'gewichtet', storageCapacityKwh: 10, live: live(null, 80) }),
      anlage({ id: 'ohne', storageCapacityKwh: null, live: live(null, 20) }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.ladestandPct).toBe(80);
    expect(k.ladestandAnlagen).toBe(1);
  });

  it('ein unplausibler Ladestand zieht die Flotte nicht herunter', () => {
    // Die Haus-Regel `sanitizeSoc` (der reale Prod-Befund „1.270 %"): ein Wert
    // außerhalb [0,100] ist kein Messwert und wird VERWORFEN, nie an die
    // Decke geklemmt - sonst zöge eine kaputte Lesung die ganze Flotte hoch.
    const o = overview([
      anlage({ id: 'gut', storageCapacityKwh: 10, live: live(null, 90) }),
      anlage({ id: 'kaputt', storageCapacityKwh: 10, live: live(null, 1270) }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.ladestandPct).toBe(90);
    expect(k.ladestandAnlagen).toBe(1);
  });

  it('ein Ladestand von 0 zählt MIT - er ist ein ehrlicher BMS-Boden', () => {
    // Bewusst die Portal-Regel (inklusive 0), NICHT die der Box (exklusive 0):
    // eine persistierte 0 ist nach der Tatsache nicht mehr von einem echten
    // Boden zu unterscheiden, und sie zu verschweigen hübschte den
    // Flotten-Ladestand auf.
    const o = overview([
      anlage({ id: 'voll', storageCapacityKwh: 10, live: live(null, 90) }),
      anlage({ id: 'leer', storageCapacityKwh: 10, live: live(null, 0) }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.ladestandPct).toBe(45);
    expect(k.ladestandAnlagen).toBe(2);
  });

  it('„PV jetzt" zählt nur Anlagen, die GERADE melden', () => {
    const alt = new Date(JETZT.getTime() - 60 * 60 * 1000);
    const o = overview([
      anlage({ id: 'frisch', live: live(41.2) }),
      // Eine Box, die ihren Puffer mit alten Zeitstempeln nachspielt: ihr Wert
      // ist wahr, aber er ist kein „jetzt".
      anlage({ id: 'nachspielend', lastSeenAt: alt.toISOString(), live: live(30, null, alt) }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.pvJetztKw).toBeCloseTo(41.2, 6);
    expect(k.pvJetztAnlagen).toBe(1);
  });

  it('ohne einen einzigen Summanden bleibt jedes Feld null', () => {
    expect(LEER.erzeugungHeuteKwh).toBeNull();
    expect(LEER.ladestandPct).toBeNull();
    expect(LEER.pvJetztKw).toBeNull();
    expect(LEER.erloesHeuteEur).toBeNull();
    expect(LEER.ladepunkte).toBeNull();
  });

  it('summiert die vermiedene Spitze nur über die Anlagen, die eine melden', () => {
    const earnings = {
      sites: [
        { id: 'a', dailySaved: [], peakShaving: { avoidedEur: 2640, avoidedKw: 22 } },
        { id: 'b', dailySaved: [], peakShaving: null },
      ],
      totals: { savedEur: 12 },
    } as unknown as Earnings;
    const k = portfolioKennzahlen(overview([anlage({ id: 'a' }), anlage({ id: 'b' })]), earnings, JETZT);
    expect(k.vermiedeneSpitzeEur).toBe(2640);
    expect(k.vermiedeneSpitzeKw).toBe(22);
  });

  it('zählt die Ladepunkte, sagt aber ohne einen einzigen NICHTS', () => {
    const mit = portfolioKennzahlen(
      overview([anlage({ id: 'a', chargePointCount: 2 }), anlage({ id: 'b', chargePointCount: 1 })]),
      null,
      JETZT,
    );
    expect(mit.ladepunkte).toBe(3);
    const ohne = portfolioKennzahlen(
      overview([anlage({ id: 'a', chargePointCount: 0 })]),
      null,
      JETZT,
    );
    expect(ohne.ladepunkte).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Welche Bausteine hat diese Flotte?
// ---------------------------------------------------------------------------

describe('verfuegbareBausteine', () => {
  it('§4.3 Fall C: der Nur-Monitoring-Kunde bekommt ECHTE Zahlen statt „—, —, —"', () => {
    const sites = ['filiale-1', 'filiale-2', 'filiale-3'].map((id, i) =>
      anlage({
        id,
        anwendungen: ['monitoring'],
        live: live(13.7 + i),
        energyToday: {
          pvKwh: 104,
          loadKwh: 180,
          gridImportKwh: 120,
          gridExportKwh: 8,
        },
      }),
    );
    const k = portfolioKennzahlen(overview(sites), null, JETZT);
    const ids = verfuegbareBausteine({
      anwendungen: portfolioAnwendungen(overview(sites)),
      kennzahlen: k,
      anlagen: 3,
    });
    expect(ids).toContain('pv-jetzt');
    expect(ids).toContain('erzeugung-heute');
    expect(ids).toContain('verbrauch-heute');
    expect(ids).toContain('netz-heute');
    expect(ids).toContain('flotten-status');
    expect(ids).toContain('anlagen');
    // Und genau das, was diese Flotte NICHT hat, steht auch nicht da.
    expect(ids).not.toContain('speicher');
    expect(ids).not.toContain('erloese');
    expect(ids).not.toContain('lastspitzen');
    expect(ids).not.toContain('ladepunkte');
    expect(k.erzeugungHeuteKwh).toBe(312);
  });

  it('lässt einen Baustein weg, dessen Anwendung nicht läuft - auch mit Wert', () => {
    // Beide Hälften müssen stimmen (Regeln 2 UND 3): eine abgeschaltete
    // Anwendung blendet ihren Baustein aus, obwohl die Zahl vorliegt.
    const sites = [anlage({ id: 'a', anwendungen: ['monitoring'], storageCapacityKwh: 10, live: live(null, 50) })];
    const k = portfolioKennzahlen(overview(sites, { storageCapacityKwh: 10 }), null, JETZT);
    expect(k.speicherKwh).toBe(10);
    const ids = verfuegbareBausteine({ anwendungen: ['monitoring'], kennzahlen: k, anlagen: 1 });
    expect(ids).not.toContain('speicher');
    // Mit laufendem Speicher-Fahrplan erscheint er.
    const mit = verfuegbareBausteine({
      anwendungen: ['monitoring', 'speicher-fahrplan'],
      kennzahlen: k,
      anlagen: 1,
    });
    expect(mit).toContain('speicher');
  });

  it('lässt einen Baustein weg, dessen Anwendung läuft, der aber nichts zu zeigen hat', () => {
    const ids = verfuegbareBausteine({
      anwendungen: ['monitoring', 'speicher-fahrplan', 'lastspitzenkappung', 'lastmanagement'],
      kennzahlen: LEER,
      anlagen: 2,
    });
    expect(ids).toEqual(['flotten-status', 'anlagen']);
  });

  it('die Pflicht-Bausteine hängen an der Existenz der Flotte, nicht an einem Messwert', () => {
    expect(bausteinHatWert('flotten-status', LEER, 3)).toBe(true);
    expect(bausteinHatWert('anlagen', LEER, 3)).toBe(true);
    expect(bausteinHatWert('flotten-status', LEER, 0)).toBe(false);
  });

  it('ein Baustein, den dieses Portal nicht kennt, wird nicht erfunden', () => {
    expect(bausteinHatWert('neuer-baustein-von-morgen', LEER, 3)).toBe(false);
  });

  it('gibt die Bausteine in KATALOG-Reihenfolge zurück', () => {
    const k = portfolioKennzahlen(
      overview([anlage({ id: 'a', live: live(5), energyToday: { pvKwh: 1, loadKwh: 2, gridImportKwh: 1, gridExportKwh: 0 } })]),
      null,
      JETZT,
    );
    const ids = verfuegbareBausteine({ anwendungen: ['monitoring'], kennzahlen: k, anlagen: 1 });
    const katalog = PORTFOLIO_BAUSTEINE.map((b) => b.id);
    expect(ids).toEqual(katalog.filter((id) => ids.includes(id as never)));
  });
});

// ---------------------------------------------------------------------------
// Copy: die Fläche sagt, worüber sie geredet hat
// ---------------------------------------------------------------------------

describe('tabellenSpalten — die Kachel-Regel eine Ebene tiefer', () => {
  const mitErloes = (ids: string[]) =>
    ({
      sites: ids.map((id) => ({
        id,
        dailySaved: [{ day: berlinHeute(), savedEur: -0.47 }],
      })),
      totals: {},
    }) as unknown as Earnings;

  function berlinHeute(): string {
    return JETZT.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  }

  it('lässt die Ladestand-Spalte WEG, wenn keine Anlage sie füllen kann', () => {
    // Der §4.3-C-Fall: drei Filialen ohne Speicher trugen eine Spalte aus
    // lauter „—" - genau das Bild, gegen das diese Stufe gebaut ist.
    const o = overview([anlage({ id: 'a', live: live(13.7) }), anlage({ id: 'b', live: live(13.8) })]);
    expect(tabellenSpalten(o, mitErloes(['a', 'b']), JETZT)).toEqual({
      ladestand: false,
      erloes: true,
    });
  });

  it('behält sie, sobald EINE Anlage sie füllt - ein einzelnes „—" ist wahr', () => {
    // In einer gemischten Flotte sagt das „—" der speicherlosen Anlage die
    // Wahrheit über GENAU DIESE Anlage.
    const o = overview([
      anlage({ id: 'mit', storageCapacityKwh: 10, live: live(4, 62) }),
      anlage({ id: 'ohne', live: live(13.8) }),
    ]);
    expect(tabellenSpalten(o, null, JETZT).ladestand).toBe(true);
  });

  it('lässt die Erlös-Spalte weg, solange keine Anlage einen Tageswert meldet', () => {
    const o = overview([anlage({ id: 'a', live: live(13.7) })]);
    expect(tabellenSpalten(o, null, JETZT).erloes).toBe(false);
  });

  it('ohne Übersicht behauptet sie gar keine Spalte', () => {
    expect(tabellenSpalten(null, null, JETZT)).toEqual({ ladestand: false, erloes: false });
  });
});

describe('die Fussnoten benennen die Grundlage', () => {
  it('der Ladestand SAGT, dass er gewichtet ist - und über wie viele Anlagen', () => {
    const k = { ...LEER, ladestandPct: 42, ladestandAnlagen: 2 };
    expect(ladestandFussnote(k, 2)).toBe('nach Speichergröße gewichtet');
    expect(ladestandFussnote(k, 3)).toBe('nach Speichergröße gewichtet · 2 von 3 Anlagen');
  });

  it('ohne Ladestand gibt es keine Fussnote', () => {
    expect(ladestandFussnote(LEER, 3)).toBeNull();
  });

  it('„PV jetzt" nennt die Zahl der meldenden Anlagen nur, wenn sie kleiner ist', () => {
    expect(pvJetztFussnote({ ...LEER, pvJetztKw: 41.2, pvJetztAnlagen: 3 }, 3)).toBeNull();
    expect(pvJetztFussnote({ ...LEER, pvJetztKw: 41.2, pvJetztAnlagen: 1 }, 3)).toBe(
      '1 von 3 Anlagen melden gerade',
    );
  });

  it('der Ruhe-Satz kommt NUR, wenn gar keine Kennzahl da ist', () => {
    expect(ruheSatz(['flotten-status', 'anlagen'])).toContain('Sobald Ihre Anlagen Messwerte');
    // Eine einzige Kachel genügt: eine Flotte ohne Speicher braucht KEINE
    // Erklärung dafür, dass keine Speicher-Kachel dasteht - das wäre die
    // Zeile, die früher „—" hieß.
    expect(ruheSatz(['flotten-status', 'pv-jetzt', 'anlagen'])).toBeNull();
  });
});
