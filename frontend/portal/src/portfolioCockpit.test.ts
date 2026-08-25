import { describe, expect, it } from 'vitest';
import type { Earnings, Overview, OverviewSite } from './api';
import {
  CANONICAL_PORTFOLIO,
  PORTFOLIO_BAUSTEINE,
  anlagenZeilen,
  anwendungenVonAnlage,
  bausteinHatWert,
  bausteinOrt,
  flottenAussage,
  leistenZellen,
  portfolioAnwendungen,
  portfolioDichte,
  portfolioKennzahlen,
  pvJetztFussnote,
  ruheSatz,
  signiertesGeld,
  stammdatenZeile,
  tabellenSpalten,
  verfuegbareBausteine,
  vorteilLabel,
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
  it('gibt dem Betreiber die kompakte Zeile und jedem anderen die komfortable', () => {
    // Revision 2: die Betriebsart ändert nur noch die DICHTE derselben
    // Tabelle, nicht mehr Karten gegen Tabelle (Befund K4).
    expect(portfolioDichte('betreiber')).toBe('kompakt');
    expect(portfolioDichte('endkunde')).toBe('komfortabel');
  });

  it('ein UNBEKANNTER Rahmen fällt auf die komfortable - das ruhigere Bild', () => {
    expect(portfolioDichte(null)).toBe('komfortabel');
    expect(portfolioDichte(undefined)).toBe('komfortabel');
  });
});

// ---------------------------------------------------------------------------
// WO ein Baustein rendert (Revision 2)
// ---------------------------------------------------------------------------

