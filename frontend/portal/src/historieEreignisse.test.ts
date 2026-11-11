import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { History, HistoryBucket, HistoryEvent, HistoryRange, HistoryVorgaben } from './api';
import {
  ART_ORDER,
  EREIGNIS_ARTEN,
  KANAL_TEXT,
  VORGABEN_ARTEN,
  energieText,
  euroText,
  rohwertText,
  vorgabeFakten,
  vorgabenTeile,
  SPUR_HINWEIS_KURZ,
  bandSpanne,
  centText,
  dauerText,
  drilldownHinweis,
  ereignisArten,
  ereignisChronik,
  ereignisSpur,
  ereignisZahl,
  ereignisZeit,
  spurHinweis,
  stundenZellen,
  tagesSprung,
  zellenSpanne,
  type EreignisZelle,
} from './historieEreignisse';
import { vorgabeDetailBeispiel, vorgabenVerlaufBeispiel } from './test/erzeugerFixtures';

/**
 * Die Ereignis-Spur (F6) und der Tagesdrilldown (F5) als reine Einheiten -
 * kein React, kein Netz.
 */

function bucket(start: string): HistoryBucket {
  return {
    start,
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
  };
}

function hist(
  starts: string[],
  events: HistoryEvent[] | undefined,
  range: HistoryRange = 'month',
): History {
  return {
    range,
    from: '',
    to: '',
    bucketMinutes: range === 'day' ? 15 : range === 'week' ? 60 : 1440,
    buckets: starts.map(bucket),
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
    ...(events ? { events } : {}),
  };
}

/** Ein lokaler Zeitpunkt - die Chips formatieren in der Zeitzone des Kunden. */
function local(y: number, m: number, d: number, h = 0, min = 0): string {
  return new Date(y, m - 1, d, h, min).toISOString();
}

const ereignis = (o: Partial<HistoryEvent> = {}): HistoryEvent => ({
  type: 'negativpreis',
  start: local(2026, 7, 15, 11),
  end: local(2026, 7, 15, 15),
  text: 'Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh',
  ...o,
});

describe('ereignisSpur — ohne Spur wird keine Ruhe behauptet', () => {
  it('liefert null, wenn das Backend gar keine Ereignisse schickt', () => {
    // Ein älteres Backend: „keine besonderen Ereignisse" wäre eine Aussage über
    // eine Prüfung, die nie stattgefunden hat.
    expect(ereignisSpur(hist([local(2026, 7, 15)], undefined))).toBeNull();
  });

  it('sagt bei einer leeren Spur ausdrücklich, dass nichts Auffälliges war', () => {
    const spur = ereignisSpur(hist([local(2026, 7, 15)], []))!;
    expect(spur.chips).toEqual([]);
    // Ein Haken und zwei Wörter statt eines Satzes (Konzept k1).
    expect(spur.leerText).toBe('Nichts Auffälliges');
    expect(spur.arten).toEqual([]);
  });

  it('überspringt eine unbekannte Art, statt sie zu raten', () => {
    const spur = ereignisSpur(
      hist(
        [local(2026, 7, 15)],
        [
          ereignis(),
          { ...ereignis(), type: 'wolkenbruch' as HistoryEvent['type'], text: 'irgendwas' },
        ],
      ),
    )!;
    expect(spur.chips.map((c) => c.art)).toEqual(['negativpreis']);
  });
});

