import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket } from './api';
import {
  metricHasData,
  noVerlaufNote,
  widgetHistoryMetric,
  widgetSeries,
} from './widgetHistory';

/** Portal v3.2 · M2 — die reine Verlauf-Ableitung der Widget-Kacheln. */

function bucket(start: string, over: Partial<HistoryBucket> = {}): HistoryBucket {
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
    ...over,
  };
}

function history(range: History['range'], buckets: HistoryBucket[], bucketMinutes = 15): History {
  return { range, from: '', to: '', bucketMinutes, buckets, totals: {} as never, protocol: [], plan: [] };
}

describe('widgetHistoryMetric', () => {
  it('hat einen Verlauf für die Fluss-/Energie-Kacheln', () => {
    for (const id of ['erzeugung', 'haus', 'netz', 'speicher', 'eigenverbrauch'] as const) {
      expect(widgetHistoryMetric(id)).not.toBeNull();
    }
  });

  it('hat KEINEN Verlauf für Geld-/Automatik-/Wetter-Kacheln (die tragen eigene Körper)', () => {
    for (const id of ['handel', 'erloes', 'lastspitze', 'automatik', 'wetter'] as const) {
      expect(widgetHistoryMetric(id)).toBeNull();
    }
  });

  it('Netz trägt Bezug UND Einspeisung als zwei Reihen', () => {
    const m = widgetHistoryMetric('netz')!;
    expect(m.series.map((s) => s.field)).toEqual(['gridImportKwh', 'gridExportKwh']);
  });

  it('Speicher ist eine Prozent-Achse (Ladestand)', () => {
    const m = widgetHistoryMetric('speicher')!;
    expect(m.axis).toBe('percent');
    expect(m.series[0].field).toBe('socLastPct');
  });
});

describe('widgetSeries — folgt dem gewählten Zeitraum', () => {
  const pv = widgetHistoryMetric('erzeugung')!;

  it('rechnet im Tages-Zeitraum kWh je Bucket in mittlere kW um (Einheit kW)', () => {
    // 15-min-Bucket, 3 kWh → 12 kW mittlere Leistung.
    const h = history('day', [bucket('2026-07-20T09:00:00Z', { pvKwh: 3 })], 15);
    const v = widgetSeries(h, pv);
    expect(v.unit).toBe('kW');
    expect(v.day).toBe(true);
    expect(v.series[0].data).toEqual([12]);
  });

  it('zeigt in Monat/Jahr die Energie je Bucket unverändert (Einheit kWh)', () => {
    const h = history('month', [bucket('2026-07-01T00:00:00Z', { pvKwh: 42 })], 1440);
    const v = widgetSeries(h, pv);
    expect(v.unit).toBe('kWh');
    expect(v.day).toBe(false);
    expect(v.series[0].data).toEqual([42]);
  });

  it('DERSELBE Metrik ergibt für Tag vs. Monat unterschiedliche Reihen (der Verlauf folgt)', () => {
    const day = widgetSeries(history('day', [bucket('t', { pvKwh: 3 })], 15), pv);
    const month = widgetSeries(history('month', [bucket('t', { pvKwh: 3 })], 1440), pv);
    expect(day.unit).not.toBe(month.unit);
    expect(day.series[0].data).not.toEqual(month.series[0].data);
  });

  it('Ladestand bleibt Prozent, egal welcher Zeitraum', () => {
    const soc = widgetHistoryMetric('speicher')!;
    const v = widgetSeries(history('day', [bucket('t', { socLastPct: 76 })], 15), soc);
    expect(v.unit).toBe('%');
    expect(v.axis).toBe('percent');
    expect(v.series[0].data).toEqual([76]);
  });

  it('lässt fehlende Werte fehlen (null), nie eine erfundene 0', () => {
    const v = widgetSeries(history('month', [bucket('t')], 1440), pv);
    expect(v.series[0].data).toEqual([null]);
  });
});

describe('metricHasData — die „—"-Disziplin', () => {
  const pv = widgetHistoryMetric('erzeugung')!;

  it('false ohne Historie (Gesamt / Ladefehler)', () => {
    expect(metricHasData(null, pv)).toBe(false);
    expect(metricHasData(undefined, pv)).toBe(false);
  });

  it('false, wenn kein Bucket einen Wert der Reihe trägt', () => {
    expect(metricHasData(history('month', [bucket('t')]), pv)).toBe(false);
  });

  it('true, sobald ein Bucket einen Wert trägt', () => {
    expect(metricHasData(history('month', [bucket('t', { pvKwh: 1 })]), pv)).toBe(true);
  });

  it('Netz reicht schon EIN gefülltes Feld einer der zwei Reihen', () => {
    const netz = widgetHistoryMetric('netz')!;
    expect(metricHasData(history('month', [bucket('t', { gridExportKwh: 2 })]), netz)).toBe(true);
  });
});

describe('noVerlaufNote', () => {
  it('nennt „Gesamt" beim Namen', () => {
    expect(noVerlaufNote('all')).toContain('Gesamt');
  });

  it('ist für einen normalen Zeitraum neutral', () => {
    expect(noVerlaufNote('month')).toContain('noch kein Verlauf');
    expect(noVerlaufNote('month')).not.toContain('Gesamt');
  });
});
