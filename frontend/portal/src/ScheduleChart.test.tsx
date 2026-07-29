import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScheduleChart } from './ScheduleChart';
import { LOAD_FORECAST_LABEL, PV_FORECAST_LABEL } from './schedule';
import type { SchedulePlan, ScheduleSlot } from './api';

/**
 * The canvas is echarts' business (jsdom has none), so the chart's ECharts
 * setup is stubbed away here and the test pins the CHROME the customer
 * operates: the two forecast rows exist, are ON by default, and the legend
 * switches them. The series/axis maths live in the pure `schedule.ts`
 * derivations (`forecastLines`/`powerAxisMax`), tested there.
 */
vi.mock('./useEChart', () => ({
  useEChart: () => ({ current: null }),
}));

function slot(over: Partial<ScheduleSlot>): ScheduleSlot {
  return {
    start: '2026-07-29T10:00:00Z',
    batteryKw: 2,
    gridKw: 1,
    socPct: 50,
    priceEurMwh: 80,
    costEur: 0.01,
    baselineCostEur: 0.02,
    curtailKw: null,
    pvKw: null,
    loadKw: null,
    slotRole: null,
    slotFlags: null,
    storedValueCtKwh: null,
    gridValueCtKwh: null,
    peakPressureEurKw: null,
    ...over,
  };
}

function plan(slots: ScheduleSlot[]): SchedulePlan {
  return {
    planId: 'p1',
    deviceId: null,
    generatedAt: '2026-07-29T09:45:00Z',
    slotMinutes: 15,
    savingsEur: 0.01,
    bankedValueEur: null,
    socStartPct: null,
    socEndPct: null,
    peakTargetKw: null,
    fallback14a: null,
    slots,
  };
}

describe('ScheduleChart forecast lines', () => {
  it('offers PV- and Verbrauchsprognose as toggles, visible by default', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: 1.5 })])} />);
    const pv = screen.getByRole('button', { name: new RegExp(PV_FORECAST_LABEL) });
    const load = screen.getByRole('button', { name: new RegExp(LOAD_FORECAST_LABEL) });
    expect(pv).toHaveAttribute('aria-pressed', 'true');
    expect(load).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches one line off and back on without touching the other', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: 1.5 })])} />);
    const pv = () => screen.getByRole('button', { name: new RegExp(PV_FORECAST_LABEL) });
    fireEvent.click(pv());
    expect(pv()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: new RegExp(LOAD_FORECAST_LABEL) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(pv());
    expect(pv()).toHaveAttribute('aria-pressed', 'true');
  });

  it('never advertises a line the run does not carry', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: null })])} />);
    expect(screen.getByText(PV_FORECAST_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FORECAST_LABEL)).not.toBeInTheDocument();
  });

  it('renders exactly today’s legend on a pre-feature plan (no forecast rows)', () => {
    render(<ScheduleChart plan={plan([slot({})])} />);
    expect(screen.queryByText(PV_FORECAST_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(LOAD_FORECAST_LABEL)).not.toBeInTheDocument();
    // ...and the bar rows stay plain labels, not toggles.
    expect(screen.queryByRole('button')).toBeNull();
  });
});