describe('bausteinOrt', () => {
  it('der Ladestand ist NUR noch eine Spalte - der kumulierte ist raus', () => {
    // Captain 25.08.2026: „Der kumulierte Ladestand ist doch nicht
    // aussagekräftig oder?" Er steht seither ausschliesslich je Anlage.
    expect(bausteinOrt('speicher')).toEqual({ leiste: false, spalte: true });
  });

  it('eine Grösse kann BEIDES sein - einmal über die Flotte, einmal je Anlage', () => {
    expect(bausteinOrt('pv-jetzt')).toEqual({ leiste: true, spalte: true });
    expect(bausteinOrt('netz-heute')).toEqual({ leiste: true, spalte: true });
  });

  it('die zwei Pflicht-Bausteine sind weder Zelle noch reine Spalte', () => {
    // Der Flotten-Status IST der Kopfsatz plus die Zustands-Spalte, die
    // Anlagen-Tabelle ist die Fläche selbst.
    expect(bausteinOrt('flotten-status').leiste).toBe(false);
    expect(bausteinOrt('anlagen')).toEqual({ leiste: false, spalte: false });
  });

  it('ein Baustein, den dieses Portal nicht kennt, rendert nirgends', () => {
    expect(bausteinOrt('baustein-von-morgen')).toEqual({ leiste: false, spalte: false });
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

  it('KEIN Baustein bildet mehr einen Mittelwert über die Flotte', () => {
    // Revision 2 (Captain 25.08.2026): der gewichtete Flotten-Ladestand ist
    // ersatzlos entfallen. Ein wieder auftauchendes „gewichtet" wäre der
    // Hinweis darauf, dass jemand erneut einen Prozentsatz zusammenfasst.
    expect(PORTFOLIO_BAUSTEINE.filter((b) => b.aggregation === 'gewichtet')).toEqual([]);
    const speicher = PORTFOLIO_BAUSTEINE.find((b) => b.id === 'speicher');
    expect(speicher?.aggregation).toBe('je_anlage');
    expect(speicher?.aggregation_regel).toContain('JE ANLAGE');
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

  it('bildet über die Flotte KEINEN Ladestand mehr - nur noch einen Zähler', () => {
    // Revision 2 (Captain 25.08.2026): ein 10-kWh-Haus auf 100 % und ein
    // 120-kWh-Betrieb auf 20 % ergeben keinen aussagekräftigen Flotten-Wert -
    // weder das ungewichtete Mittel (60 %) noch das gewichtete (26,2 %). Der
    // Ladestand steht seither JE ANLAGE; die Kennzahl zählt nur, wie viele
    // Anlagen einen melden (das entscheidet über die SPALTE).
    const o = overview([
      anlage({ id: 'haus', storageCapacityKwh: 10, live: live(null, 100) }),
      anlage({ id: 'betrieb', storageCapacityKwh: 120, live: live(null, 20) }),
    ]);
    const k = portfolioKennzahlen(o, null, JETZT);
    expect(k.ladestandAnlagen).toBe(2);
    expect(k).not.toHaveProperty('ladestandPct');
  });

  it('zählt eine Anlage OHNE gepflegte Kapazität MIT - sie meldet ja einen Ladestand', () => {
    // Die Kapazität war das GEWICHT des alten Mittelwerts; ohne Mittelwert
    // entscheidet allein, ob die Anlage einen plausiblen Ladestand meldet.
    const o = overview([
      anlage({ id: 'mit', storageCapacityKwh: 10, live: live(null, 80) }),
      anlage({ id: 'ohne', storageCapacityKwh: null, live: live(null, 20) }),
    ]);
    expect(portfolioKennzahlen(o, null, JETZT).ladestandAnlagen).toBe(2);
  });

  it('ein unplausibler Ladestand zählt NICHT mit', () => {
    // Die Haus-Regel `sanitizeSoc` (der reale Prod-Befund „1.270 %"): ein Wert
    // außerhalb [0,100] ist kein Messwert und wird VERWORFEN.
    const o = overview([
      anlage({ id: 'gut', storageCapacityKwh: 10, live: live(null, 90) }),
      anlage({ id: 'kaputt', storageCapacityKwh: 10, live: live(null, 1270) }),
    ]);
    expect(portfolioKennzahlen(o, null, JETZT).ladestandAnlagen).toBe(1);
  });

  it('ein Ladestand von 0 zählt MIT - er ist ein ehrlicher BMS-Boden', () => {
    // Bewusst die Portal-Regel (inklusive 0), NICHT die der Box (exklusive 0):
    // eine persistierte 0 ist nach der Tatsache nicht mehr von einem echten
    // Boden zu unterscheiden.
    const o = overview([
      anlage({ id: 'voll', storageCapacityKwh: 10, live: live(null, 90) }),
      anlage({ id: 'leer', storageCapacityKwh: 10, live: live(null, 0) }),
    ]);
    expect(portfolioKennzahlen(o, null, JETZT).ladestandAnlagen).toBe(2);
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
    expect(LEER.ladestandAnlagen).toBe(0);
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
    expect(k.ladestandAnlagen).toBe(1);
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

describe('anlagenZeilen — Zustand zuerst, dann Name', () => {
  const alt = new Date(JETZT.getTime() - 3 * 60 * 60 * 1000);

  function flotte(): Overview {
    return overview([
      anlage({ id: 'zeta', name: 'Zeta', live: live(13.7, 62) }),
      anlage({
        id: 'stumm',
        name: 'Hof Lindenberg',
        lastSeenAt: alt.toISOString(),
        onlineCount: 0,
        worstStatus: 'stale',
        live: live(9, 40, alt),
      }),
      anlage({ id: 'alpha', name: 'Alpha', live: live(4.2, 88) }),
      anlage({ id: 'neu', name: 'Neubau', deviceCount: 0, onlineCount: 0, lastSeenAt: null, live: null }),
    ]);
  }

  it('stellt die Anlage mit Aufmerksamkeitsbedarf nach oben, dann alphabetisch', () => {
    const zeilen = anlagenZeilen({ overview: flotte(), earnings: null, dichte: 'kompakt', now: JETZT });
    expect(zeilen.map((z) => z.name)).toEqual(['Hof Lindenberg', 'Neubau', 'Alpha', 'Zeta']);
  });

  it('behauptet ohne FRISCHEN Messwert kein „jetzt"', () => {
    // Eine Box, die ihren Puffer nachspielt, ist online - ihre Werte sind es
    // nicht; die Tages-Summen bleiben davon unberührt (sie sind Historie).
    const zeilen = anlagenZeilen({ overview: flotte(), earnings: null, dichte: 'kompakt', now: JETZT });
    const stumm = zeilen.find((z) => z.id === 'stumm')!;
    expect(stumm.pvJetztKw).toBeNull();
    expect(stumm.netz).toBeNull();
    expect(stumm.zustand.wort).toBe('Meldet sich nicht');
    expect(stumm.zustand.alter).toContain('seit');
  });

  it('nennt bei einer gesunden Anlage KEIN Alter - es erklärt dort nichts', () => {
    const zeilen = anlagenZeilen({ overview: flotte(), earnings: null, dichte: 'kompakt', now: JETZT });
    expect(zeilen.find((z) => z.id === 'alpha')!.zustand.alter).toBeNull();
  });

  it('die Dichte ändert nur die UNTERZEILE, nie die Zahlen', () => {
    const k = anlagenZeilen({ overview: flotte(), earnings: null, dichte: 'kompakt', now: JETZT });
    const b = anlagenZeilen({ overview: flotte(), earnings: null, dichte: 'komfortabel', now: JETZT });
    expect(b.map((z) => z.pvJetztKw)).toEqual(k.map((z) => z.pvJetztKw));
    expect(b.map((z) => z.ladestandPct)).toEqual(k.map((z) => z.ladestandPct));
    expect(b[0].unterzeile).not.toBe(k[0].unterzeile);
  });

  it('trägt den Ladestand JE ANLAGE - dort, wo er etwas aussagt', () => {
    const zeilen = anlagenZeilen({ overview: flotte(), earnings: null, dichte: 'kompakt', now: JETZT });
    expect(zeilen.find((z) => z.id === 'alpha')!.ladestandPct).toBe(88);
    expect(zeilen.find((z) => z.id === 'neu')!.ladestandPct).toBeNull();
  });
});

describe('stammdatenZeile — nie die Basis-Chips, nie ein Komponenten-Zähler', () => {
  it('nennt die Veräußerungsform und die GESCHÄFTS-Anwendungen', () => {
    const zeile = stammdatenZeile(
      anlage({ id: 'a', plantKind: 'direktvermarktung', anwendungen: ['monitoring', 'speicher-fahrplan', 'marktvermarktung'] }),
    );
    expect(zeile).toBe('Direktvermarktung · Marktoptimierung');
  });

  it('lässt Basis-Anwendungen weg - sie standen in JEDER Zeile (Befund P6)', () => {
    const zeile = stammdatenZeile(anlage({ id: 'a', anwendungen: ['monitoring', 'speicher-fahrplan'] }));
    expect(zeile).toBe('Eigenverbrauch');
  });
});

describe('tabellenSpalten — die Kachel-Regel eine Ebene tiefer', () => {
  const ALLE = [...CANONICAL_PORTFOLIO] as string[];

  function zeilen(o: Overview, earnings: Earnings | null = null) {
    return anlagenZeilen({ overview: o, earnings, dichte: 'kompakt', now: JETZT });
  }

  it('lässt die Ladestand-Spalte WEG, wenn keine Anlage sie füllen kann', () => {
    // Der §4.3-C-Fall: drei Filialen ohne Speicher trugen eine Spalte aus
    // lauter „—" - genau das Bild, gegen das diese Stufe gebaut ist.
    const o = overview([anlage({ id: 'a', live: live(13.7) }), anlage({ id: 'b', live: live(13.8) })]);
    expect(tabellenSpalten(zeilen(o), ALLE)).not.toContain('speicher');
    expect(tabellenSpalten(zeilen(o), ALLE)).toContain('pv-jetzt');
  });

  it('behält sie, sobald EINE Anlage sie füllt - ein einzelnes „—" ist wahr', () => {
    const o = overview([
      anlage({ id: 'mit', storageCapacityKwh: 10, live: live(4, 62) }),
      anlage({ id: 'ohne', live: live(13.8) }),
    ]);
    expect(tabellenSpalten(zeilen(o), ALLE)).toContain('speicher');
  });

  it('lässt die Erlös-Spalte weg, solange keine Anlage einen Tageswert meldet', () => {
    const o = overview([anlage({ id: 'a', live: live(13.7) })]);
    expect(tabellenSpalten(zeilen(o), ALLE)).not.toContain('erloese');
  });

  it('lässt eine AUSGEBLENDETE Spalte weg, auch wenn sie Werte hätte', () => {
    // Die Anordnung des Kunden gewinnt: ein ausgeblendeter Baustein hat auch
    // keine Spalte.
    const o = overview([anlage({ id: 'a', live: live(13.7) })]);
    const ohnePv = ALLE.filter((id) => id !== 'pv-jetzt');
    expect(tabellenSpalten(zeilen(o), ohnePv)).not.toContain('pv-jetzt');
  });

  it('ohne Zeilen behauptet sie gar keine Spalte', () => {
    expect(tabellenSpalten([], ALLE)).toEqual([]);
  });

  it('hält die feste Lese-Reihenfolge Jetzt → Heute, egal wie angeordnet wurde', () => {
    // Die ANORDNUNG entscheidet, WELCHE Spalte es gibt - nicht, in welcher
    // Reihenfolge sie stehen: eine Tabelle, deren Spalten je Kunde anders
    // sortiert sind, liesse sich zwischen zwei Anlagen nicht mehr lesen.
    const o = overview([
      anlage({
        id: 'a',
        storageCapacityKwh: 10,
        live: live(13.7, 62),
        energyToday: { pvKwh: 5, loadKwh: 4, gridImportKwh: 1, gridExportKwh: 2 },
      }),
    ]);
    const gedreht = [...ALLE].reverse();
    expect(tabellenSpalten(zeilen(o), gedreht)).toEqual(
      tabellenSpalten(zeilen(o), ALLE),
    );
  });
});

// ---------------------------------------------------------------------------
// Der KOPF und die LEISTE
// ---------------------------------------------------------------------------

describe('flottenAussage — EINE Zeile, und sie zählt ANLAGEN', () => {
  const alt = new Date(JETZT.getTime() - 3 * 60 * 60 * 1000);

  it('sagt bei einer gesunden Flotte einen ruhigen Satz', () => {
    const sites = [anlage({ id: 'a' }), anlage({ id: 'b' })];
    expect(flottenAussage(sites, JETZT)).toEqual({ tone: 'ok', text: 'Alle 2 Anlagen online' });
  });

  it('NENNT die stumme Anlage beim Namen und trägt ihr Alter', () => {
    const sites = [
      anlage({ id: 'a' }),
      anlage({
        id: 'b',
        name: 'Hof Lindenberg',
        onlineCount: 0,
        worstStatus: 'stale',
        lastSeenAt: alt.toISOString(),
      }),
    ];
    const satz = flottenAussage(sites, JETZT);
    expect(satz.tone).toBe('warn');
    expect(satz.text).toContain('1 von 2 Anlagen online');
    expect(satz.text).toContain('Hof Lindenberg meldet sich');
  });

  it('zählt bei mehreren stummen Anlagen und nennt sie trotzdem', () => {
    const stumm = (id: string, name: string) =>
      anlage({ id, name, onlineCount: 0, worstStatus: 'stale', lastSeenAt: alt.toISOString() });
    const satz = flottenAussage([anlage({ id: 'a' }), stumm('b', 'Hof'), stumm('c', 'Werk')], JETZT);
    expect(satz.text).toContain('2 Anlagen melden sich nicht');
    expect(satz.text).toContain('Hof und Werk');
  });

  it('ist ohne Anlage ehrlich leer, nie „alles online"', () => {
    expect(flottenAussage([], JETZT)).toEqual({ tone: 'off', text: 'Noch keine Anlage angelegt.' });
  });
});

describe('leistenZellen — die Zellen folgen der ANORDNUNG', () => {
  const K = {
    ...LEER,
    erloesHeuteEur: 33.13,
    pvJetztKw: 41.2,
    pvJetztAnlagen: 3,
    erzeugungHeuteKwh: 312,
    verbrauchHeuteKwh: 128,
    bezugHeuteKwh: 14,
    einspeisungHeuteKwh: 190,
  };

  it('baut GENAU die Zellen, deren Baustein eine Leisten-Zelle IST', () => {
    const zellen = leistenZellen({
      order: [...CANONICAL_PORTFOLIO],
      kennzahlen: K,
      anlagen: 3,
      tonalitaet: 'eigenverbrauch',
    });
    // Der Ladestand ist KEINE Zelle mehr, die Anlagen-Tabelle war nie eine.
    expect(zellen.map((z) => z.id)).toEqual([
      'erloese',
      'pv-jetzt',
      'erzeugung-heute',
      'verbrauch-heute',
      'netz-heute',
    ]);
  });

  it('folgt der Reihenfolge des Kunden', () => {
    const zellen = leistenZellen({
      order: ['pv-jetzt', 'erloese', 'anlagen'],
      kennzahlen: K,
      anlagen: 3,
      tonalitaet: 'eigenverbrauch',
    });
    expect(zellen.map((z) => z.id)).toEqual(['pv-jetzt', 'erloese']);
  });

  it('trägt die Einheit als EIGENES Feld, nie im Wert', () => {
    const [erloes] = leistenZellen({
      order: ['erloese'],
      kennzahlen: K,
      anlagen: 3,
      tonalitaet: 'eigenverbrauch',
    });
    expect(erloes.wert).toBe('+33,13');
    expect(erloes.einheit).toBe('€');
  });

  it('nennt Bezug und Einspeisung GETRENNT, nie saldiert', () => {
    const [netz] = leistenZellen({
      order: ['netz-heute'],
      kennzahlen: K,
      anlagen: 3,
      tonalitaet: 'eigenverbrauch',
    });
    expect(netz.wert).toContain('14');
    expect(netz.wert).toContain('190');
    expect(netz.unterzeile).toBe('Bezug · Einspeisung');
  });

  it('lässt eine Zelle ohne Wert GANZ weg, nie ein „—"', () => {
    const zellen = leistenZellen({
      order: [...CANONICAL_PORTFOLIO],
      kennzahlen: LEER,
      anlagen: 3,
      tonalitaet: 'eigenverbrauch',
    });
    expect(zellen).toEqual([]);
  });

  it('das Vorteil-Wort folgt der TONALITÄT, nicht der Betriebsart', () => {
    expect(vorteilLabel('direktvermarktung')).toBe('Mehrerlös heute');
    expect(vorteilLabel('eigenverbrauch')).toBe('Vorteil heute');
    expect(vorteilLabel('gemischt')).toBe('Vorteil heute');
  });

  it('eine echte Null trägt kein Vorzeichen', () => {
    expect(signiertesGeld(0)).toBe('0,00');
    expect(signiertesGeld(-0.001)).toBe('0,00');
    expect(signiertesGeld(-0.8)).toBe('-0,80');
  });
});

describe('die Fussnoten benennen die Grundlage', () => {
  it('„PV jetzt" nennt die Zahl der meldenden Anlagen nur, wenn sie kleiner ist', () => {
    expect(pvJetztFussnote({ ...LEER, pvJetztKw: 41.2, pvJetztAnlagen: 3 }, 3)).toBeNull();
    expect(pvJetztFussnote({ ...LEER, pvJetztKw: 41.2, pvJetztAnlagen: 1 }, 3)).toBe(
      '1 von 3 Anlagen melden gerade',
    );
  });

  it('der Ruhe-Satz kommt NUR, wenn gar keine Kennzahl da ist', () => {
    expect(ruheSatz(['flotten-status', 'anlagen'])).toContain('Sobald Ihre Anlagen Messwerte');
    // Eine einzige Zelle genügt: eine Flotte ohne Speicher braucht KEINE
    // Erklärung dafür, dass keine Speicher-Zelle dasteht - das wäre die
    // Zeile, die früher „—" hieß.
    expect(ruheSatz(['flotten-status', 'pv-jetzt', 'anlagen'])).toBeNull();
  });
});
