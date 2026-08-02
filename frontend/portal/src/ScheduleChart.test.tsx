import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScheduleChart } from './ScheduleChart';
import {
  LOAD_FORECAST_LABEL,
  MEASURED_LOAD_LABEL,
  CURTAIL_LEGEND_LABEL,
  MEASURED_PV_LABEL,
  PV_FORECAST_LABEL,
} from './schedule';
import type { SchedulePlan, ScheduleSlot } from './api';

/**
 * The canvas is echarts' business (jsdom has none), so the chart's ECharts
 * setup is stubbed away here and the test pins the CHROME the customer
 * operates. Since the Fahrplan rebuild (Konzept vp-fahrplan-kunde-konzept
 * §6.4, Entscheid D4) that chrome is THREE layer switches instead of nine
 * pills, and the default is deliberately quiet: bars + price + Jetzt only.
 * The series/axis maths live in the pure `schedule.ts` derivations
 * (`forecastLines`/`powerAxisMax`/`hiddenLabels`), tested there.
 *
 * Der Mock RECHNET die Render-Closure trotzdem AUS und fängt ihr
 * `setOption`-Objekt ab (`lastOption`): genau die Divergenz „Legende bewirbt
 * eine Farbe, die das Canvas nie zeichnet" (Scout `vp-pilsting-abregeln`
 * Frage 4) ist sonst unbeobachtbar.
 */
let lastOption: any = null;
vi.mock('./useEChart', () => ({
  useEChart: (render: (chart: any, width: number) => void) => {
    lastOption = null;
    render(
      {
        getZr: () => ({ on: () => {}, off: () => {} }),
        containPixel: () => false,
        convertFromPixel: () => 0,
        setOption: (opt: any) => {
          lastOption = opt;
        },
      },
      900,
    );
    return { current: null };
  },
}));

/** Die Serie mit diesem Namen aus der zuletzt gerenderten Canvas-Option. */
function series(name: string): any {
  return (lastOption?.series ?? []).find((s: any) => s?.name === name);
}

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

describe('ScheduleChart layer switches (D4)', () => {
  it('is quiet by default: three layers, all off, no extra line in the legend', () => {
    render(
      <ScheduleChart
        plan={plan([slot({ pvKw: 4, loadKw: 1.5, measuredLoadKw: 1.2, measuredPvKw: 3.9 })])}
      />,
    );
    for (const name of ['Prognosen', 'Gemessen', 'Ladestand']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
    // The three blue lines that collided in one picture are simply not drawn.
    expect(screen.queryByText(PV_FORECAST_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(LOAD_FORECAST_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(MEASURED_PV_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ladestand des Speichers/)).not.toBeInTheDocument();
    // ...but the core statement is always there.
    expect(screen.getByText('Börsen-Strompreis')).toBeInTheDocument();
  });

  it('switches the Prognosen layer on and off again', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: 1.5 })])} />);
    const btn = () => screen.getByRole('button', { name: /Prognosen/ });
    fireEvent.click(btn());
    expect(btn()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(PV_FORECAST_LABEL)).toBeInTheDocument();
    expect(screen.getByText(LOAD_FORECAST_LABEL)).toBeInTheDocument();
    fireEvent.click(btn());
    expect(screen.queryByText(PV_FORECAST_LABEL)).not.toBeInTheDocument();
  });

  it('layers are independent of each other', () => {
    render(
      <ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: 1.5, measuredLoadKw: 1.2 })])} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Gemessen/ }));
    expect(screen.getByText(MEASURED_LOAD_LABEL)).toBeInTheDocument();
    // ...the forecast layer stayed off.
    expect(screen.getByRole('button', { name: /Prognosen/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByText(LOAD_FORECAST_LABEL)).not.toBeInTheDocument();
  });

  it('never advertises a line the run does not carry', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 4, loadKw: null })])} />);
    fireEvent.click(screen.getByRole('button', { name: /Prognosen/ }));
    expect(screen.getByText(PV_FORECAST_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(LOAD_FORECAST_LABEL)).not.toBeInTheDocument();
  });

  it('offers no switch for a layer the run cannot fill', () => {
    // A pre-feature plan: no forecast, no measurement - only the SoC exists.
    render(<ScheduleChart plan={plan([slot({})])} />);
    expect(screen.queryByRole('button', { name: /Prognosen/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gemessen/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Ladestand/ })).toBeInTheDocument();
  });

  it('draws the Ladestand only once its layer is switched on', () => {
    render(<ScheduleChart plan={plan([slot({ socPct: 62 })])} />);
    expect(screen.queryByText(/Ladestand des Speichers/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Ladestand/ }));
    expect(screen.getByText(/Ladestand des Speichers/)).toBeInTheDocument();
  });

  it('offers no Ladestand switch on a plan without SoC', () => {
    render(<ScheduleChart plan={plan([slot({ socPct: null })])} />);
    expect(screen.queryByRole('button', { name: /Ladestand/ })).toBeNull();
  });
});

