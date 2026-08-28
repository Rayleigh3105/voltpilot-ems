import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OptimizerPlanChart } from './OptimizerPlanChart';
import { chartTheme } from '../../chartTheme';
import type { OptimizerDiagnostics, OptimizerSlot } from '../../optimizerApi';

/**
 * Wie beim Kunden-Fahrplan: der Mock RECHNET die Render-Closure aus und fängt
 * ihr `setOption`-Objekt ab. Die Panel-Struktur und die aufgelöste
 * Farb-Doppelbelegung sind ausschließlich hier beobachtbar.
 */
let lastOption: any = null;
vi.mock('../../useEChart', () => ({
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

function serie(name: string): any {
  return (lastOption?.series ?? []).find((s: any) => s?.name === name);
}

function slot(over: Partial<OptimizerSlot> = {}): OptimizerSlot {
  return {
    time: '2026-08-10T10:00:00Z',
    batteryKw: 4,
    gridKw: 2,
    socPct: 60,
    loadKw: 1,
    pvKw: 6,
    curtailKw: 0,
    costEur: 0.1,
    baselineCostEur: 0.2,
    wearCostEur: 0.01,
    solverPriceCtKwh: 8,
    importPriceCtKwh: 32.5,
    exportValueCtKwh: 6.5,
    wearCostCtKwh: 0.4,
    valueOfStoredEnergyCtKwh: 21.5,
    decisionLabel: 'solarladen',
    whyText: null,
    ...over,
  };
}

function diag(slots: OptimizerSlot[]): OptimizerDiagnostics {
  return {
    siteId: 's-1',
    planId: 'p-1',
    generatedAt: '2026-08-10T09:45:00Z',
    slotMinutes: 15,
    availableRuns: [],
    availableRunsDate: null,
    firstRunDate: null,
    lastRunDate: null,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'fest',
    tarifParamCtKwh: 32.5,
    anzulegenderWertCtKwh: null,
    backupReserveSocPct: null,
    battery: null,
    activeLoadModel: 'load-persistence',
    activePvModel: 'pv-physical',
    priceSource: 'fest',
    storedEnergyValueIsApproximation: false,
    slots,
  };
}

const tag = [
  slot({ time: '2026-08-10T10:00:00Z', batteryKw: 4 }),
  slot({ time: '2026-08-10T10:15:00Z', batteryKw: -3, gridKw: -2 }),
  slot({ time: '2026-08-10T10:30:00Z', batteryKw: 2, gridKw: 3, pvKw: 0 }),
];

function renderChart(d = diag(tag), selected = 1) {
  return render(<OptimizerPlanChart diag={d} selectedIdx={selected} onSelectSlot={() => {}} />);
}

describe('Admin-PlanChart · zwei Panels über EINER Zeitachse (F8 verschärft)', () => {
  it('zeichnet ZWEI Plotflächen mit demselben linken und rechten Rand', () => {
    renderChart();
    expect(lastOption.grid).toHaveLength(2);
    expect(new Set(lastOption.grid.map((g: any) => g.left)).size).toBe(1);
    expect(new Set(lastOption.grid.map((g: any) => g.right)).size).toBe(1);
    expect(lastOption.grid.some((g: any) => g.containLabel)).toBe(false);
  });

  it('verbindet die Fadenkreuze und beschriftet die Zeitachse genau einmal', () => {
    renderChart();
    expect(lastOption.axisPointer).toEqual({ link: [{ xAxisIndex: 'all' }] });
    const beschriftet = lastOption.xAxis.filter((a: any) => a.axisLabel?.show !== false);
    expect(beschriftet).toHaveLength(1);
    expect(beschriftet[0].gridIndex).toBe(1);
  });

  it('legt die Preise nach OBEN und die Leistung nach UNTEN', () => {
    renderChart();
    const preisGrid = (lastOption.series ?? [])
      .filter((s: any) => s.name.includes('preis') || s.name.includes('Einspeisewert'))
      .map((s: any) => s.xAxisIndex);
    expect(new Set(preisGrid)).toEqual(new Set([0]));
    expect(serie('Batterie').xAxisIndex).toBe(1);
    expect(serie('Netz').xAxisIndex).toBe(1);
  });

  it('macht den Ladestand ABLESBAR statt ihn auf eine unsichtbare Achse zu legen', () => {
    renderChart();
    const socAxis = lastOption.yAxis[2];
    expect(socAxis.show).toBe(true);
    expect(socAxis.position).toBe('right');
    expect(serie('Ladestand').yAxisIndex).toBe(2);
  });

  it('lässt das Preis-Panel ohne Preisdaten auf Höhe 0 schrumpfen', () => {
    renderChart(
      diag(tag.map((s) => ({ ...s, solverPriceCtKwh: null, importPriceCtKwh: null, exportValueCtKwh: null }))),
    );
    expect(lastOption.grid[0].height).toBe(0);
    expect(lastOption.grid[0].show).toBe(false);
    // Die Serien-Indizes bleiben trotzdem stabil: es gibt schlicht keine
    // Preisreihen, statt eines zweiten Codepfads.
    expect(serie('Bezugspreis (real)')).toBeUndefined();
    expect(serie('Batterie').xAxisIndex).toBe(1);
  });
});

describe('Admin-PlanChart · die Farb-Doppelbelegung ist aufgelöst', () => {
  it('spricht in den Preislinien die Preis-Töne der Stufe 2 — nie Lade-/Entlade-Farben', () => {
    renderChart();
    const t = chartTheme();
    expect(serie('Bezugspreis (real)').lineStyle.color).toBe(t.price);
    expect(serie('Einspeisewert (real)').lineStyle.color).toBe(t.flowGridLine);
    // Der Solver-Preis ist die REFERENZ zu denselben zwei Linien: gleiche
    // Preisfarbe, Kontext-Stärke, gestrichelt.
    expect(serie('Börsenpreis (Solver)').lineStyle.color).toBe(t.price);
    expect(serie('Börsenpreis (Solver)').lineStyle.type).toBe('dashed');
    // Und keine Preislinie trägt mehr eine Balkenfarbe.
    const preisFarben = (lastOption.series ?? [])
      .filter((s: any) => s.xAxisIndex === 0)
      .map((s: any) => s.lineStyle.color);
    expect(preisFarben).not.toContain(t.charge);
    expect(preisFarben).not.toContain(t.discharge);
  });

  it('zeichnet Laden grün und Abgeben beere - beide gefüllt', () => {
    renderChart();
    const t = chartTheme();
    const bars = serie('Batterie').data;
    expect(bars[0].itemStyle.color).toBe(t.charge);
    expect(bars[1].itemStyle.color).toBe(t.battDischarge);
    expect(bars[1].itemStyle.borderWidth).toBe(0);
    // Rot ist Kosten/Warnung - eine entladende Batterie verdient Geld.
    expect(JSON.stringify(bars)).not.toContain(t.discharge);
  });

  it('färbt den Netz-Sockel neutral in BEIDE Richtungen', () => {
    renderChart();
    const t = chartTheme();
    // Vorher trug die Einspeisung dasselbe Türkis, mit dem die Balken darüber
    // „Netzladen" sagen - eine Farbe, zwei Bedeutungen.
    expect(serie('Netz').itemStyle.color).toBe(t.neutral);
    expect(serie('Netz').itemStyle.color).not.toBe(t.gridCharge);
  });

  it('nennt in der Legende jede gezeichnete Reihe mit ihrem Wort', () => {
    renderChart();
    for (const label of [
      'Bezugspreis (real)',
      'Einspeisewert (real)',
      'Börsenpreis (Solver)',
      'Speicher lädt Solarstrom',
      'Speicher gibt ab',
      'Ladestand',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('Admin-PlanChart · die Marken', () => {
  it('setzt das WORT einer Marke genau einmal, die Linie durch beide Panels', () => {
    renderChart();
    const mitWort = (lastOption.series ?? []).flatMap((s: any) =>
      (s?.markLine?.data ?? []).filter((m: any) => m?.label && m.label.show !== false),
    );
    const stumm = (lastOption.series ?? []).flatMap((s: any) =>
      (s?.markLine?.data ?? []).filter((m: any) => m?.label?.show === false),
    );
    expect(mitWort.map((m: any) => m.label.formatter)).toEqual(['Slot']);
    expect(stumm).toHaveLength(1);
    expect(mitWort[0].label.rotate).toBe(0);
  });
});
