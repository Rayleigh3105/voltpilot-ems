import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket, HistoryRange } from './api';
import {
  energieBilanz,
  energieSummen,
  gridCostHinweis,
  isCurrentPeriod,
  sumChannel,
  summenTitel,
  zeitraumHinweis,
} from './energieBilanz';

function bucket(o: Partial<HistoryBucket> = {}): HistoryBucket {
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
    ...o,
  };
}

function hist(
  buckets: HistoryBucket[],
  totals: Partial<History['totals']> = {},
  range: HistoryRange = 'day',
): History {
  return {
    range,
    from: '',
    to: '',
    bucketMinutes: range === 'day' ? 15 : range === 'week' ? 60 : 1440,
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
      ...totals,
    },
    protocol: [],
    plan: [],
  };
}

const by = (summen: ReturnType<typeof energieSummen>, key: string) =>
  summen.find((s) => s.key === key)!;

describe('energieSummen — die sechs Energiemengen des Zeitraums', () => {
  it('summiert alle sechs Kanäle über die Buckets, incl. laden/entladen', () => {
    const s = energieSummen([
      bucket({
        pvKwh: 10,
        loadKwh: 4,
        gridImportKwh: 0.5,
        gridExportKwh: 5,
        batteryChargeKwh: 2,
        batteryDischargeKwh: 0,
      }),
      bucket({
        pvKwh: 6,
        loadKwh: 3,
        gridImportKwh: 1.5,
        gridExportKwh: 1,
        batteryChargeKwh: 1,
        batteryDischargeKwh: 3,
      }),
    ]);
    expect(s.map((x) => x.key)).toEqual([
      'erzeugt',
      'verbraucht',
      'bezogen',
      'eingespeist',
      'geladen',
      'entladen',
    ]);
    expect(by(s, 'erzeugt').kwh).toBe(16);
    expect(by(s, 'verbraucht').kwh).toBe(7);
    expect(by(s, 'bezogen').kwh).toBe(2);
    expect(by(s, 'eingespeist').kwh).toBe(6);
    // Die zwei Summen, die `totals` NICHT liefert — clientseitig gebildet.
    expect(by(s, 'geladen').kwh).toBe(3);
    expect(by(s, 'entladen').kwh).toBe(3);
  });

  it('ist null, wenn KEIN Bucket den Kanal trug — nie eine erfundene 0', () => {
    const s = energieSummen([bucket({ pvKwh: 5 }), bucket({ pvKwh: 2 })]);
    expect(by(s, 'erzeugt').kwh).toBe(7);
    expect(by(s, 'geladen').kwh).toBeNull();
    expect(by(s, 'entladen').kwh).toBeNull();
    expect(by(s, 'bezogen').kwh).toBeNull();
  });

  it('zählt eine GEMESSENE 0 als Wert (ein Speicher, der ruhte, ist kein Loch)', () => {
    const s = energieSummen([bucket({ batteryChargeKwh: 0, batteryDischargeKwh: 0 })]);
    expect(by(s, 'geladen').kwh).toBe(0);
    expect(by(s, 'entladen').kwh).toBe(0);
  });

  it('ignoriert NaN/Infinity statt sie durchzurechnen', () => {
    expect(sumChannel([bucket({ pvKwh: Number.NaN }), bucket({ pvKwh: 3 })], 'pvKwh')).toBe(3);
    expect(sumChannel([bucket({ pvKwh: Number.POSITIVE_INFINITY })], 'pvKwh')).toBeNull();
  });

  it('trägt je Summe ein deutsches Etikett, eine Farbe und einen Hinweis', () => {
    for (const s of energieSummen([bucket({ pvKwh: 1 })])) {
      expect(s.label).toMatch(/^[A-ZÄÖÜ]/);
      expect(s.hinweis.length).toBeGreaterThan(10);
      expect(s.farbe).toBeTruthy();
    }
  });
});

describe('energieBilanz — Summen + Quoten + Kosten', () => {
  it('nimmt Quoten und Kosten aus totals (die brauchen Preise/Plan)', () => {
    const b = energieBilanz(
      hist([bucket({ pvKwh: 10, gridImportKwh: 2 })], {
        autarkiePct: 82,
        eigenverbrauchPct: 64,
        gridCostEur: 0.94,
      }),
    );
    expect(b.autarkiePct).toBe(82);
    expect(b.eigenverbrauchPct).toBe(64);
    expect(b.gridCostEur).toBe(0.94);
    expect(b.empty).toBe(false);
  });

  it('meldet empty, wenn nicht eine einzige Summe vorliegt', () => {
    expect(energieBilanz(hist([bucket(), bucket()])).empty).toBe(true);
    expect(energieBilanz(hist([])).empty).toBe(true);
    expect(energieBilanz(hist([bucket({ loadKwh: 0 })])).empty).toBe(false);
  });

  it('sagt bei den Netzkosten immer, dass es Börsenpreise sind', () => {
    expect(gridCostHinweis('ohne')).toBe('zu Börsenpreisen');
    expect(gridCostHinweis(null)).toBe('zu Börsenpreisen');
    // Mit hinterlegtem Tarif zusätzlich: der Tarif ist hier NICHT eingerechnet.
    expect(gridCostHinweis('fest')).toBe('zu Börsenpreisen · ohne Ihren Tarif');
    expect(gridCostHinweis('dynamisch')).toBe('zu Börsenpreisen · ohne Ihren Tarif');
    expect(energieBilanz(hist([], { tarifArt: 'dynamisch' })).gridCostHinweis).toBe(
      'zu Börsenpreisen · ohne Ihren Tarif',
    );
  });
});

describe('Zeitraum-Ehrlichkeit — nie zwei Zahlen unter einem Wort', () => {
  const now = new Date(2026, 6, 24, 12, 0); // Fr, 24.07.2026

  it('erkennt den laufenden Zeitraum je Bereich', () => {
    expect(isCurrentPeriod(new Date(2026, 6, 24), 'day', now)).toBe(true);
    expect(isCurrentPeriod(new Date(2026, 6, 23), 'day', now)).toBe(false);
    expect(isCurrentPeriod(new Date(2026, 6, 20), 'week', now)).toBe(true); // Mo derselben KW
    expect(isCurrentPeriod(new Date(2026, 6, 13), 'week', now)).toBe(false);
    expect(isCurrentPeriod(new Date(2026, 6, 1), 'month', now)).toBe(true);
    expect(isCurrentPeriod(new Date(2026, 5, 30), 'month', now)).toBe(false);
    expect(isCurrentPeriod(new Date(2026, 0, 1), 'year', now)).toBe(true);
    expect(isCurrentPeriod(new Date(2025, 11, 31), 'year', now)).toBe(false);
  });

  it('gibt im laufenden Zeitraum KEINEN Hinweis (es gibt keinen Widerspruch)', () => {
    expect(zeitraumHinweis(new Date(2026, 6, 24), 'day', now)).toBeNull();
    expect(zeitraumHinweis(new Date(2026, 6, 1), 'month', now)).toBeNull();
  });

  it('nennt bei einem vergangenen Zeitraum ausdrücklich sein Etikett', () => {
    const note = zeitraumHinweis(new Date(2026, 5, 15), 'month', now);
    expect(note).toContain('Juni 2026');
    expect(note).toContain('nicht für heute');
  });

  it('führt den Zeitraum im Titel der Kennzahl-Zeile', () => {
    expect(summenTitel(new Date(2026, 6, 24), 'month')).toBe('Energie im Zeitraum · Juli 2026');
    expect(summenTitel(new Date(2026, 6, 24), 'year')).toBe('Energie im Zeitraum · 2026');
  });
});
