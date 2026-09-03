import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **E7 · am Telefon zieht niemand einen Ausschnitt** (Captain-Entscheid
 * 03.09.2026, wörtlich: „Tooltip + Legenden-Schalter, KEIN Zoom durch Ziehen am
 * Telefon"; Paket P7 — das Gegenstück zu `historyChartZoom.test.tsx` aus P3).
 *
 * ⚠ **Warum ein Test und nicht nur der Browser-Beweis:** die Zoom-Konfiguration
 * lebt in der ECharts-OPTION, und die ist im Browser aus dem Canvas nicht
 * ablesbar. Der Browser zeigt die WIRKUNG (eine waagerechte Geste im Bild
 * scrollt weiter die Seite); dass die Option GAR NICHT existiert, steht hier —
 * sonst könnte sie ein späterer Griff still einführen.
 *
 * Dazu die zweite Hälfte des Entscheids: die Legende IST die Touch-Bedienung
 * (`<button aria-pressed>`), und sie steht UNTER dem Bild (V6).
 */

let lastOption: any = null;

vi.mock('./useEChart', () => ({
  useEChart: (renderFn: (chart: any, width: number) => void) => {
    lastOption = null;
    renderFn(
      {
        getZr: () => ({ on: () => {}, off: () => {} }),
        containPixel: () => false,
        convertFromPixel: () => 0,
        setOption: (opt: any) => {
          lastOption = opt;
        },
      },
      // Bewusst BREIT: der Test soll nicht am Schmal-Zweig hängen.
      900,
    );
    return { current: null };
  },
}));

import { ForecastQualityChart } from './ForecastQualityChart';
import type { ForecastAccuracyPoint } from './api';

const LABELS = {
  'load-persistence': 'Vergleichsmodell (Vortageswert)',
  'load-xgb': 'Lernendes Verbrauchsmodell',
};

const POINTS: ForecastAccuracyPoint[] = [
  { day: '2026-09-01', kind: 'load', model: 'load-persistence', maeKw: 0.9 },
  { day: '2026-09-02', kind: 'load', model: 'load-persistence', maeKw: 0.8 },
  { day: '2026-09-01', kind: 'load', model: 'load-xgb', maeKw: 0.6 },
  { day: '2026-09-02', kind: 'load', model: 'load-xgb', maeKw: 0.5 },
] as ForecastAccuracyPoint[];

function reihen(): Array<{ name: string; data: unknown[] }> {
  return ((lastOption?.series ?? []) as Array<{ name: string; data: unknown[] }>).filter((s) =>
    Object.values(LABELS).includes(s.name),
  );
}

describe('P7 · E7 — die Kurve wird getippt, nicht gezogen', () => {
  beforeEach(() => {
    lastOption = null;
  });

  it('trägt GAR KEINEN dataZoom — auf keiner Breite', () => {
    render(
      <ForecastQualityChart points={POINTS} modelLabels={LABELS} activeModel="load-persistence" />,
    );
    expect(lastOption?.dataZoom ?? []).toEqual([]);
  });

  it('behält den Tooltip mit `confine` — er IST die Touch-Bedienung', () => {
    render(
      <ForecastQualityChart points={POINTS} modelLabels={LABELS} activeModel="load-persistence" />,
    );
    expect(lastOption?.tooltip?.confine).toBe(true);
    expect(lastOption?.tooltip?.trigger).toBe('axis');
  });

  it('stellt die Legende UNTER das Bild (V6) und als Schalter', () => {
    const { container } = render(
      <ForecastQualityChart points={POINTS} modelLabels={LABELS} activeModel="load-persistence" />,
    );
    const bild = container.querySelector('.vp-chart')!;
    const legende = container.querySelector('.vp-chart-legend')!;
    expect(bild.compareDocumentPosition(legende) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Jede Reihe ist ein gedrückter Schalter, solange sie sichtbar ist.
    const schalter = screen.getAllByRole('button', { pressed: true });
    expect(schalter).toHaveLength(2);
  });

  it('blendet die getippte Reihe aus — und hält die LETZTE an', () => {
    render(
      <ForecastQualityChart points={POINTS} modelLabels={LABELS} activeModel="load-persistence" />,
    );
    // Vorher tragen beide Kurven Werte.
    expect(reihen().every((s) => s.data.some((v) => v != null))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Lernendes Verbrauchsmodell/ }));
    const kandidat = reihen().find((s) => s.name === LABELS['load-xgb'])!;
    expect(kandidat.data.every((v) => v == null)).toBe(true);
    expect(screen.getByRole('button', { name: /Lernendes Verbrauchsmodell/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // ⚠ Die letzte sichtbare Reihe bleibt an: ein leeres Bild ist keine
    //   Auskunft, und der Weg zurück wäre nicht mehr sichtbar.
    fireEvent.click(screen.getByRole('button', { name: /Vergleichsmodell/ }));
    const aktiv = reihen().find((s) => s.name === LABELS['load-persistence'])!;
    expect(aktiv.data.some((v) => v != null)).toBe(true);
  });
});
