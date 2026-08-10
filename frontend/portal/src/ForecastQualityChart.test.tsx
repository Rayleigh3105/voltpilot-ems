import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ForecastQualityChart } from './ForecastQualityChart';
import type { ForecastAccuracyPoint, ForecastModelId } from './api';
import { POLARITAET, VERBESSERUNG_WORT } from './prognose';

/**
 * Das Canvas gehoert ECharts (jsdom hat keins), also faengt der Mock die
 * Render-Closure ab und liest ihre `setOption`-Option aus. Die Breite ist
 * einstellbar, weil die Fläche seit Stufe 4 einen Responsive-Zweig hat (den
 * sie vorher gar nicht besass).
 */
let lastOption: any = null;
let renderWidth = 960;
vi.mock('./useEChart', () => ({
  useEChart: (renderFn: (chart: any, width: number) => void) => {
    lastOption = null;
    renderFn({ setOption: (opt: any) => (lastOption = opt) }, renderWidth);
    return { current: null };
  },
}));

const AKTIV: ForecastModelId = 'load-persistence';
const KANDIDAT: ForecastModelId = 'load-xgb';
const LABELS: Record<string, string> = {
  [AKTIV]: 'Persistenz (aktiv)',
  [KANDIDAT]: 'Lernender Kandidat',
};

function punkt(
  day: string,
  model: ForecastModelId,
  maeKw: number,
): ForecastAccuracyPoint {
  return { day, model, kind: 'load', maeKw, nmaePct: null, biasKw: null, skillVsBaseline: 0.2, nSlots: 96 };
}

/** Fünf Tage, an denen der Kandidat durchweg näher lag. */
function reihe(): ForecastAccuracyPoint[] {
  const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];
  return [
    ...days.map((d, i) => punkt(d, AKTIV, 0.7 + i * 0.02)),
    ...days.map((d, i) => punkt(d, KANDIDAT, 0.5 + i * 0.02)),
  ];
}

function serie(name: string): any {
  return (lastOption.series as any[]).find((s) => s.name === name);
}
/** Jede Beschriftung, die die Option ins Bild schreibt. */
function texte(): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      if (typeof v.formatter === 'string') out.push(v.formatter);
      if (typeof v.name === 'string') out.push(v.name);
      Object.values(v).forEach(walk);
    }
  };
  walk(lastOption);
  return out;
}

describe('ForecastQualityChart (Stufe 4)', () => {
  it('erklaert die POLARITAET im Bild - innen, damit sie die Flaeche nie verlaesst', () => {
    render(
      <ForecastQualityChart points={reihe()} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    const ml = serie(LABELS[AKTIV]).markLine.data as any[];
    expect(ml.map((d) => d.label.formatter)).toEqual([POLARITAET.oben, POLARITAET.unten]);
    for (const d of ml) {
      expect(d.label.position).toMatch(/^inside/);
      expect(d.label.rotate).toBe(0);
      // ⚠ Eine unsichtbare markLine nimmt in ECharts ihr LABEL mit - genau
      // daran fehlte „↑ schlechter" im ersten Bau.
      expect(d.lineStyle.opacity).toBeUndefined();
      expect(d.lineStyle.color).toBeTruthy();
    }
  });

  it('benennt die Verbesserungs-Flaeche - unbenannt war sie ein Raetsel (K10)', () => {
    render(
      <ForecastQualityChart points={reihe()} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    const flaeche = serie('vorsprung');
    expect(flaeche.areaStyle.opacity).toBeGreaterThan(0);
    expect(flaeche.markPoint.data[0].label.formatter).toBe(VERBESSERUNG_WORT);
  });

  it('zeichnet KEINE Flaeche, wo der Kandidat schlechter lag', () => {
    const schlechter = reihe().map((p) =>
      p.model === KANDIDAT ? { ...p, maeKw: p.maeKw + 0.5 } : p,
    );
    render(
      <ForecastQualityChart points={schlechter} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    const flaeche = serie('vorsprung');
    expect((flaeche.data as (number | null)[]).every((v) => v == null)).toBe(true);
    expect(flaeche.markPoint).toBeUndefined();
  });

  it('macht den Kandidaten zum KONTEXT-Strich (F1-Hierarchie)', () => {
    render(
      <ForecastQualityChart points={reihe()} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    const aktiv = serie(LABELS[AKTIV]);
    const kandidat = serie(LABELS[KANDIDAT]);
    expect(aktiv.lineStyle.width).toBe(2.2);
    expect(aktiv.lineStyle.type).toBe('solid');
    expect(kandidat.lineStyle.width).toBe(1.4);
    expect(kandidat.lineStyle.type).toBe('dashed');
    // Der frühere Orange-Ton ist weg: gegen die gruene Flaeche mass er ΔE 3,6.
    expect(kandidat.lineStyle.color).not.toBe(aktiv.lineStyle.color);
    expect(kandidat.lineStyle.color?.toUpperCase()).toBe('#4B5563');
  });

  it('sagt die Einheit in Klartext - „Ø kW" liest sich als Durchschnittsleistung', () => {
    render(
      <ForecastQualityChart points={reihe()} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    expect(lastOption.yAxis.name).toBe('Kilowatt Abweichung');
    expect(texte().join(' ')).not.toMatch(/Ø kW/);
  });

  it('beschriftet die Kurven DIREKT - die Zahl steht an der Kurve, nicht im Kopf (K2)', () => {
    render(
      <ForecastQualityChart points={reihe()} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    expect(serie(LABELS[AKTIV]).endLabel.formatter()).toMatch(/^aktiv Ø ±\d+,\d+\s?kW$/);
    expect(serie(LABELS[KANDIDAT]).endLabel.formatter()).toMatch(/^Kandidat Ø ±\d+,\d+\s?kW$/);
    // Ohne Rand rechts schneidet ECharts das Etikett ab.
    expect(lastOption.grid.right).toBeGreaterThan(50);
  });

  it('hat einen Responsive-Zweig - schmal traegt die Einheit sich selbst', () => {
    renderWidth = 360;
    try {
      render(
        <ForecastQualityChart points={reihe()} modelLabels={LABELS} activeModel={AKTIV} />,
      );
    } finally {
      renderWidth = 960;
    }
    expect(lastOption.yAxis.name).toBe('kW');
    // Am Telefon ist rechts kein Platz - dann gibt es kein Etikett und keinen
    // reservierten Rand.
    expect(serie(LABELS[AKTIV]).endLabel).toBeUndefined();
    expect(lastOption.grid.right).toBeLessThan(50);
  });

  it('kommt ohne Kandidaten aus (nur das aktive Modell, keine Flaeche)', () => {
    const nurAktiv = reihe().filter((p) => p.model === AKTIV);
    render(
      <ForecastQualityChart points={nurAktiv} modelLabels={LABELS} activeModel={AKTIV} />,
    );
    expect(serie(LABELS[KANDIDAT])).toBeUndefined();
    expect(serie('vorsprung').markPoint).toBeUndefined();
  });
});