describe('ereignisSpur — Chips', () => {
  it('setzt die Zeit zeitraumgerecht davor und lässt den Servertext unangetastet', () => {
    const monat = ereignisSpur(hist([local(2026, 7, 15)], [ereignis()]))!;
    expect(monat.chips[0].zeit).toBe('15.07.');
    expect(monat.chips[0].text).toBe('Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh');
    expect(monat.chips[0].titel).toBe(
      '15.07. · Negative Börsenpreise: 4 Std, bis -5,3 ct/kWh',
    );

    const tag = ereignisSpur(
      hist([local(2026, 7, 15, 11)], [ereignis()], 'day'),
    )!;
    expect(tag.chips[0].zeit).toBe('11:00–15:00 Uhr');
  });

  it('führt die Legende in kanonischer Reihenfolge und nur mit vorkommenden Arten', () => {
    const spur = ereignisSpur(
      hist(
        [local(2026, 7, 15), local(2026, 7, 16)],
        [
          ereignis({ type: 'netzladen', text: 'Speicher aus dem Netz geladen: 1 Std (ca. 3 kWh)' }),
          ereignis({ type: 'abregelung', text: 'PV-Abregelung eingeplant: 2 Std (24,0 kWh)' }),
        ],
      ),
    )!;
    expect(spur.arten.map((a) => a.art)).toEqual(['abregelung', 'netzladen']);
    expect(ART_ORDER.indexOf('abregelung')).toBeLessThan(ART_ORDER.indexOf('netzladen'));
  });

  it('§ 51a: „keine-verguetung" ist eine eigene Art, getrennt von „negativpreis" (Scheibe S4)', () => {
    const spur = ereignisSpur(
      hist(
        [local(2026, 7, 15)],
        [
          ereignis({ type: 'keine-verguetung', text: 'Keine Vergütung (§ 51a EEG): 4 Std 45 Min', value: null, unit: null }),
        ],
      ),
    )!;
    expect(spur.chips.map((c) => c.art)).toEqual(['keine-verguetung']);
    expect(spur.arten.map((a) => a.art)).toEqual(['keine-verguetung']);
    expect(EREIGNIS_ARTEN['keine-verguetung'].label).toBe('Keine Vergütung');
    expect(EREIGNIS_ARTEN['keine-verguetung'].farbe).toBe('markt');
    // Beide Arten können am selben Tag nebeneinander stehen - nie dieselbe Art.
    const beide = ereignisSpur(
      hist([local(2026, 7, 15)], [ereignis(), ereignis({ type: 'keine-verguetung', value: null, unit: null })]),
    )!;
    expect(beide.chips.map((c) => c.art)).toEqual(['negativpreis', 'keine-verguetung']);
  });
});

describe('ereignisZeit — das exklusive Ende zählt keinen Tag zu viel', () => {
  it('nennt einen Tag, wenn das Ereignis um Mitternacht des Folgetags endet', () => {
    const start = new Date(2026, 6, 15, 22);
    const ende = new Date(2026, 6, 16, 0);
    expect(ereignisZeit(start, ende, 'month')).toBe('15.07.');
  });

  it('nennt beide Tage, wenn es wirklich über den Tag hinausreicht', () => {
    const start = new Date(2026, 6, 15, 22);
    const ende = new Date(2026, 6, 16, 3);
    expect(ereignisZeit(start, ende, 'month')).toBe('15.07.–16.07.');
  });

  it('nennt am Tag eine Uhrzeit, und bei einer einzigen Viertelstunde nur eine', () => {
    const start = new Date(2026, 6, 15, 11, 0);
    expect(ereignisZeit(start, new Date(2026, 6, 15, 11, 15), 'day')).toBe('11:00–11:15 Uhr');
    expect(ereignisZeit(start, start, 'day')).toBe('11:00 Uhr');
  });
});

describe('bandSpanne — das Band ist die Ortsangabe, nie null Pixel breit', () => {
  const starts = [0, 100, 200, 300, 400];

  it('umfasst genau die überdeckten Buckets', () => {
    expect(bandSpanne(starts, 100, 350)).toEqual([1, 3]);
  });

  it('verbreitert ein Ereignis in EINEM Bucket auf mindestens eine Bucket-Breite', () => {
    // Sonst wäre die Fläche auf der Kategorie-Achse null Pixel breit.
    expect(bandSpanne(starts, 100, 150)).toEqual([1, 2]);
  });

  it('weicht am rechten Rand nach links aus, statt zu verschwinden', () => {
    expect(bandSpanne(starts, 400, 450)).toEqual([3, 4]);
  });

  it('markiert eine Datenlücke an der Nahtstelle zwischen den Nachbarn', () => {
    // Die fehlende Zeit hat auf einer Kategorie-Achse gar keine Kategorie.
    expect(bandSpanne([0, 100, 400, 500], 150, 400)).toEqual([1, 2]);
  });

  it('liefert ohne einen einzigen Bucket gar keine Spanne', () => {
    expect(bandSpanne([], 0, 100)).toBeNull();
  });
});

describe('F5 — der Tagesdrilldown', () => {
  it('führt aus Woche/Monat/Jahr in den Tag des Balkens', () => {
    expect(tagesSprung(local(2026, 7, 15, 0), 'month')).toBe('2026-07-15');
    expect(tagesSprung(local(2026, 7, 15, 6), 'week')).toBe('2026-07-15');
    expect(tagesSprung(local(2026, 7, 15, 0), 'year')).toBe('2026-07-15');
  });

  it('bietet im Tages-Zeitraum keinen Sprung an - er ist schon die feinste Auflösung', () => {
    expect(tagesSprung(local(2026, 7, 15, 11), 'day')).toBeNull();
    expect(drilldownHinweis('day')).toBeNull();
    expect(drilldownHinweis('month')).toBe('Einen Balken antippen öffnet diesen Tag.');
  });

  it('springt nicht auf ein erfundenes Datum', () => {
    expect(tagesSprung('unbrauchbar', 'month')).toBeNull();
  });

  it('trägt den Sprung auch am Chip, aber nicht am Tag', () => {
    const monat = ereignisSpur(hist([local(2026, 7, 15)], [ereignis()]))!;
    expect(monat.chips[0].sprungAt).toBe('2026-07-15');
    const tag = ereignisSpur(hist([local(2026, 7, 15, 11)], [ereignis()], 'day'))!;
    expect(tag.chips[0].sprungAt).toBeNull();
  });
});

