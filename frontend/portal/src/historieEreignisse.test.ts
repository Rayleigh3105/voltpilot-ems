import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket, HistoryEvent, HistoryRange } from './api';
import {
  ART_ORDER,
  bandSpanne,
  drilldownHinweis,
  ereignisSpur,
  ereignisZeit,
  spurHinweis,
  tagesSprung,
} from './historieEreignisse';

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
    expect(spur.leerText).toBe('Keine besonderen Ereignisse in diesem Zeitraum.');
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
