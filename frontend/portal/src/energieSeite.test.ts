import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket } from './api';
import {
  energieBilanzView,
  energieCsv,
  energieKennzahlen,
  energieQuoten,
  energieSpitzen,
  energieTabelle,
  energieTabellenZellen,
  energieTag,
} from './energieSeite';

const nb = (s: string | null | undefined) => (s ?? '').replace(/ /g, ' ');

function b(start: Date, over: Partial<HistoryBucket> = {}): HistoryBucket {
  return {
    start: start.toISOString(),
    pvKwh: 1,
    loadKwh: 0.5,
    gridImportKwh: 0.1,
    gridExportKwh: 0.6,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0,
    socMinPct: 50,
    socMaxPct: 50,
    socLastPct: 50,
    priceEurMwh: 80,
    costEur: 0,
    ...over,
  };
}

function hist(buckets: HistoryBucket[], over: Partial<History> = {}): History {
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    buckets,
    totals: {
      consumptionKwh: 0,
      pvGenerationKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      gridCostEur: null,
      tarifArt: 'fest',
      batterySavingsPlannedEur: null,
      autarkiePct: 80,
      eigenverbrauchPct: 40,
    },
    protocol: [],
    plan: [],
    ...over,
  };
}

describe('energieKennzahlen · ehrlicher Vergleich', () => {
  const tag = (d: number, pv: number, imp: number | null) =>
    hist([b(new Date(2026, 8, d, 10), { pvKwh: pv, gridImportKwh: imp })]);

  it('abgeschlossener Tag: Prozent mit Richtung', () => {
    const k = energieKennzahlen({
      history: tag(8, 118, 91),
      vorher: tag(7, 100, 100),
      anchor: new Date(2026, 8, 8, 12),
      range: 'day',
      now: new Date(2026, 8, 10, 12),
      modus: 'vorperiode',
    });
    expect(k.map((x) => x.label)).toEqual([
      'Erzeugung',
      'Verbrauch',
      'Netzbezug',
      'Einspeisung',
      'Speicher geladen',
      'Speicher entladen',
    ]);
    expect(k[0].unter).toBe('18 % mehr als am Vortag');
    expect(k[0].pfeil).toBe('↑');
    expect(k[2].unter).toBe('9 % weniger als am Vortag');
  });

  it('vergleicht nie gegen eine erfundene Null', () => {
    const k = energieKennzahlen({
      history: tag(8, 118, 91),
      vorher: tag(7, 100, null),
      anchor: new Date(2026, 8, 8, 12),
      range: 'day',
      now: new Date(2026, 8, 10, 12),
      modus: 'vorperiode',
    });
    expect(k[2].unter).toBeNull();
  });

  it('laufender Tag: nur bis zur gleichen Stunde', () => {
    const heute = hist([
      b(new Date(2026, 8, 10, 9), { pvKwh: 2 }),
      b(new Date(2026, 8, 10, 12), { pvKwh: 50 }),
    ]);
    const gestern = hist([
      b(new Date(2026, 8, 9, 9), { pvKwh: 1 }),
      b(new Date(2026, 8, 9, 15), { pvKwh: 99 }),
    ]);
    const k = energieKennzahlen({
      history: heute,
      vorher: gestern,
      anchor: new Date(2026, 8, 10, 12),
      range: 'day',
      now: new Date(2026, 8, 10, 12, 30),
      modus: 'vorperiode',
    });
    // 2 kWh bis 12 Uhr gegen 1 kWh bis 12 Uhr — die laufende Stunde bleibt draußen.
    expect(k[0].unter).toBe('100 % mehr als gestern bis 12 Uhr');
  });

  it('laufender Monat: nur die Menge des ganzen Vormonats', () => {
    const k = energieKennzahlen({
      history: hist([b(new Date(2026, 8, 2), { pvKwh: 10 })], { bucketMinutes: 1440 }),
      vorher: hist([b(new Date(2026, 7, 2), { pvKwh: 312 })], { bucketMinutes: 1440 }),
      anchor: new Date(2026, 8, 5, 12),
      range: 'month',
      now: new Date(2026, 8, 10, 12),
      modus: 'vorperiode',
    });
    expect(nb(k[0].unter)).toBe('ganzer August: 312,0 kWh');
    expect(k[0].unter).not.toMatch(/%/);
  });
});