describe('spurHinweis — was der Zeitraum nicht auswertet, sagt die Spur', () => {
  it('schweigt, wo die Netzgrenze ausgewertet wird', () => {
    expect(spurHinweis('day')).toBeNull();
    expect(spurHinweis('week')).toBeNull();
  });

  it('spricht es für Monat und Jahr aus', () => {
    // Der Zwilling der Server-Regel Ereignisse.evaluatesGridLimit: ohne diesen
    // Satz läse sich das Fehlen eines Markers als „keine Netzgrenze".
    expect(spurHinweis('month')).toBe(
      'Die Netzgrenze (§ 14a) wird für Tag und Woche ausgewertet, nicht für diesen Zeitraum.',
    );
    expect(spurHinweis('year')).toBe(spurHinweis('month'));
  });

  it('reist als Teil der Spur mit', () => {
    expect(ereignisSpur(hist([local(2026, 7, 15)], []))!.hinweis).toBe(spurHinweis('month'));
  });
});

describe('Abendverkauf — die Erklärung der Nacht ist NEUTRAL', () => {
  const abendverkauf = ereignis({
    type: 'abendverkauf',
    start: local(2026, 9, 4, 19, 45),
    end: local(2026, 9, 4, 20, 45),
    text:
      'Abendverkauf 19:45 bis 20:45 · 13,7 kWh zu 13,6 bis 13,9 ct (1,88 €).' +
      ' Prognose für die Nacht 52 kWh, gemessen 65 kWh (+25 %).' +
      ' Speicher leer um 02:45; Netzbezug bis 07:00 13,6 kWh (3,40 €).',
  });

  it('trägt das Label „Abendverkauf" und einen neutralen Ton — nie grün, nie rot', () => {
    const info = EREIGNIS_ARTEN.abendverkauf;
    expect(info.label).toBe('Abendverkauf');
    // Eine Entscheidung am Markt: das Blau der Preislinie. Es gibt keinen
    // Ertrags- oder Kosten-Bereich — die vier Bereiche bewerten nicht.
    expect(info.farbe).toBe('markt');
  });

  it('wird als Chip gezeigt, mit Zeit davor und dem Servertext unangetastet', () => {
    const spur = ereignisSpur(
      hist([local(2026, 9, 4, 19, 45)], [abendverkauf], 'day'),
    )!;
    expect(spur.chips.map((c) => c.art)).toEqual(['abendverkauf']);
    expect(spur.chips[0].zeit).toBe('19:45–20:45 Uhr');
    expect(spur.chips[0].text).toBe(abendverkauf.text);
    expect(spur.arten.map((a) => a.art)).toEqual(['abendverkauf']);
  });

  it('steht in der kanonischen Reihenfolge zwischen Anlage und Lücken', () => {
    expect(ART_ORDER).toContain('abendverkauf');
    expect(ART_ORDER.indexOf('abendverkauf')).toBeGreaterThan(ART_ORDER.indexOf('netzladen'));
    expect(ART_ORDER.indexOf('abendverkauf')).toBeLessThan(ART_ORDER.indexOf('datenluecke'));
  });
});

// ===========================================================================
// Konzept k1: ein Wort, eine Zahl; Bereichsfarben; Chronik und „Nach Art"
// ===========================================================================

describe('Bereiche — vier Farben statt sieben, das Symbol unterscheidet', () => {
  it('ordnet jede Art genau einem der vier Bereiche zu', () => {
    expect(Object.fromEntries(ART_ORDER.map((a) => [a, EREIGNIS_ARTEN[a].farbe]))).toEqual({
      negativpreis: 'markt',
      'keine-verguetung': 'markt',
      abregelung: 'pv',
      netzgrenze: 'netz',
      netzladen: 'netz',
      abendverkauf: 'markt',
      netzbetreiber: 'netz',
      direktvermarkter: 'markt',
      'nicht-bereit': 'daten',
      datenluecke: 'daten',
      'geraet-still': 'daten',
    });
  });
});

