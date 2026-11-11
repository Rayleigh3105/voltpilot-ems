import { describe, expect, it } from 'vitest';
import { ladungenCsv, ladungenSumme, ladungenZeilen } from './ladungen';
import type { OcppTransactionEconomics } from '../api';

function ladung(overrides: Partial<OcppTransactionEconomics>): OcppTransactionEconomics {
  return {
    chargePointId: 'cp-1',
    transactionId: 1,
    startedAt: '2026-10-20T08:00:00Z',
    stoppedAt: '2026-10-20T10:00:00Z',
    kwh: 18.2,
    sonnenanteilPct: 62,
    euro: 3.0353,
    durchschnittCtKwh: 16.678,
    kartenRef: 'tagref_abcd1234',
    ...overrides,
  };
}

describe('ladungenZeilen', () => {
  it('nimmt nur die Ladungen desselben Ladepunkts, in der Reihenfolge des Servers', () => {
    const andere = ladung({ transactionId: 2, chargePointId: 'cp-2' });
    const erste = ladung({ transactionId: 1 });
    const zweite = ladung({ transactionId: 3 });

    const zeilen = ladungenZeilen([erste, andere, zweite], 'cp-1');

    expect(zeilen.map((z) => z.key)).toEqual(['cp-1-1', 'cp-1-3']);
    expect(zeilen[0].kwh).toBe(18.2);
    expect(zeilen[0].sonnenanteilPct).toBe(62);
    expect(zeilen[0].euro).toBeCloseTo(3.0353);
    expect(zeilen[0].kartenRef).toBe('tagref_abcd1234');
  });

  it('begrenzt auf n Zeilen, wenn angegeben', () => {
    const vier = [1, 2, 3, 4].map((id) => ladung({ transactionId: id }));
    expect(ladungenZeilen(vier, 'cp-1', 2)).toHaveLength(2);
    expect(ladungenZeilen(vier, 'cp-1')).toHaveLength(4);
  });

  it('erfindet nichts, wo der Server null liefert', () => {
    const z = ladungenZeilen([ladung({ kwh: null, sonnenanteilPct: null, euro: null, durchschnittCtKwh: null })], 'cp-1');
    expect(z[0].kwh).toBeNull();
    expect(z[0].sonnenanteilPct).toBeNull();
    expect(z[0].euro).toBeNull();
  });

  it('ist leer ohne Daten', () => {
    expect(ladungenZeilen(null, 'cp-1')).toEqual([]);
    expect(ladungenZeilen(undefined, 'cp-1')).toEqual([]);
  });
});

describe('ladungenSumme', () => {
  it('summiert kWh und Euro, mittelt den Sonnenanteil kWh-gewichtet', () => {
    const zeilen = ladungenZeilen([
      ladung({ transactionId: 1, kwh: 10, sonnenanteilPct: 80, euro: 1 }),
      ladung({ transactionId: 2, kwh: 20, sonnenanteilPct: 20, euro: 3 }),
    ], 'cp-1');

    const summe = ladungenSumme(zeilen);
    expect(summe.kwh).toBe(30);
    // (10*0.8 + 20*0.2) / 30 * 100 = 40 %
    expect(summe.sonnenanteilPct).toBeCloseTo(40);
    expect(summe.euro).toBe(4);
    // 4 € / 30 kWh * 100 = 13,333 ct/kWh
    expect(summe.durchschnittCtKwh).toBeCloseTo(13.333, 2);
  });

  it('lässt eine unbekannte Zutat null, erfindet keine Zahl', () => {
    const zeilen = ladungenZeilen([ladung({ kwh: null, sonnenanteilPct: null, euro: null })], 'cp-1');
    const summe = ladungenSumme(zeilen);
    expect(summe.kwh).toBeNull();
    expect(summe.sonnenanteilPct).toBeNull();
    expect(summe.euro).toBeNull();
    expect(summe.durchschnittCtKwh).toBeNull();
  });

  it('ist leer ohne Ladungen', () => {
    const summe = ladungenSumme([]);
    expect(summe).toEqual({ kwh: null, sonnenanteilPct: null, euro: null, durchschnittCtKwh: null });
  });
});

describe('ladungenCsv', () => {
  it('schreibt ungerundet mit Dezimalpunkt und ISO-Zeit, mit Kopfzeile', () => {
    const zeilen = ladungenZeilen([ladung({})], 'cp-1');
    const csv = ladungenCsv(zeilen);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Beginn,kWh,Sonnenanteil %,Euro,Durchschnitt ct/kWh,Karte');
    expect(lines[1]).toBe('2026-10-20T08:00:00Z,18.2,62,3.0353,16.678,tagref_abcd1234');
  });

  it('lässt fehlende Zahlen leer statt 0 zu erfinden', () => {
    const zeilen = ladungenZeilen([ladung({ kwh: null, euro: null })], 'cp-1');
    const lines = ladungenCsv(zeilen).split('\n');
    expect(lines[1]).toBe('2026-10-20T08:00:00Z,,62,,16.678,tagref_abcd1234');
  });

  it('nur die Kopfzeile ohne Ladungen', () => {
    expect(ladungenCsv([])).toBe('Beginn,kWh,Sonnenanteil %,Euro,Durchschnitt ct/kWh,Karte');
  });
});
