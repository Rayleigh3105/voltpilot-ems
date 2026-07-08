process.env.TZ = 'Europe/Berlin';

import { describe, expect, it } from 'vitest';
import type { PlanAccuracyPoint } from './api';
import { planTrafZu, whenLabel } from './planAccuracy';

const NOW = new Date(2026, 6, 8, 12, 0); // 2026-07-08 12:00 Berlin

function point(over: Partial<PlanAccuracyPoint>): PlanAccuracyPoint {
  return {
    day: '2026-07-07',
    plannedCostEur: -2.1,
    baselineCostEur: -1.4,
    realizedCostEur: -1.95,
    nSlots: 96,
    ...over,
  };
}

describe('planTrafZu', () => {
  it('is null when nothing is usable', () => {
    expect(planTrafZu([], NOW)).toBeNull();
    // Too few comparable slots to trust.
    expect(planTrafZu([point({ nSlots: 2 })], NOW)).toBeNull();
    // Missing a cost.
    expect(planTrafZu([point({ realizedCostEur: null })], NOW)).toBeNull();
  });

  it('derives the accuracy from planned vs realized (report N5 scenario)', () => {
    // Planned -2.10, realized -1.95 => 1 - 0.15/2.10 = 92.86% -> 93%.
    const r = planTrafZu([point({})], NOW)!;
    expect(r.accuracyPct).toBe(93);
    expect(r.day).toBe('2026-07-07');
    expect(r.whenLabel).toBe('gestern');
  });

  it('reports the advantage vs. the no-battery baseline only when positive', () => {
    // baseline -1.40 (a cost), realized -1.95 (revenue) => saved 0.55 €.
    const r = planTrafZu([point({})], NOW)!;
    expect(r.savedVsBaselineEur).toBeCloseTo(0.55, 6);
    // When the day was NOT cheaper than baseline, no saving clause.
    const worse = planTrafZu([point({ baselineCostEur: -2.5, realizedCostEur: -1.95 })], NOW)!;
    expect(worse.savedVsBaselineEur).toBeNull();
  });

  it('picks the most recent evaluated day', () => {
    const r = planTrafZu(
      [point({ day: '2026-07-05' }), point({ day: '2026-07-07', plannedCostEur: -2, realizedCostEur: -2 })],
      NOW,
    )!;
    expect(r.day).toBe('2026-07-07');
    expect(r.accuracyPct).toBe(100); // planned == realized
  });

  it('clamps a wildly-off plan to a floor of 0 %, never negative', () => {
    const r = planTrafZu([point({ plannedCostEur: -5, realizedCostEur: 5, baselineCostEur: 0 })], NOW)!;
    expect(r.accuracyPct).toBe(0);
  });
});

describe('whenLabel', () => {
  it('names recent days in plain German', () => {
    expect(whenLabel('2026-07-08', NOW)).toBe('heute');
    expect(whenLabel('2026-07-07', NOW)).toBe('gestern');
    expect(whenLabel('2026-07-06', NOW)).toBe('vorgestern');
    expect(whenLabel('2026-07-01', NOW)).toBe('am 1. Juli');
  });
});
