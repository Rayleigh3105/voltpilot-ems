import { describe, expect, it } from 'vitest';
import type { EarningsMonth, EarningsSeriesPoint } from './api';
import {
  bestBucket,
  bestBucketText,
  bucketAxisLabel,
  energyLabel,
  ertragTitle,
  monthLong,
  monthShort,
  periodLabel,
  stripSlots,
  stripValueLabel,
} from './anlage';

describe('energyLabel', () => {
  it('shows MWh from a megawatt-hour up, kWh below, and never a fake zero', () => {
    expect(energyLabel(null)).toBe('–');
    expect(energyLabel(undefined)).toBe('–');
    expect(energyLabel(5550)).toBe('5,55 MWh');
    expect(energyLabel(820)).toBe('820 kWh');
    expect(energyLabel(9.4)).toBe('9,4 kWh');
    expect(energyLabel(0)).toBe('0,0 kWh');
  });
});

describe('month labels', () => {
  it('are the German short/long month names of the ISO month', () => {
    expect(monthShort('2026-07-01')).toBe('Jul');
    expect(monthShort('2026-03-01')).toBe('Mär');
    expect(monthLong('2026-07-01')).toBe('Juli');
  });
});

describe('periodLabel', () => {
  const now = new Date('2026-07-07T10:00:00Z');
  it('names the selected instance per range', () => {
    expect(periodLabel('day', now, now)).toBe('Heute');
    expect(periodLabel('month', now, now)).toBe('Juli');
    expect(periodLabel('year', now, now)).toBe('2026');
    expect(periodLabel('all', now, now)).toBe('Gesamt');
  });
  it('adds the year to a month of another year (a strip tap into the past)', () => {
    const march2025 = new Date('2025-03-15T12:00:00');
    expect(periodLabel('month', march2025, now)).toBe('März 2025');
  });
});

describe('stripSlots', () => {
  const now = new Date('2026-07-07T10:00:00Z');
  it('builds a fixed 12-month axis ending this month, filling missing months with null', () => {
    const strip: EarningsMonth[] = [
      { month: '2026-07-01', gesamtertragEur: 512.8 },
      { month: '2026-06-01', gesamtertragEur: 830 },
    ];
    const slots = stripSlots(strip, now);
    expect(slots).toHaveLength(12);
    // Oldest first, ending on the current month.
    expect(slots[0].month).toBe('2025-08-01');
    expect(slots[11].month).toBe('2026-07-01');
    expect(slots[11].isCurrent).toBe(true);
    expect(slots[11].value).toBe(512.8);
    expect(slots[11].label).toBe('Jul');
    expect(slots[10].value).toBe(830);
    // A month with no computable value carries null, not a fake zero.
    expect(slots[0].value).toBeNull();
  });
});

describe('stripValueLabel', () => {
  it('is a compact signed integer, never "-0"', () => {
    expect(stripValueLabel(null)).toBe('–');
    expect(stripValueLabel(104.4)).toBe('+104');
    expect(stripValueLabel(-7.2)).toBe('-7');
    expect(stripValueLabel(-0.001)).toBe('0');
  });
});

describe('bucketAxisLabel', () => {
  it('formats the bucket start per range (Berlin-local)', () => {
    // 2026-07-07 12:00 UTC = 14:00 Berlin (CEST).
    expect(bucketAxisLabel('2026-07-07T12:00:00Z', 'day')).toBe('14');
    // Berlin day start of the 7th.
    expect(bucketAxisLabel('2026-07-06T22:00:00Z', 'month')).toBe('7.');
    // Berlin month start of July.
    expect(bucketAxisLabel('2026-06-30T22:00:00Z', 'year')).toBe('Jul');
  });
});

describe('bestBucket / bestBucketText', () => {
  const series: EarningsSeriesPoint[] = [
    // Berlin day starts (CEST = UTC+2): 22:00Z is the next Berlin day's 00:00.
    { start: '2026-07-05T22:00:00Z', gesamtertragEur: 12.5 }, // Berlin 6. Juli
    { start: '2026-07-06T22:00:00Z', gesamtertragEur: 48.2 }, // Berlin 7. Juli (best)
    { start: '2026-07-07T22:00:00Z', gesamtertragEur: 30 }, // Berlin 8. Juli
  ];
  it('finds the highest-Gesamtertrag bucket', () => {
    expect(bestBucket(series)?.gesamtertragEur).toBe(48.2);
    expect(bestBucket([])).toBeNull();
  });
  it('names the best day with its amount, and stays silent when nothing is positive', () => {
    expect(bestBucketText(series, 'month')).toBe('Bester Tag: 7. Juli · +48,20 €');
    expect(bestBucketText([{ start: '2026-07-07T22:00:00Z', gesamtertragEur: 0 }], 'month')).toBeNull();
    expect(bestBucketText([], 'month')).toBeNull();
  });
});

describe('ertragTitle', () => {
  it('matches the range granularity', () => {
    expect(ertragTitle('day')).toBe('Ertrag pro Stunde');
    expect(ertragTitle('month')).toBe('Ertrag pro Tag');
    expect(ertragTitle('year')).toBe('Ertrag pro Monat');
    expect(ertragTitle('all')).toBe('Ertrag pro Monat');
  });
});
