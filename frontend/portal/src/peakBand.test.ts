import { describe, expect, it } from 'vitest';
import { peakBand, quarterHourMeanImportKw, type PowerSample } from './peakBand';
import type { PeakShaving } from './api';

/** now anchored inside a quarter: 10:07:00 → quarter start 10:00:00. */
const NOW = new Date('2026-07-20T10:07:00Z');

function sample(ts: string, powerKw: number | null): PowerSample {
  return { ts, powerKw };
}

describe('quarterHourMeanImportKw - the live ¼-h mean (import-only)', () => {
  it('averages import power over the running wall-clock quarter', () => {
    const m = quarterHourMeanImportKw(
      [
        sample('2026-07-20T10:01:00Z', 100),
        sample('2026-07-20T10:03:00Z', 200),
        sample('2026-07-20T10:06:00Z', 300),
      ],
      NOW,
    );
    expect(m.kw).toBe(200); // (100+200+300)/3
    expect(m.count).toBe(3);
    expect(m.fresh).toBe(true); // newest 10:06 is within 5 min of 10:07
  });

  it('counts import only - export (negative power) never offsets the peak', () => {
    const m = quarterHourMeanImportKw(
      [sample('2026-07-20T10:02:00Z', 120), sample('2026-07-20T10:05:00Z', -40)],
      NOW,
    );
    // max(120,0)=120, max(-40,0)=0 → mean 60 over 2 samples
    expect(m.kw).toBe(60);
  });

  it('ignores samples outside the running quarter (previous quarter / future)', () => {
    const m = quarterHourMeanImportKw(
      [
        sample('2026-07-20T09:59:00Z', 999), // previous quarter
        sample('2026-07-20T10:04:00Z', 50), // in quarter
        sample('2026-07-20T10:30:00Z', 999), // future
      ],
      NOW,
    );
    expect(m.kw).toBe(50);
    expect(m.count).toBe(1);
  });

  it('skips null / non-finite power', () => {
    const m = quarterHourMeanImportKw(
      [sample('2026-07-20T10:02:00Z', null), sample('2026-07-20T10:05:00Z', 80)],
      NOW,
    );
    expect(m.kw).toBe(80);
    expect(m.count).toBe(1);
  });

  it('no usable sample → null (never a fabricated 0)', () => {
    const empty = quarterHourMeanImportKw([], NOW);
    expect(empty.kw).toBeNull();
    expect(empty.count).toBe(0);
    expect(empty.fresh).toBe(false);
    // only stale/out-of-quarter samples → still null
    const stale = quarterHourMeanImportKw([sample('2026-07-20T09:50:00Z', 100)], NOW);
    expect(stale.kw).toBeNull();
  });

  it('marks the mean stale when the newest sample is older than 5 minutes', () => {
    // A quarter that started long ago: newest sample 10:01, now 10:07 → 6 min old.
    const m = quarterHourMeanImportKw([sample('2026-07-20T10:01:00Z', 100)], NOW);
    expect(m.kw).toBe(100);
    expect(m.fresh).toBe(false);
  });
});

const PEAK: PeakShaving = {
  leistungspreisEurKw: 120,
  abrechnung: 'monat',
  periodStart: '2026-07-01',
  peakKw: 142,
  baselinePeakKw: 180,
  avoidedKw: 38,
  avoidedEur: 4560,
  history: [],
};

describe('peakBand - the render-ready view', () => {
  it('builds the bar geometry from current mean vs Ziel', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: 180,
      peak: PEAK,
    });
    expect(view.currentLabel).toContain('142');
    expect(view.targetLabel).toContain('Ziel');
    expect(view.targetLabel).toContain('180');
    // barMax = 180 * 1.2 = 216 → fill 142/216, limit 180/216
    expect(view.fillPct).toBeCloseTo((142 / 216) * 100, 5);
    expect(view.limitPct).toBeCloseTo((180 / 216) * 100, 5);
    expect(view.breach).toBe(false);
    expect(view.note).toBeNull();
  });

  it('surfaces the PS-4 avoided peak + saved cost as green metrics', () => {
    const view = peakBand({ current: { kw: 142, fresh: true, count: 5 }, targetKw: 180, peak: PEAK });
    expect(view.metrics).toHaveLength(2);
    expect(view.metrics[0].label).toContain('Vermiedene Spitze');
    expect(view.metrics[0].label).toContain('pro Monat');
    expect(view.metrics[0].value).toContain('38');
    expect(view.metrics[0].tone).toBe('good');
    expect(view.metrics[1].label).toBe('Ersparte Leistungskosten');
    expect(view.metrics[1].value).toContain('4.560');
    expect(view.metrics[1].tone).toBe('good');
  });

  it('flags a breach when the current mean exceeds the Ziel', () => {
    const view = peakBand({
      current: { kw: 200, fresh: true, count: 5 },
      targetKw: 180,
      peak: PEAK,
    });
    expect(view.breach).toBe(true);
    expect(view.fillPct).toBeGreaterThan(view.limitPct!);
  });

  it('no live value → "—" + honest note, target marker still placeable', () => {
    const view = peakBand({
      current: { kw: null, fresh: false, count: 0 },
      targetKw: 180,
      peak: PEAK,
    });
    expect(view.currentLabel).toBe('—');
    expect(view.fillPct).toBeNull();
    expect(view.limitPct).not.toBeNull(); // derivable from the target alone
    expect(view.note).toBe('Aktueller Live-Wert liegt gerade nicht vor.');
  });

  it('no target → no limit marker, but the live mean still fills the bar', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: null,
      peak: PEAK,
    });
    expect(view.targetLabel).toBeNull();
    expect(view.limitPct).toBeNull();
    expect(view.fillPct).not.toBeNull();
  });

  it('period not measured yet → no metrics + the honest period note', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: 180,
      peak: { ...PEAK, peakKw: null, avoidedKw: null, avoidedEur: null },
    });
    expect(view.metrics).toHaveLength(0);
    expect(view.note).toContain('noch keine Messwerte');
  });

  it('an avoided peak below the noise deadband drops out (no fake result)', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: 180,
      peak: { ...PEAK, avoidedKw: 0.02, avoidedEur: 2 },
    });
    expect(view.metrics).toHaveLength(0);
  });

  it('no peakShaving block at all → geometry only, no metrics, no note', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: 180,
      peak: null,
    });
    expect(view.metrics).toHaveLength(0);
    expect(view.note).toBeNull();
  });
});