describe('Chips — die Felder des Servers, und ohne sie ein ehrliches Bild', () => {
  it('übernimmt Zahl, Einheit, Plan, Dauer, Bündel und Fakten', () => {
    const spur = ereignisSpur(
      hist([local(2026, 7, 15)], [
        ereignis({ value: -5.3, unit: 'ct/kWh', planned: false, minutes: 240, count: 2, days: 1, facts: [] }),
      ]),
    )!;
    const c = spur.chips[0];
    expect([c.wert, c.einheit, c.geplant, c.minuten, c.anzahl, c.tage]).toEqual([-5.3, 'ct/kWh', false, 240, 2, 1]);
  });

  it('rechnet bei einem älteren Backend die Dauer aus Beginn und Ende und behauptet keine Zahl', () => {
    const c = ereignisSpur(hist([local(2026, 7, 15)], [ereignis({ type: 'abregelung' })]))!.chips[0];
    expect(c.wert).toBeNull();
    expect(c.minuten).toBe(240);
    expect(c.anzahl).toBe(1);
    // Die Art weiß, dass eine Abregelung geplant ist, auch ohne das Feld.
    expect(c.geplant).toBe(true);
  });
});

describe('Die eine Zahl — Format', () => {
  it('schreibt Preise mit echtem Minus und unter 0,1 ct mit zwei Stellen', () => {
    expect(centText(-5.3)).toBe('−5,3 ct');
    // Der Fall aus dem Screenshot: „-0,0 ct/kWh" sagte nichts.
    expect(centText(-0.04)).toBe('−0,04 ct');
    expect(centText(-0.001)).toBe('unter 0 ct');
  });

  it('wählt je Art die Zahl, und wo es keine gibt, die Dauer', () => {
    const t = new Date(2026, 9, 20, 14, 15);
    expect(ereignisZahl('negativpreis', -0.04, 15, t, 'month')).toBe('bis −0,04 ct');
    expect(ereignisZahl('negativpreis', -0.001, 15, t, 'month')).toBe('unter 0 ct');
    expect(ereignisZahl('netzladen', 2.2, 60, t, 'month')).toBe('2,2 kWh');
    expect(ereignisZahl('abregelung', 214.6, 600, t, 'year')).toBe('215 kWh');
    expect(ereignisZahl('netzgrenze', 4.2, 90, t, 'day')).toBe('≤ 4,2 kW');
    expect(ereignisZahl('datenluecke', null, 135, t, 'month')).toBe('2 Std 15 Min');
    expect(ereignisZahl('keine-verguetung', null, 285, t, 'day')).toBe('4 Std 45 Min');
    expect(ereignisZahl('netzladen', null, 45, t, 'month')).toBe('45 Min');
    expect(ereignisZahl('geraet-still', null, 600, t, 'day')).toBe('seit 14:15');
    expect(ereignisZahl('geraet-still', null, 600, t, 'year')).toBe('seit 20.10.');
  });

  it('nennt lange Dauern in Tagen, nie „0 Std"', () => {
    expect(dauerText(45)).toBe('45 Min');
    expect(dauerText(120)).toBe('2 Std');
    expect(dauerText(1440 + 240)).toBe('1 Tag 4 Std');
    expect(dauerText(3 * 1440)).toBe('3 Tage');
  });

  it('hat für den §-14a-Hinweis eine Kurzform ohne Zeilenbruch im Paragrafen', () => {
    expect(SPUR_HINWEIS_KURZ).toBe('§ 14a: nur Tag/Woche');
  });
});