/**
 * P3 "Ist-Last sichtbar": the measured consumption is a row of its own, right
 * next to its forecast, and it is honest about being absent - now inside the
 * "Gemessen" layer, so the honesty note only speaks while that layer is on.
 */
describe('ScheduleChart Ist-Last line', () => {
  it('renders the measured consumption inside the Gemessen layer', () => {
    render(<ScheduleChart plan={plan([slot({ loadKw: 4.33, measuredLoadKw: 7.117 })])} />);
    fireEvent.click(screen.getByRole('button', { name: /Gemessen/ }));
    expect(screen.getByText(MEASURED_LOAD_LABEL)).toBeInTheDocument();
  });

  it('names the reason instead of drawing a 0-line when past slots were not measured', () => {
    // The plan's slot is an hour in the past, so a measurement is expected.
    const past = new Date(Date.now() - 3600_000).toISOString();
    render(<ScheduleChart plan={plan([slot({ start: past, loadKw: 4.33 })])} />);
    // Nothing was measured at all, so there is no "Gemessen" switch - and THAT
    // absence is what the note explains.
    expect(screen.queryByRole('button', { name: /Gemessen/ })).toBeNull();
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
    expect(screen.getByText(/keine Messwerte des Verbrauchs/)).toBeInTheDocument();
  });

  it('stays silent on a plan that is still entirely ahead', () => {
    const ahead = new Date(Date.now() + 3600_000).toISOString();
    render(<ScheduleChart plan={plan([slot({ start: ahead, loadKw: 4.33 })])} />);
    expect(screen.queryByText(MEASURED_LOAD_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByText(/keine Messwerte des Verbrauchs/)).not.toBeInTheDocument();
  });

  it('says nothing about a missing measurement while the layer exists but is off', () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    render(
      <ScheduleChart
        plan={plan([
          slot({ start: past, pvKw: 9, loadKw: 4.33, measuredPvKw: 8.1 }),
        ])}
      />,
    );
    // The layer CAN be switched on (the PV twin is there), but nobody asked -
    // so the missing consumption twin is not news yet.
    expect(screen.getByRole('button', { name: /Gemessen/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByText(/keine Messwerte des Verbrauchs/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Gemessen/ }));
    expect(screen.getByText(/keine Messwerte des Verbrauchs/)).toBeInTheDocument();
  });
});

/**
 * The Ist-PV mirror: same convention as its load twin (gepunktet = Prognose,
 * durchgezogen = gemessen) inside the same "Gemessen" layer.
 */
describe('ScheduleChart PV (gemessen) line', () => {
  const past = () => new Date(Date.now() - 3600_000).toISOString();

  it('renders the measured PV inside the Gemessen layer', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 12, measuredPvKw: 15.3 })])} />);
    fireEvent.click(screen.getByRole('button', { name: /Gemessen/ }));
    expect(screen.getByText(MEASURED_PV_LABEL)).toBeInTheDocument();
  });

  it('shows only the measured lines the run really carries', () => {
    render(
      <ScheduleChart plan={plan([slot({ pvKw: 12, loadKw: 4.33, measuredPvKw: 15.3 })])} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Gemessen/ }));
    expect(screen.getByText(MEASURED_PV_LABEL)).toBeInTheDocument();
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

  it('offers no Gemessen layer at all when the backend serves no measured field', () => {
    render(<ScheduleChart plan={plan([slot({ pvKw: 12, loadKw: 1.5 })])} />);
    expect(screen.queryByRole('button', { name: /Gemessen/ })).toBeNull();
    expect(screen.queryByText(MEASURED_PV_LABEL)).not.toBeInTheDocument();
  });
});

