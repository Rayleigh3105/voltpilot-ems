import { describe, expect, it } from 'vitest';
import type { PriceBucket, PriceHistory, PriceRangeSummary } from './api';
import {
  bezugspreisNote,
  ctFromEurMwh,
  ctLabel,
  fokusFenster,
  fokusUmschalter,
  jetztPreis,
  preisChips,
  slotTime,
  tagesGrenze,
} from './marktpreise';
import { NBSP } from './format';

/** 15-Minuten-Reihe ab `start`, Preise in EUR/MWh. */
function reihe(start: string | Date, preise: (number | null)[]): PriceBucket[] {
  const t0 = start instanceof Date ? start.getTime() : Date.parse(start);
  return preise.map((p, i) => ({
    ts: new Date(t0 + i * 15 * 60_000).toISOString(),
    avgEurMwh: p,
    minEurMwh: p,
    maxEurMwh: p,
  }));
}

/**
 * Die Tagesgrenze ist die LOKALE Mitternacht des Kunden (`toDateString`), also
 * baut dieser Helfer sie aus lokalen Bestandteilen — eine feste UTC-Zeit wäre
 * je nach Zeitzone der Testmaschine mal vor und mal nach dem Tageswechsel.
 */
function lokal(y: number, m: number, d: number, h: number, min = 0): Date {
  return new Date(y, m - 1, d, h, min, 0, 0);
}

function history(buckets: PriceBucket[], bucket = 'PT15M'): PriceHistory {
  return {
    biddingZone: 'DE-LU',
    currency: 'EUR',
    bucket,
    from: buckets[0]?.ts ?? '2026-08-09T00:00:00Z',
    to: buckets[buckets.length - 1]?.ts ?? '2026-08-09T00:00:00Z',
    buckets,
    summary: {
      avgEurMwh: null,
      minEurMwh: null,
      maxEurMwh: null,
      cheapestTs: null,
      mostExpensiveTs: null,
      count: buckets.length,
      coverageStart: null,
      coverageEnd: null,
    },
  };
}

const summary = (p: Partial<PriceRangeSummary>): PriceRangeSummary => ({
  avgEurMwh: null,
  minEurMwh: null,
  maxEurMwh: null,
  cheapestTs: null,
  mostExpensiveTs: null,
  count: 0,
  coverageStart: null,
  coverageEnd: null,
  ...p,
});

describe('ct-Umrechnung', () => {
  it('rechnet EUR/MWh in die Rechnungs-Einheit um', () => {
    expect(ctFromEurMwh(76)).toBe(7.6);
    expect(ctFromEurMwh(-20)).toBe(-2);
  });

  it('gibt fuer nichts einen Gedankenstrich, nie eine Null', () => {
    expect(ctFromEurMwh(null)).toBeNull();
    expect(ctFromEurMwh(undefined)).toBeNull();
    expect(ctLabel(null)).toBe('—');
  });

  it('schreibt das Vorzeichen aus und schuetzt die Einheit vor dem Umbruch', () => {
    expect(ctLabel(-2.04)).toBe(`-2,04${NBSP}ct/kWh`);
    expect(ctLabel(18.4)).toBe(`18,40${NBSP}ct/kWh`);
  });
});

describe('jetztPreis', () => {
  const buckets = reihe('2026-08-09T12:00:00Z', [76, -20, 150, 40]);

  it('nimmt die Viertelstunde, die JETZT laeuft', () => {
    const held = jetztPreis(history(buckets), new Date('2026-08-09T12:20:00Z'));
    expect(held?.ct).toBe(-2);
    expect(held?.ton).toBe('negativ');
    expect(held?.wort).toBe('Negativpreis');
  });

  it('nimmt den Slot ab seiner Startsekunde und bis eine ms vor dem Ende', () => {
    expect(jetztPreis(history(buckets), new Date('2026-08-09T12:15:00.000Z'))?.ct).toBe(-2);
    expect(jetztPreis(history(buckets), new Date('2026-08-09T12:29:59.999Z'))?.ct).toBe(-2);
    expect(jetztPreis(history(buckets), new Date('2026-08-09T12:30:00.000Z'))?.ct).toBe(15);
  });

  it('benennt guenstig, normal und teuer an den Schwellen', () => {
    const at = (eurMwh: number) =>
      jetztPreis(history(reihe('2026-08-09T12:00:00Z', [eurMwh])), new Date('2026-08-09T12:05:00Z'))
        ?.ton;
    expect(at(0)).toBe('guenstig');
    expect(at(50)).toBe('guenstig');
    expect(at(51)).toBe('normal');
    expect(at(149)).toBe('normal');
    expect(at(150)).toBe('teuer');
    expect(at(-1)).toBe('negativ');
  });

  it('erfindet NIE einen Preis, wenn der Zeitraum das Jetzt nicht abdeckt', () => {
    // Rueckblick auf gestern: der letzte bekannte Preis darf nicht als "jetzt"
    // durchgehen.
    expect(jetztPreis(history(buckets), new Date('2026-08-10T09:00:00Z'))).toBeNull();
    expect(jetztPreis(history(buckets), new Date('2026-08-09T11:00:00Z'))).toBeNull();
  });

  it('schweigt bei einer Luecke in der Reihe statt zu interpolieren', () => {
    const mitLuecke = reihe('2026-08-09T12:00:00Z', [76, null, 150]);
    expect(jetztPreis(history(mitLuecke), new Date('2026-08-09T12:20:00Z'))).toBeNull();
  });

  it('gilt nur fuer die Viertelstunden-Aufloesung', () => {
    // Ein Tages-Bucket beantwortet "was kostet Strom JETZT" nicht.
    expect(jetztPreis(history(buckets, 'P1D'), new Date('2026-08-09T12:20:00Z'))).toBeNull();
    expect(jetztPreis(null, new Date())).toBeNull();
  });
});

