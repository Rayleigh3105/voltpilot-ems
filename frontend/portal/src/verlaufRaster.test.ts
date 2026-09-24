import { describe, expect, it } from 'vitest';
import type { HistoryBucket, SiteEarningsBucket } from './api';
import { energieZellen, feinesRaster, geldZellen, kalenderzellen, zeichenbar, zellenZustand } from './verlaufRaster';

const bucket = (start: string, over: Partial<HistoryBucket> = {}): HistoryBucket => ({
  start,
  pvKwh: 1,
  loadKwh: 0.5,
  gridImportKwh: 0,
  gridExportKwh: 0.5,
  batteryChargeKwh: 0,
  batteryDischargeKwh: 0,
  socMinPct: 50,
  socMaxPct: 50,
  socLastPct: 50,
  priceEurMwh: 80,
  costEur: 0,
  ...over,
});

describe('feinesRaster', () => {
  const from = new Date(2026, 8, 9, 0, 0).toISOString();
  const to = new Date(2026, 8, 10, 0, 0).toISOString();

  it('legt jede Viertelstunde an und lässt eine Lücke als Lücke stehen', () => {
    const buckets = [bucket(new Date(2026, 8, 9, 0, 0).toISOString()), bucket(new Date(2026, 8, 9, 0, 30).toISOString())];
    const r = feinesRaster({ from, to, bucketMinutes: 15, buckets, now: new Date(2026, 8, 10, 12) });
    expect(r).toHaveLength(96);
    expect(r[0].zustand).toBe('ok');
    expect(r[1].zustand).toBe('luecke');
    expect(r[1].wert).toBeNull();
    expect(r[2].zustand).toBe('ok');
  });

  it('nennt alles nach „jetzt“ Zukunft, nicht Lücke', () => {
    const r = feinesRaster({ from, to, bucketMinutes: 15, buckets: [], now: new Date(2026, 8, 9, 12, 0) });
    expect(r[47].zustand).toBe('luecke');
    expect(r[48].zustand).toBe('zukunft');
    expect(r[95].zustand).toBe('zukunft');
  });

  it('nennt die Zeit vor der ersten Messung „vorher“', () => {
    const first = new Date(2026, 8, 9, 6, 0).toISOString();
    const r = feinesRaster({ from, to, bucketMinutes: 15, buckets: [], now: new Date(2026, 8, 11), firstDataAt: first });
    expect(r[0].zustand).toBe('vorher');
    expect(r[23].zustand).toBe('vorher');
    expect(r[24].zustand).toBe('luecke');
  });

  it('bleibt bei kaputten Grenzen leer statt zu raten', () => {
    expect(feinesRaster({ from: 'x', to, bucketMinutes: 15, buckets: [], now: new Date() })).toEqual([]);
    expect(feinesRaster({ from: to, to: from, bucketMinutes: 15, buckets: [], now: new Date() })).toEqual([]);
  });
});

describe('kalenderzellen', () => {
  it('teilt Woche (ab Montag), Monat und Jahr', () => {
    const week = kalenderzellen(new Date(2026, 8, 10, 12), 'week');
    expect(week.map((z) => z.schluessel)).toEqual(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13']);
    expect(kalenderzellen(new Date(2026, 1, 3), 'month')).toHaveLength(28);
    const year = kalenderzellen(new Date(2026, 5, 1), 'year');
    expect(year).toHaveLength(12);
    expect(year[11].schluessel).toBe('2026-12');
  });
});

describe('zellenZustand', () => {
  const zelle = { schluessel: '2026-09-10', start: new Date(2026, 8, 10), ende: new Date(2026, 8, 11), art: 'tag' as const };
  it('unterscheidet laufend, Zukunft, Lücke und vor den Daten', () => {
    expect(zellenZustand(zelle, true, new Date(2026, 8, 10, 12))).toBe('laeuft');
    // Noch nichts angekommen heißt nicht „Lücke", solange die Zelle läuft.
    expect(zellenZustand(zelle, false, new Date(2026, 8, 10, 0, 5))).toBe('laeuft');
    expect(zellenZustand(zelle, true, new Date(2026, 8, 12))).toBe('ok');
    expect(zellenZustand(zelle, false, new Date(2026, 8, 12))).toBe('luecke');
    expect(zellenZustand(zelle, false, new Date(2026, 8, 9))).toBe('zukunft');
    expect(zellenZustand(zelle, false, new Date(2026, 8, 12), new Date(2026, 8, 11).toISOString())).toBe('vorher');
  });
});

describe('energieZellen', () => {
  it('summiert je Tag und lässt Tage ohne Eimer leer (nie 0)', () => {
    const buckets = [
      bucket(new Date(2026, 7, 1, 10).toISOString(), { pvKwh: 2 }),
      bucket(new Date(2026, 7, 1, 11).toISOString(), { pvKwh: 3, gridImportKwh: null }),
      bucket(new Date(2026, 7, 3, 11).toISOString(), { pvKwh: 1 }),
    ];
    const z = energieZellen(buckets, new Date(2026, 7, 15), 'month', new Date(2026, 8, 10));
    expect(z).toHaveLength(31);
    expect(z[0].pvKwh).toBe(5);
    expect(z[0].importKwh).toBe(0);
    expect(z[0].zustand).toBe('ok');
    expect(z[1].pvKwh).toBeNull();
    expect(z[1].zustand).toBe('luecke');
    expect(z[2].pvKwh).toBe(1);
  });

  it('fasst im Jahr zu Monaten zusammen', () => {
    const buckets = [bucket(new Date(2026, 0, 5).toISOString()), bucket(new Date(2026, 0, 6).toISOString())];
    const z = energieZellen(buckets, new Date(2026, 3, 1), 'year', new Date(2026, 8, 10));
    expect(z[0].pvKwh).toBe(2);
    expect(z[1].zustand).toBe('luecke');
    expect(z[9].zustand).toBe('zukunft');
  });
});

describe('geldZellen', () => {
  const b = (start: Date, netto: number): SiteEarningsBucket => ({ start: start.toISOString(), einspeiseErloesEur: 0.1, eigenverbrauchsWertEur: netto, stromkostenEur: 0.1, nettoEur: netto });
  it('legt den Tag in 24 Stunden an', () => {
    const z = geldZellen([b(new Date(2026, 8, 9, 13), 0.5)], new Date(2026, 8, 9, 12), 'day', new Date(2026, 8, 10, 12));
    expect(z).toHaveLength(24);
    expect(z[13].nettoEur).toBe(0.5);
    expect(z[13].zustand).toBe('ok');
    expect(z[12].zustand).toBe('luecke');
  });
  it('markiert laufende und künftige Stunden', () => {
    const z = geldZellen([b(new Date(2026, 8, 10, 11), 0.2)], new Date(2026, 8, 10, 12), 'day', new Date(2026, 8, 10, 11, 30));
    expect(z[11].zustand).toBe('laeuft');
    expect(z[12].zustand).toBe('zukunft');
    expect(zeichenbar(z[11])).toBe(true);
    expect(zeichenbar(z[12])).toBe(false);
  });
});