/**
 * Fix 2 der Pilsting-Analyse (Scout `vp-pilsting-abregeln` Frage 4): die
 * Legende bewarb Orange, das Canvas zeigte es nie. Band, Sockel-Ticks, Fläche
 * und Legenden-Zeile hängen jetzt an DEMSELBEN `hasCurtailment`-Gate - die
 * Canvas-Geometrie ist in `schedule.ts` unit-getestet, hier steht die Zeile,
 * die der Kunde sieht.
 */
describe('ScheduleChart Abregeln-Legende', () => {
  it('bewirbt Orange nur, wenn der Plan wirklich abregelt', () => {
    render(<ScheduleChart plan={plan([slot({ curtailKw: 4.2, pvKw: 12 })])} />);
    expect(screen.getByText(CURTAIL_LEGEND_LABEL)).toBeInTheDocument();
  });

  it('zeigt die Zeile nicht auf einem Plan ohne Abregelung', () => {
    render(<ScheduleChart plan={plan([slot({ curtailKw: null, pvKw: 12 })])} />);
    expect(screen.queryByText(CURTAIL_LEGEND_LABEL)).not.toBeInTheDocument();
  });

  it('spricht im Plan-Wortlaut und behauptet keine Ausführung', () => {
    render(<ScheduleChart plan={plan([slot({ curtailKw: 4.2, pvKw: 12 })])} />);
    const row = screen.getByText(CURTAIL_LEGEND_LABEL);
    expect(row.textContent).toContain('geplant');
    // Die Farbe steht als Band/Fläche am Canvas, nicht als Balken.
    expect(row.parentElement?.querySelector('.vp-swatch-area')).not.toBeNull();
    expect(row.parentElement?.querySelector('.vp-swatch-bar')).toBeNull();
  });

  it('zeichnet Band UND Sockel-Tick auf dem Canvas - nicht nur in der Legende', () => {
    render(
      <ScheduleChart
        plan={plan([
          slot({ curtailKw: null, pvKw: 12 }),
          slot({ curtailKw: 4.2, pvKw: 12, batteryKw: 0 }),
        ])}
      />,
    );
    // Das Band reitet auf der Preis-Reihe (die Batterie-Reihe trägt schon die
    // Vergangenheits-markArea) und ist auf den Nachbarn verbreitert, weil eine
    // Ein-Slot-Spanne auf der Kategorie-Achse null Pixel breit wäre.
    expect(series('Börsenpreis').markArea.data).toEqual([[{ xAxis: 0 }, { xAxis: 1 }]]);
    // Der Tick markiert GENAU den abregelnden Slot - und der Balken daneben ist
    // 0 kW hoch, trägt die Aussage also nicht.
    expect(series('Abregeln').data).toEqual([null, 0]);
  });

  it('zeichnet gar kein Orange, wenn der Plan nicht abregelt', () => {
    render(<ScheduleChart plan={plan([slot({ curtailKw: null, pvKw: 12 })])} />);
    expect(series('Börsenpreis').markArea).toBeUndefined();
    expect(series('Abregeln')).toBeUndefined();
    expect(series('Gedrosselte Menge')).toBeUndefined();
  });

  it('zeigt die gedrosselte Menge erst in der zugeschalteten Prognosen-Ebene', () => {
    render(<ScheduleChart plan={plan([slot({ curtailKw: 4, pvKw: 10 })])} />);
    expect(series('Gedrosselte Menge')).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: /Prognosen/ }));
    expect(series('Einspeise-Cap').data).toEqual([6]);
    expect(series('Gedrosselte Menge').data).toEqual([4]);
  });
});
