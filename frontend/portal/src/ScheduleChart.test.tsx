import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScheduleChart } from './ScheduleChart';
import {
  LOAD_FORECAST_LABEL,
  MEASURED_LOAD_LABEL,
  MEASURED_PV_LABEL,
  PV_FORECAST_LABEL,
} from './schedule';
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

/**
 * P3 "Ist-Last sichtbar": the measured consumption is a row of its own, right
 * next to its forecast, and it is honest about being absent.
 */
describe('ScheduleChart Ist-Last line', () => {
  it('offers the measured consumption as its own toggle, on by default', () => {
    render(
      <ScheduleChart plan={plan([slot({ loadKw: 4.33, measuredLoadKw: 7.117 })])} />,
    );
    const ist = screen.getByRole('button', { name: /Verbrauch \(gemessen\)/ });
    expect(ist).toHaveAttribute('aria-pressed', 'true');
    // The forecast row stays its own, independent toggle - the pair is the point.
    fireEvent.click(ist);
    expect(ist).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: new RegExp(LOAD_FORECAST_LABEL) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('names the reason instead of drawing a 0-line when past slots were not measured', () => {
    // The plan's slot is an hour in the past, so a measurement is expected.
    const past = new Date(Date.now() - 3600_000).toISOString();
    render(<ScheduleChart plan={plan([slot({ start: past, loadKw: 4.33 })])} />);
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(/keine Messwerte des Verbrauchs/)).toBeInTheDocument();
  });

  it('stays silent on a plan that is still entirely ahead', () => {
    const ahead = new Date(Date.now() + 3600_000).toISOString();
    render(<ScheduleChart plan={plan([slot({ start: ahead, loadKw: 4.33 })])} />);
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(/keine Messwerte des Verbrauchs/)).not.toBeInTheDocument();
  });

  it('renders exactly today’s legend when the backend serves no measured field', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: 1.5 })])} />);
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
  });
});

/**
 * The Ist-PV mirror: same convention as its load twin (gepunktet = Prognose,
 * durchgezogen = gemessen), its own toggle, and honest about being absent.
 */
describe('ScheduleChart PV (gemessen) line', () => {
  const past = () => new Date(Date.now() - 3600_000).toISOString();

  it('offers the measured PV as its own toggle, on by default', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 12, measuredPvKw: 15.3 })])} />);
    const ist = screen.getByRole('button', { name: /PV \(gemessen\)/ });
    expect(ist).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(ist);
    expect(ist).toHaveAttribute('aria-pressed', 'false');
    // The PV forecast row stays its own, independent toggle - the pair is the point.
    expect(screen.getByRole('button', { name: new RegExp(PV_FORECAST_LABEL) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the two measured lines independently of each other', () => {
    render(
      <ScheduleChart
        plan={plan([slot({ pvKw: 12, loadKw: 4.33, measuredPvKw: 15.3 })])}
      />,
    );
    expect(screen.getByText(MEASURED_PV_LABEL)).toBeInTheDocument();
    // No measured load on this run -> no row for it, and the note names only it.
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
  });

  it('names the reason instead of drawing a 0-line when past slots were not measured', () => {
    render(<ScheduleChart plan={plan([slot({ start: past(), pvKw: 12, loadKw: 4.33 })])} />);
    expect(screen.queryByText(MEASURED_PV_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(/keine Messwerte von Verbrauch und PV-Erzeugung/)).toBeInTheDocument();
  });

  it('never claims a missing PV measurement on a plan without a PV-Prognose', () => {
    render(<ScheduleChart plan={plan([slot({ start: past(), loadKw: 4.33 })])} />);
    expect(screen.getByText(/keine Messwerte des Verbrauchs/)).toBeInTheDocument();
    expect(screen.queryByText(/PV-Erzeugung/)).not.toBeInTheDocument();
  });

  it('renders exactly today’s legend when the backend serves no measured field', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 12, loadKw: 1.5 })])} />);
    expect(screen.queryByText(MEASURED_PV_LABEL)).not.toBeInTheDocument();
  });
});