describe('ereignisChronik — ein Tag, eine Zeile je Art', () => {
  it('bündelt im Monat zwei Fenster derselben Art an einem Tag (älteres Backend)', () => {
    // Der Fall aus dem Screenshot: zweimal „02.10. Netzladen 15 Min".
    const spur = ereignisSpur(
      hist([local(2026, 10, 2)], [
        ereignis({ type: 'netzladen', start: local(2026, 10, 2, 3, 15), end: local(2026, 10, 2, 3, 30), value: 0.6, unit: 'kWh' }),
        ereignis({ type: 'netzladen', start: local(2026, 10, 2, 4, 45), end: local(2026, 10, 2, 5, 0), value: 0.7, unit: 'kWh' }),
        ereignis({ type: 'datenluecke', start: local(2026, 10, 7, 10, 15), end: local(2026, 10, 7, 11, 15), value: null }),
      ]),
    )!;

    const gruppen = ereignisChronik(spur, 'month');

    expect(gruppen.map((g) => [g.gross, g.klein, g.label])).toEqual([
      ['02', 'Fr', 'Freitag, 02.10.'],
      ['07', 'Mi', 'Mittwoch, 07.10.'],
    ]);
    expect(gruppen[0].zeilen).toHaveLength(1);
    expect(gruppen[0].zeilen[0]).toMatchObject({ art: 'netzladen', meta: '2× · 30 Min', zahl: '1,3 kWh' });
    expect(gruppen[0].sprung).toEqual({ range: 'day', at: '2026-10-02' });
    // Eine einzelne Lücke nennt ihre Uhrzeit, die Zahl ist die Dauer.
    expect(gruppen[1].zeilen[0]).toMatchObject({ art: 'datenluecke', meta: '10:15–11:15', zahl: '1 Std' });
  });

  it('nimmt ein Bündel des Servers wie es ist und nennt seine Anzahl', () => {
    const spur = ereignisSpur(
      hist([local(2026, 7, 15)], [
        ereignis({
          type: 'netzladen', start: local(2026, 7, 15, 2, 15), end: local(2026, 7, 15, 4, 30),
          value: 2.2, unit: 'kWh', minutes: 60, count: 2, days: 1,
        }),
      ]),
    )!;
    expect(ereignisChronik(spur, 'month')[0].zeilen[0]).toMatchObject({ meta: '2× · 1 Std', zahl: '2,2 kWh' });
  });

  it('stellt zwei Arten am selben Tag unter EINEN Datumsblock, in kanonischer Reihenfolge', () => {
    const spur = ereignisSpur(
      hist([local(2026, 7, 6)], [
        ereignis({ type: 'abregelung', start: local(2026, 7, 6, 11, 30), end: local(2026, 7, 6, 13, 30), value: 4.8, unit: 'kWh', planned: true }),
        ereignis({ start: local(2026, 7, 6, 10, 30), end: local(2026, 7, 6, 14, 30), value: -5.3, unit: 'ct/kWh' }),
      ]),
    )!;
    const [g] = ereignisChronik(spur, 'month');
    expect(g.zeilen.map((z) => [z.art, z.zahl, z.geplant])).toEqual([
      ['negativpreis', 'bis −5,3 ct', false],
      ['abregelung', '4,8 kWh', true],
    ]);
  });

  it('gruppiert im Jahr je Monat, zählt Tage und öffnet den Monat', () => {
    const spur = ereignisSpur(
      hist([local(2026, 5, 1)], [
        ereignis({ start: local(2026, 5, 3, 11), end: local(2026, 5, 28, 15), value: -12.1, unit: 'ct/kWh', minutes: 1380, count: 11, days: 9 }),
      ], 'year'),
    )!;
    const [g] = ereignisChronik(spur, 'year');
    expect([g.gross, g.klein, g.label]).toEqual(['Mai', '', 'Mai 2026']);
    expect(g.sprung).toEqual({ range: 'month', at: '2026-05-01' });
    expect(g.zeilen[0]).toMatchObject({ meta: '9 Tage', zahl: 'bis −12,1 ct' });
  });

  it('zeigt am Tag jedes Ereignis mit Uhrzeit, ohne Sprung, mit den Fakten des Abendverkaufs', () => {
    const fakten = [{ label: 'Speicher leer', value: '02:45' }];
    const spur = ereignisSpur(
      hist([local(2026, 9, 4, 19, 45)], [
        ereignis({ type: 'abendverkauf', start: local(2026, 9, 4, 19, 45), end: local(2026, 9, 4, 21), value: 4.2, unit: 'kWh', planned: true, facts: fakten }),
      ], 'day'),
    )!;
    const [g] = ereignisChronik(spur, 'day');
    expect([g.gross, g.klein, g.sprung]).toEqual(['19:45', 'bis 21:00', null]);
    expect(g.zeilen[0]).toMatchObject({ meta: '1 Std 15 Min', zahl: '4,2 kWh', geplant: true, fakten });
  });
});

describe('zellenSpanne — wo ein Ereignis unter der Achse liegt', () => {
  const tage: EreignisZelle[] = Array.from({ length: 5 }, (_, i) => ({
    start: new Date(2026, 6, 1 + i),
    ende: new Date(2026, 6, 2 + i),
  }));

  it('trifft genau die berührten Zellen; das exklusive Ende zählt keine zu viel', () => {
    expect(zellenSpanne(tage, new Date(2026, 6, 2, 10), new Date(2026, 6, 2, 12))).toEqual([1, 1]);
    expect(zellenSpanne(tage, new Date(2026, 6, 2, 22), new Date(2026, 6, 4))).toEqual([1, 2]);
  });

  it('liefert außerhalb nichts', () => {
    expect(zellenSpanne(tage, new Date(2026, 7, 1), new Date(2026, 7, 2))).toBeNull();
  });
});