describe('energieTag · drei Felder', () => {
  it('rechnet kWh in kW, zeichnet das Netz mit Vorzeichen und markiert Lücken und Negativpreise', () => {
    const h = hist(
      [
        b(new Date(2026, 8, 9, 0, 0), { pvKwh: 0.5, gridImportKwh: 0.25, gridExportKwh: 0 }),
        b(new Date(2026, 8, 9, 0, 30), { gridImportKwh: 0, gridExportKwh: 0.5 }),
      ],
      {
        events: [
          {
            type: 'negativpreis',
            start: new Date(2026, 8, 9, 0, 30).toISOString(),
            end: new Date(2026, 8, 9, 1, 0).toISOString(),
            text: 'Börsenpreis negativ',
          },
        ],
      },
    );
    const t = energieTag(h, new Date(2026, 8, 9, 12), new Date(2026, 8, 10, 12));
    expect(t.achse).toHaveLength(96);
    expect(t.pv[0]).toBe(2);
    expect(t.netz[0]).toBe(1);
    expect(t.netz[2]).toBe(-2);
    expect(t.pv[1]).toBeNull();
    expect(t.baender).toContainEqual({ von: 1, bis: 1, art: 'luecke' });
    expect(t.baender).toContainEqual({ von: 2, bis: 3, art: 'negativpreis' });
    expect(t.jetzt).toBeNull();
    expect(t.hatSoc).toBe(true);
  });
});

describe('energieBilanzView / Quoten / Spitzen / Tabelle', () => {
  const monat = hist(
    [b(new Date(2026, 7, 1), { pvKwh: 20, loadKwh: 12 }), b(new Date(2026, 7, 3), { pvKwh: 30, loadKwh: 9 })],
    { bucketMinutes: 1440 },
  );

  it('legt jeden Tag an und lässt fehlende leer', () => {
    const v = energieBilanzView(monat, new Date(2026, 7, 15), 'month', new Date(2026, 8, 10));
    expect(v.zellen).toHaveLength(31);
    expect(v.zellen[1].zustand).toBe('luecke');
    expect(v.drill).toBe('tag');
    expect(v.leer).toBe(false);
  });

  it('teilt die Quoten in eigene Anlage und Netz', () => {
    const [aut, eig] = energieQuoten(monat);
    expect(nb(aut.wert)).toBe('80 %');
    expect(aut.teile.map((t) => t.label)).toEqual(['aus eigener Anlage', 'aus dem Netz']);
    expect(eig.teile[1].anteilPct).toBe(60);
  });

  it('nennt im Monat die stärksten Tage', () => {
    const s = energieSpitzen(monat, 'month');
    expect(s.titel).toBe('Stärkste Tage');
    expect(nb(s.zeilen[0].wert)).toBe('30,0 kWh');
    expect(s.zeilen[0].wann).toBe('Mo., 03.08.');
  });

  it('Tabelle und CSV: Lücken als „keine Messwerte", Summe aus den Eimern', () => {
    const z = energieTabellenZellen(monat, new Date(2026, 7, 15), 'month', new Date(2026, 8, 10));
    const t = energieTabelle(z, monat, 'month');
    expect(t.zeilen[1].leer).toBe('keine Messwerte');
    expect(nb(t.summe?.zellen[0].text)).toBe('50,0 kWh');
    const csv = energieCsv(z, monat, 'month').split('\r\n');
    expect(csv[1]).toBe('2026-08-01T00:00;"Sa., 01.08.";20,000;12,000;0,100;0,600;0,000;0,000');
    expect(csv[2]).toBe('2026-08-02T00:00;"So., 02.08.";;;;;;');
  });
});
