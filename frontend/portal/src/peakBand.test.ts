import { describe, expect, it } from 'vitest';
import { peakBand, serverQuarterHourMean } from './peakBand';
import type { PeakShaving } from './api';

describe('serverQuarterHourMean - wraps the server-computed running mean', () => {
  it('a present value is fresh and counts as one sample', () => {
    const m = serverQuarterHourMean(142);
    expect(m.kw).toBe(142);
    expect(m.fresh).toBe(true);
    expect(m.count).toBe(1);
  });

  it('null (no usable sample yet) stays null - never a fabricated 0', () => {
    const m = serverQuarterHourMean(null);
    expect(m.kw).toBeNull();
    expect(m.fresh).toBe(false);
    expect(m.count).toBe(0);
  });

  it('undefined (field not yet loaded) behaves like null', () => {
    const m = serverQuarterHourMean(undefined);
    expect(m.kw).toBeNull();
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
  currentQuarterMeanKw: 142,
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

  // G7: a bar only means something against a reference. Without a Ziel there
  // is neither a marker nor a scale, so NO bar is built - the customer gets
  // the number plus the honest "VoltPilot richtet das Ziel ein" note instead
  // of a fill that cannot be read.
  it('no target → no bar at all, plus the honest Ziel note', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: null,
      peak: PEAK,
    });
    expect(view.targetLabel).toBeNull();
    expect(view.hasTarget).toBe(false);
    expect(view.limitPct).toBeNull();
    expect(view.fillPct).toBeNull();
    expect(view.scaleMaxLabel).toBeNull();
    expect(view.note).toContain('von VoltPilot eingerichtet');
  });

  it('with a target the bar carries a marker AND a readable scale', () => {
    const view = peakBand({
      current: { kw: 142, fresh: true, count: 5 },
      targetKw: 180,
      peak: PEAK,
    });
    expect(view.hasTarget).toBe(true);
    expect(view.fillPct).not.toBeNull();
    expect(view.limitPct).not.toBeNull();
    expect(view.scaleMaxLabel).not.toBeNull();
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