describe('ereignisArten — „Nach Art"', () => {
  const tage: EreignisZelle[] = Array.from({ length: 31 }, (_, i) => ({
    start: new Date(2026, 9, 1 + i),
    ende: new Date(2026, 9, 2 + i),
    zukunft: i >= 20,
  }));

  it('zählt Tage, nennt die eine Zahl über den Zeitraum und markiert den Streifen', () => {
    const spur = ereignisSpur(
      hist([local(2026, 10, 1)], [
        ereignis({ start: local(2026, 10, 4, 12), end: local(2026, 10, 4, 13), value: -2.4, unit: 'ct/kWh' }),
        ereignis({ start: local(2026, 10, 10, 13), end: local(2026, 10, 10, 13, 15), value: -0.04, unit: 'ct/kWh' }),
        ereignis({ type: 'datenluecke', start: local(2026, 10, 7, 10, 15), end: local(2026, 10, 7, 11, 15), value: null }),
      ]),
    )!;

    const arten = ereignisArten(spur, 'month', tage);

    expect(arten.map((a) => [a.art, a.n, a.anzahl, a.zahl])).toEqual([
      ['negativpreis', 2, '2 Tage', 'bis −2,4 ct'],
      ['datenluecke', 1, '1 Tag', '1 Std'],
    ]);
    const streifen = arten[0].streifen;
    expect(streifen.filter((z) => z.an).length).toBe(2);
    expect(streifen[3].an && streifen[9].an).toBe(true);
    // Die Zukunft ist hohl, nie „kein Ereignis".
    expect(streifen[25]).toEqual({ an: false, zukunft: true });
  });

  it('zählt am Tag die Ereignisse und streift die Stunden', () => {
    const now = new Date(2026, 6, 27, 12);
    const stunden = stundenZellen(new Date(2026, 6, 26, 12), now);
    expect(stunden).toHaveLength(24);
    const spur = ereignisSpur(
      hist([local(2026, 7, 26)], [
        ereignis({ start: local(2026, 7, 26, 10, 15), end: local(2026, 7, 26, 15, 45), value: -8.7, unit: 'ct/kWh' }),
      ], 'day'),
    )!;
    const [a] = ereignisArten(spur, 'day', stunden);
    expect(a.anzahl).toBe('1×');
    expect(a.streifen.map((z, h) => (z.an ? h : -1)).filter((h) => h >= 0)).toEqual([10, 11, 12, 13, 14, 15]);
  });
});

// ===========================================================================
// UEMS EZ-9: Vorgaben einer Erzeugeranlage als Ereignisse (EW-12 A)
// ===========================================================================

