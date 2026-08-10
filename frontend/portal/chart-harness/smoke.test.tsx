import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * THROWAWAY smoke test for the fixture harness.
 *
 * The browser in this sandbox cannot reach the dev server, so this is how the
 * fixtures are proven to drive the REAL derivations without crashing: the
 * ECharts hook is stubbed (jsdom has no canvas) but its render closure is
 * EXECUTED and its `setOption` captured - so a fixture that breaks
 * `energieDiagramm`/`forecastLines`/`phases()` fails here, exactly as it would
 * blank the page in a browser.
 */
const options: Record<string, unknown[]> = {};
let current = 'unknown';

vi.mock('../src/useEChart', () => ({
  useEChart: (renderChart: (chart: unknown, width: number) => void) => {
    const chart = {
      getZr: () => ({ on: () => {}, off: () => {} }),
      containPixel: () => false,
      convertFromPixel: () => 0,
      setOption: (opt: { series?: unknown[] }) => {
        options[current] = opt?.series ?? [];
      },
      resize: () => {},
      dispose: () => {},
    };
    renderChart(chart, 900);
    return { current: null };
  },
}));

const { TelemetryChart } = await import('../src/TelemetryChart');
const { HistoryEnergieChart } = await import('../src/HistoryChart');
const { ScheduleChart } = await import('../src/ScheduleChart');
const { history, schedulePlan, telemetryPoints } = await import('./fixtures');

describe('chart harness fixtures', () => {
  it('telemetry: 3-hour window ending at now, all four channels present', () => {
    expect(telemetryPoints.length).toBeGreaterThan(150);
    const last = new Date(telemetryPoints[telemetryPoints.length - 1].ts).getTime();
    expect(Date.now() - last).toBeLessThan(90_000); // fills the `max: nowMs` axis
    expect(telemetryPoints.every((p) => p.pvPowerKw !== null && p.socPct !== null)).toBe(true);

    current = 'telemetry';
    render(<TelemetryChart points={telemetryPoints} windowLabel="in den letzten 3 Stunden" />);
    expect((options.telemetry ?? []).length).toBeGreaterThan(0);
  });

  it('history: 96 quarter-hour buckets with reconciling totals', () => {
    expect(history.buckets).toHaveLength(96);
    expect(history.totals.pvGenerationKwh).toBeGreaterThan(0);
    expect(history.totals.autarkiePct).not.toBeNull();

    current = 'history';
    render(<HistoryEnergieChart history={history} />);
    expect((options.history ?? []).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Erzeugung|Verbrauch|Netz/).length).toBeGreaterThan(0);
  });

  it('schedule: 96 slots, positive savings, a negative-price curtailment window', () => {
    expect(schedulePlan.slots).toHaveLength(96);
    expect(schedulePlan.savingsEur ?? 0).toBeGreaterThan(0);
    expect(schedulePlan.slots.some((s) => (s.priceEurMwh ?? 0) < 0)).toBe(true);
    expect(schedulePlan.slots.some((s) => (s.curtailKw ?? 0) > 0)).toBe(true);
    expect(schedulePlan.slots.some((s) => (s.batteryKw ?? 0) > 7)).toBe(true); // ~+8 midday
    expect(schedulePlan.slots.some((s) => (s.batteryKw ?? 0) < -6)).toBe(true); // ~-7 evening

    current = 'schedule';
    render(<ScheduleChart plan={schedulePlan} plantKind="eigenverbrauch" />);
    expect((options.schedule ?? []).length).toBeGreaterThan(0);
  });
});