describe('bezugspreisNote', () => {
  it('liest den gelieferten Bezugspreis', () => {
    expect(bezugspreisNote(32.5)).toBe(`Ihr Bezugspreis 32,50${NBSP}ct/kWh`);
  });

  it('entfaellt ersatzlos, statt eine Zahl zu erfinden', () => {
    expect(bezugspreisNote(null)).toBeNull();
    expect(bezugspreisNote(undefined)).toBeNull();
    expect(bezugspreisNote(Number.NaN)).toBeNull();
  });
});

describe('preisChips', () => {
  it('macht aus Tief/Hoch/Ø drei Chips mit Uhrzeit', () => {
    const chips = preisChips(
      summary({
        minEurMwh: -26,
        maxEurMwh: 150,
        avgEurMwh: 76,
        cheapestTs: '2026-08-09T13:15:00Z',
        mostExpensiveTs: '2026-08-09T19:15:00Z',
      }),
      true,
    );
    expect(chips.map((c) => c.id)).toEqual(['tief', 'hoch', 'schnitt']);
    expect(chips[0].label).toContain('Tief -2,6 ct');
    expect(chips[0].ton).toBe('gut');
    expect(chips[1].label).toContain('Hoch 15,0 ct');
    expect(chips[1].ton).toBe('teuer');
    expect(chips[2].label).toBe('Ø 7,6 ct');
  });

  it('laesst die Uhrzeit im Rueckblick weg (dort ist sie ein Datum, kein Slot)', () => {
    const chips = preisChips(
      summary({ minEurMwh: -26, cheapestTs: '2026-08-09T13:15:00Z' }),
      false,
    );
    expect(chips[0].label).toBe('Tief -2,6 ct');
  });

  it('erzeugt fuer eine fehlende Zahl KEINEN Chip', () => {
    expect(preisChips(summary({ avgEurMwh: 76 }), true).map((c) => c.id)).toEqual(['schnitt']);
    expect(preisChips(summary({}), true)).toEqual([]);
    expect(preisChips(null, true)).toEqual([]);
  });
});

describe('Tagesgrenze und Fokus', () => {
  // Lokal 08.08. 22:00 .. 09.08. 00:30 - der Wechsel liegt bei Index 8.
  const ueberNacht = reihe(lokal(2026, 8, 8, 22), new Array(11).fill(50));

  it('findet die erste Viertelstunde des Folgetags', () => {
    expect(tagesGrenze(ueberNacht)).toBe(8);
  });

  it('meldet -1, wenn die Reihe im selben Tag bleibt', () => {
    expect(tagesGrenze(reihe(lokal(2026, 8, 9, 10), [1, 2, 3]))).toBe(-1);
    expect(tagesGrenze([])).toBe(-1);
  });

  it('bietet den Umschalter nur an, wenn es einen Folgetag gibt', () => {
    expect(fokusUmschalter(ueberNacht, 'heute')).toEqual({
      label: 'Morgen ›',
      ziel: 'morgen',
      aktuell: 'Heute',
    });
    expect(fokusUmschalter(ueberNacht, 'morgen')).toEqual({
      label: '‹ Heute',
      ziel: 'heute',
      aktuell: 'Morgen',
    });
    expect(fokusUmschalter(reihe(lokal(2026, 8, 9, 10), [1, 2]), 'heute')).toBeNull();
  });

  it('schneidet das Fenster genau an der Grenze', () => {
    expect(fokusFenster(ueberNacht, 'heute')).toEqual({ start: 0, end: 7 });
    expect(fokusFenster(ueberNacht, 'morgen')).toEqual({ start: 8, end: 10 });
  });

  it('gibt ohne Folgetag KEIN Fenster (die Kurve zeigt dann alles)', () => {
    expect(fokusFenster(reihe(lokal(2026, 8, 9, 10), [1, 2]), 'heute')).toBeNull();
  });
});

describe('slotTime', () => {
  it('gibt die lokale Uhrzeit der Viertelstunde', () => {
    expect(slotTime('2026-08-09T13:15:00Z')).toMatch(/^\d{2}:\d{2}$/);
  });

  it('behauptet ohne Zeitstempel nichts', () => {
    expect(slotTime(null)).toBeNull();
    expect(slotTime('kaputt')).toBeNull();
  });
});