describe('Vorgaben — Netzbetreiber, Direktvermarkter, nicht bereit (EZ-9)', () => {
  const NOW = new Date(2026, 9, 21, 15, 44);
  const sp = (t: string | null | undefined) => (t ?? '').replace(/[\u00a0\u202f]/g, ' ');
  const mitVorgaben = (fall: 'buettner' | 'gore', range: HistoryRange): History => ({
    ...hist([local(2026, 10, 21)], undefined, range),
    ...vorgabenVerlaufBeispiel(fall, range, NOW),
  });

  it('kennt jede Ereignisart des Vertrags — eine unbekannte verwürfe der Client still', () => {
    const vertrag = readFileSync(resolve(process.cwd(), '../../docs/contracts/openapi.yaml'), 'utf8');
    const zeile = vertrag.split('\n').find((z) => z.includes('enum: [negativpreis, keine-verguetung, abregelung'));
    const arten = /\[(.*)\]/.exec(zeile ?? '')![1].split(',').map((x) => x.trim());
    expect(arten.filter((a) => !(a in EREIGNIS_ARTEN))).toEqual([]);
    expect(arten.slice(-VORGABEN_ARTEN.length)).toEqual([...VORGABEN_ARTEN]);
    // Die Kanäle der Vorgaben haben ein Wort (Zwilling von VorgabenCsv.KANAL).
    const kanal = vertrag.slice(vertrag.indexOf('    ErzeugerVorgabe:')).split('\n').find((z) => z.includes('enum: [keiner'));
    const kanaele = /\[(.*)\]/.exec(kanal ?? '')![1].split(',').map((x) => x.trim()).filter((x) => x !== 'null');
    expect(kanaele.filter((k) => !KANAL_TEXT[k])).toEqual([]);
  });

  it('Tag: je Vorgabe eine Zeile — Urheber und Vorgabe, ob die Anlage folgte, die geschätzte Energie', () => {
    const spur = ereignisSpur(mitVorgaben('buettner', 'day'))!;
    const gruppen = ereignisChronik(spur, 'day');
    expect(gruppen.map((g) => [g.gross, sp(g.klein), ...g.zeilen.map((z) => [sp(z.titel), sp(z.meta), sp(z.zahl), z.zahlUnter ?? null])])).toEqual([
      ['05:44', 'bis 05:58', ['Netzbetreiber', '1 weiterer Wechsel während einer Datenlücke', '14 Min', null]],
      ['07:24', 'bis 08:09', ['nicht bereit · Motor 2', 'Gasspeicher leer', '45 Min', null]],
      ['10:04', 'bis 11:19', ['Netzbetreiber · 30 %', '1 Std 15 Min · folgt ✓', '≈ 51,0 kWh', null]],
      ['13:05', 'läuft', ['Direktvermarkter · Abruf 80,0 kW', '2 Std 38 Min · nicht bindend', '0 kWh', null]],
      ['14:32', 'läuft', ['Netzbetreiber · 60 %', '1 Std 11 Min · folgt ✓', '≈ 25,0 kWh', null]],
    ]);
    expect(gruppen[4].label).toBe('ab 14:32 Uhr, läuft');
    expect(gruppen[4].zeilen[0].vorgabe?.id).toBe('vg-bue-2');
    // Gore (PV): die Euro-Schätzung steht unter der Zahl, nur weil EZ-7 sie liefert.
    const gore = ereignisChronik(ereignisSpur(mitVorgaben('gore', 'day'))!, 'day');
    expect(sp(gore[0].zeilen[0].zahlUnter)).toBe('≈ 1,47 €');
  });

  it('eine Vorgabe von früher nennt ihren wirklichen Beginn, unvollständig steht dabei', () => {
    const tag = local(2026, 10, 21);
    const spur = ereignisSpur({
      ...hist([tag], [{
        type: 'netzbetreiber', start: tag, end: local(2026, 10, 21, 15, 43), text: 'Netzbetreiber begrenzt auf 70 % (nicht bindend)',
        value: 0, unit: 'kWh', minutes: 943, count: 1, days: 1, facts: [],
        vorgabe: { id: 'fest', urheber: 'netzbetreiber', art: 'p_begrenzung', teNr: null, einheitName: null, beginn: local(2025, 1, 1),
          beginnGenau: true, ende: null, laeuft: true, vorgabeProzent: 70, vorgabeW: null, bindung: 'nicht_bindend', wertEur: null,
          unvollstaendig: 1, luecken: 0, weitereWechsel: null, gruende: [] },
      }], 'day'),
    })!;
    const z = ereignisChronik(spur, 'day')[0].zeilen[0];
    expect([sp(z.titel), sp(z.meta)]).toEqual(['Netzbetreiber · 70 %', 'seit 01.01.2025 00:00 · nicht bindend · unvollständig']);
  });

  it('Monat: je Tag eine Zeile je Urheber, Anzahl und Dauer vom Server', () => {
    const spur = ereignisSpur(mitVorgaben('buettner', 'month'))!;
    const gruppen = ereignisChronik(spur, 'month');
    const zeilen = (tag: string) => gruppen.find((g) => g.gross === tag)!.zeilen.map((z) => [sp(z.titel), sp(z.meta), sp(z.zahl)]);
    expect(zeilen('01')).toEqual([['Netzbetreiber', '10:00–11:30', '≈ 40,0 kWh']]);
    expect(zeilen('02')).toEqual([['Direktvermarkter', '2× · 4 Std 5 Min', '0 kWh']]);
    expect(zeilen('08')).toEqual([
      ['Direktvermarkter', '2× · 4 Std 5 Min', '0 kWh'],
      ['nicht bereit', '06:00–06:45 · 1 unvollständig', '45 Min'],
    ]);
  });

  it('„Nach Art“ zählt aus der Zählung des Servers — einmal je Vorgabe, mit Stopps und Datenlücken', () => {
    const spur = ereignisSpur(mitVorgaben('buettner', 'day'))!;
    const arten = ereignisArten(spur, 'day', stundenZellen(new Date(2026, 9, 21, 12), NOW));
    expect(arten.map((a) => [a.art, a.n, a.anzahl, sp(a.zahl), sp(a.zusatz)])).toEqual([
      ['netzbetreiber', 2, '2×', '2 Std 26 Min · ≈ 76,0 kWh nicht erzeugt', '1 weiterer Wechsel während einer Datenlücke'],
      ['direktvermarkter', 1, '1×', '2 Std 38 Min', ''],
      ['nicht-bereit', 1, '1×', '45 Min', ''],
    ]);
    const monat = ereignisArten(ereignisSpur(mitVorgaben('buettner', 'month'))!, 'month', []);
    expect(sp(monat.find((a) => a.art === 'direktvermarkter')!.zusatz)).toBe('4 Stopps');
    expect(sp(monat.find((a) => a.art === 'netzbetreiber')!.zusatz)).toBe('1 Abschaltung');
  });

  it('je Einheit aufklappbar, im Jahr je Monat', () => {
    const tag = vorgabenTeile(ereignisSpur(mitVorgaben('buettner', 'day'))!);
    expect(tag.einheiten.map((t) => [t.label, t.zeilen.map((z) => sp(z.text))])).toEqual([
      ['Motor 1', ['Direktvermarkter 1× · 2 Std 38 Min']],
      ['Motor 2', ['Direktvermarkter 1× · 1 Std 53 Min', 'nicht bereit 1× · 45 Min']],
    ]);
    expect(tag.monate).toEqual([]);
    const z = (periode: string, type: 'netzbetreiber' | 'direktvermarkter', anzahl: number, minutes: number) => ({
      periode, type, teNr: null, einheitName: null, anzahl, minutes, energyKwh: null, wertEur: null, ohneSchaetzung: 0,
      unvollstaendig: 0, arten: {}, luecken: 0, weitereWechsel: null,
    });
    const vorgaben: HistoryVorgaben = { verarbeitetBis: NOW.toISOString(), zaehlung: [z('2026-03', 'direktvermarkter', 1, 60), z('2026-10', 'netzbetreiber', 7, 680), z('2026-10', 'direktvermarkter', 23, 1865)] };
    const jahr = vorgabenTeile(ereignisSpur({ ...hist([], [], 'year'), vorgaben })!);
    expect(jahr.monate.map((t) => [t.label, t.zeilen.map((x) => sp(x.text))])).toEqual([
      ['März 2026', ['Direktvermarkter 1× · 1 Std']],
      ['Oktober 2026', ['Netzbetreiber 7× · 11 Std 20 Min', 'Direktvermarkter 23× · 1 Tag 7 Std']],
    ]);
  });

  it('ohne Vorgaben „noch keine Vorgaben“ statt einer leeren Karte — und nie ohne Prüfung', () => {
    const leer: HistoryVorgaben = { verarbeitetBis: NOW.toISOString(), zaehlung: [] };
    expect(ereignisSpur({ ...hist([], [], 'day'), vorgaben: leer })!.leerText).toBe('Noch keine Vorgaben in diesem Zeitraum');
    expect(ereignisSpur({ ...hist([], [], 'day'), vorgaben: { ...leer, verarbeitetBis: null } })!.leerText)
      .toBe('Die Vorgaben dieser Anlage werden noch ausgewertet');
    expect(ereignisSpur(hist([], [], 'day'))!.leerText).toBe('Nichts Auffälliges');
    const andere = ereignisSpur({ ...hist([local(2026, 7, 15)], [ereignis()]), vorgaben: leer })!;
    expect(andere.vorgabenHinweis).toBe('Noch keine Vorgaben in diesem Zeitraum');
    expect(ereignisSpur({ ...hist([local(2026, 7, 15)], [ereignis()]) })!.vorgabenHinweis).toBeNull();
  });

  it('das Detail sagt, was EZ-7 belegt: Beginn, Ende, Vorgabe, Ist, Schätzung, Zähler und die Rohsignale', () => {
    const d = vorgabeDetailBeispiel('vg-bue-2', NOW);
    expect(Object.fromEntries(vorgabeFakten(d.vorgabe).map((f) => [f.label, sp(f.value)]))).toEqual({
      Beginn: '21.10. 14:32',
      Ende: 'läuft, zuletzt gesehen 21.10. 15:43',
      Dauer: '1 Std 11 Min',
      Vorgabe: '60 % · 59,4 kW',
      'Ist im Mittel': '58,9 kW',
      'Verfügbar im Mittel': '79,6 kW',
      'Geschätzt nicht erzeugt': '≈ 25,0 kWh (aus der Nennleistung der bereiten Motoren)',
      'Euro (Schätzung)': '—',
      'Anlage folgte': 'ja, sie war die wirksame Grenze',
      Kanal: 'Stufen',
      Zählerstand: '41 → 42',
    });
    expect(d.roh_beginn.map(rohwertText)).toEqual(['Vorgabe gültig, Verbindung steht, Wirkleistung begrenzt (7)', '60', 'Stufen (2)']);
  });

  it('spricht Energie und Euro ehrlich: unbekannt „—“, eine bekannte Null 0', () => {
    expect(energieText(null)).toBe('—');
    expect(sp(energieText(0))).toBe('0 kWh');
    expect(sp(energieText(410.4))).toBe('≈ 410 kWh');
    expect(euroText(null)).toBeNull();
    expect(sp(euroText(1234.5))).toBe('≈ 1.234,50 €');
  });
});
