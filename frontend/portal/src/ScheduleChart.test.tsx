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
import { BAR, FILL, NOW, STROKE } from './chartStyle';
import { chartTheme } from './chartTheme';

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

describe('ScheduleChart consumer layers (Verbrauchssteuerung §14.11)', () => {
  const layers = [
    {
      entityId: 'e-1',
      name: 'Stallpumpe',
      values: [2.2, 0],
      pflicht: [true, false],
      reasons: ['fixed_window', null],
    },
  ];
  const twoSlots = [
    slot({ start: '2026-07-29T10:00:00Z' }),
    slot({ start: '2026-07-29T10:15:00Z' }),
  ];

  it('without consumers the chart is byte-identical (no series, no legend row)', () => {
    render(<ScheduleChart plan={plan(twoSlots)} />);
    expect(series('Verbraucher · Stallpumpe')).toBeUndefined();
    expect(series('Pflichtfenster')).toBeUndefined();
    expect(screen.queryByText('Stallpumpe')).toBeNull();
    expect(screen.queryByText(/Pflichtfenster/)).toBeNull();
  });

  it('with consumers it stacks positive areas, marks Pflicht slots with the lock series and advertises both in the legend', () => {
    render(<ScheduleChart plan={plan(twoSlots)} consumers={layers} />);
    const s = series('Verbraucher · Stallpumpe');
    expect(s).toBeDefined();
    expect(s.stack).toBe('vp-verbraucher');
    expect(s.data).toEqual([2.2, 0]);
    expect(s.areaStyle).toBeDefined();
    // Lock markers: only the Pflicht slot, at the top of the stack.
    const lock = series('Pflichtfenster');
    expect(lock.data).toEqual([[0, 2.2]]);
    expect(String(lock.symbol)).toMatch(/^path:\/\//);
    // Legend carries the consumer name AND the lock explainer (word, not colour).
    expect(screen.getByText('Stallpumpe')).toBeInTheDocument();
    expect(screen.getByText(/Schloss = Pflichtfenster/)).toBeInTheDocument();
  });

  it('a consumer layer with no aligned value draws nothing', () => {
    render(
      <ScheduleChart
        plan={plan(twoSlots)}
        consumers={[{ ...layers[0], values: [null, null], pflicht: [false, false], reasons: [null, null] }]}
      />,
    );
    expect(series('Verbraucher · Stallpumpe')).toBeUndefined();
    expect(screen.queryByText('Stallpumpe')).toBeNull();
  });
});

/**
 * Die GEOMETRIE der Stufe 1 am echten `setOption`-Objekt. Sie ist eine REGEL
 * (`chartStyle.ts`), keine Sammlung freier Zahlen — geprüft wird deshalb
 * gegen die Konstanten, nicht gegen Literale: wer eine Stufe bewusst
 * nachjustiert, ändert sie an EINER Stelle, wer die Regel aufhebt, wird rot.
 */
describe('ScheduleChart · die Geometrie der Chart-Sprache', () => {
  const tag: ScheduleSlot[] = Array.from({ length: 8 }, (_, i) =>
    slot({
      start: `2026-07-29T${String(6 + i).padStart(2, '0')}:00:00Z`,
      batteryKw: i < 4 ? 3 : -3,
      pvKw: 5,
      loadKw: 2,
      socPct: 40 + i,
    }),
  );

  it('rahmt die Daten nicht ein: keine Achslinie, keine Ticks (F4)', () => {
    render(<ScheduleChart plan={plan(tag)} />);
    expect(lastOption.xAxis.axisLine.show).toBe(false);
    expect(lastOption.xAxis.axisTick.show).toBe(false);
    expect(lastOption.yAxis[0].axisLine.show).toBe(false);
    expect(lastOption.yAxis[0].axisTick.show).toBe(false);
  });

  it('deckelt die Balkenbreite und lässt eine Fuge (F9)', () => {
    render(<ScheduleChart plan={plan(tag)} />);
    const bars = series('Batterie');
    expect(bars.barMaxWidth).toBe(BAR.maxWidth);
    expect(bars.barCategoryGap).toBe(BAR.categoryGap);
  });

  it('zieht die Preislinie auf die KONTEXT-Stufe (F1-Hierarchie)', () => {
    render(<ScheduleChart plan={plan(tag)} />);
    expect(series('Börsenpreis').lineStyle.width).toBe(STROKE.context);
  });

  it('malt die Jetzt-Linie in INK, dünn und gestrichelt - nie in einer Serienfarbe (F5)', () => {
    // Ein Plan, der JETZT enthält, damit die Marke wirklich gezeichnet wird.
    const jetzt = new Date();
    const laufend: ScheduleSlot[] = Array.from({ length: 8 }, (_, i) =>
      slot({
        start: new Date(jetzt.getTime() + (i - 4) * 15 * 60_000).toISOString(),
        batteryKw: 2,
      }),
    );
    render(<ScheduleChart plan={plan(laufend)} />);
    const marks = series('Batterie').markLine.data;
    const now = marks.find((m: any) => m.label?.formatter === 'Jetzt');
    expect(now.lineStyle.width).toBe(STROKE.ref);
    expect(now.lineStyle.type).toEqual(NOW.dash);
    expect(now.lineStyle.opacity).toBe(NOW.inkOpacity);
    // Die Kanten-Falle: ein innenliegendes Label rendert sonst GEDREHT.
    expect(now.label.rotate).toBe(0);
  });

  it('malt den Speicher in EINER Farbe und trennt Laden/Abgeben über die Form (K5)', () => {
    render(<ScheduleChart plan={plan(tag)} />);
    const t = chartTheme();
    const daten = series('Batterie').data;
    // ⚠ Der Stil hängt am DATENELEMENT, nicht als Callback an der Serie:
    // ECharts wertet auf `series.itemStyle` nur einen Teil der Felder als
    // Funktion aus (`borderWidth` NICHT), und die Serie zeichnet dann GAR
    // NICHTS - im Browser aufgefallen, nicht hier. Der Test prüft deshalb
    // ausdrücklich die Per-Item-Form.
    const laden = daten[0];
    const abgeben = daten[4];
    expect(laden.value).toBeGreaterThan(0);
    expect(abgeben.value).toBeLessThan(0);
    // Laden: gefüllt. Abgeben: derselbe Ton als RAND, Füllung = Kartengrund.
    expect(laden.itemStyle.color).toBe(t.charge);
    expect(laden.itemStyle.borderWidth).toBe(0);
    expect(abgeben.itemStyle.color).toBe(t.surface);
    expect(abgeben.itemStyle.borderColor).toBe(t.charge);
    expect(abgeben.itemStyle.borderWidth).toBeGreaterThan(0);
    // Und die Serie trägt KEINEN Callback mehr, der sie unsichtbar machen würde.
    expect(typeof series('Batterie').itemStyle?.borderWidth).not.toBe('function');
  });

  it('lässt einen fehlenden Wert eine LÜCKE bleiben, nie eine 0 (Ehrlichkeitsregel)', () => {
    const mitLuecke = [...tag];
    mitLuecke[2] = slot({ start: mitLuecke[2].start, batteryKw: null });
    render(<ScheduleChart plan={plan(mitLuecke)} />);
    expect(series('Batterie').data[2]).toBeNull();
  });

  it('schattiert die Vergangenheit nur als Hauch (F5/FILL.past)', () => {
    const jetzt = new Date();
    const laufend: ScheduleSlot[] = Array.from({ length: 8 }, (_, i) =>
      slot({ start: new Date(jetzt.getTime() + (i - 4) * 15 * 60_000).toISOString() }),
    );
    render(<ScheduleChart plan={plan(laufend)} />);
    expect(series('Batterie').markArea.itemStyle.opacity).toBe(FILL.past);
  });

  it('trägt die Kernaussage als Satz - aber nur mit bekannter Veräußerungsform (K1)', () => {
    // Ein Plan von HEUTE, sonst hat die Kernaussage nichts zu sagen.
    const heute = (h: number) => {
      const d = new Date();
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    const heutePlan: ScheduleSlot[] = [
      slot({ start: heute(12), batteryKw: 4, gridKw: 1, costEur: 0.1, baselineCostEur: 0.6 }),
      slot({ start: heute(19), batteryKw: -4, gridKw: -1, costEur: 0.2, baselineCostEur: 0.9 }),
    ];
    const { rerender } = render(<ScheduleChart plan={plan(heutePlan)} />);
    // OHNE plantKind: kein Satz. Eine DV-Anlage mit „nutzen" zu beschreiben
    // wäre ein falsch abgeleiteter Satz - schlimmer als keiner (r2 §10).
    expect(document.querySelector('.vp-chart-kern')).toBeNull();
    rerender(<ScheduleChart plan={plan(heutePlan)} plantKind="direktvermarktung" />);
    const kopf = document.querySelector('.vp-chart-kern');
    expect(kopf).not.toBeNull();
    expect(kopf!.textContent).toContain('verkaufen');
    // K8: keine Zahl ohne Vergleichsanker.
    expect(kopf!.textContent).toContain('Ohne Speicher');
  });

  it('sagt ohne Fahrplan für heute den ehrlichen GRUND statt eines Satzes (K1)', () => {
    // `tag` liegt in der Vergangenheit - es gibt für heute nichts zu sagen.
    render(<ScheduleChart plan={plan(tag)} plantKind="eigenverbrauch" />);
    const kopf = document.querySelector('.vp-chart-kern');
    expect(kopf).not.toBeNull();
    expect(kopf!.textContent).toBe('Für heute liegt noch kein Fahrplan vor.');
    expect(kopf!.className).toContain('is-grund');
  });
});
