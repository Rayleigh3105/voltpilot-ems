import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **E7 · am Telefon zieht niemand mehr einen Ausschnitt** (Captain-Entscheid
 * 03.09.2026, wörtlich: „Tooltip + Legenden-Schalter, KEIN Zoom durch Ziehen am
 * Telefon"; Paket P3).
 *
 * ⚠ **Warum ein Test und nicht nur der Browser-Beweis:** die Zoom-Konfiguration
 * lebt in der ECharts-OPTION, und die ist im Browser aus dem Canvas nicht
 * ablesbar (ECharts reist als ESM-Modul, es gibt keinen globalen Handle). Der
 * Browser zeigt die WIRKUNG (eine waagerechte Geste im Bild scrollt wieder die
 * Seite); dass die Option leer IST, steht hier.
 *
 * ⚠ Die Grenze ist die VIEWPORT-Breite (`useIsPhone`, ≤ 720 px), nicht die
 * gemessene Chart-Breite (`NARROW_PX` = 480) — zwischen 481 und 720 sagt der
 * Entscheid „Telefon", der Chart aber „breit genug für den Streifen".
 */

let lastOption: any = null;
/** Die gemessene Breite des Charts — bewusst BREIT, damit sie nicht die Rolle
 *  des Telefon-Merkmals übernimmt (der Test soll `useIsPhone` prüfen). */
const RENDER_BREITE = 900;

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
      RENDER_BREITE,
    );
    return { current: null };
  },
}));

let phone = true;
vi.mock('./useIsPhone', () => ({ useIsPhone: () => phone }));

import { HistoryEnergieChart } from './HistoryChart';
import type { History } from './api';

const HISTORY: History = {
  range: 'day',
  from: '2026-09-03T00:00:00Z',
  to: '2026-09-04T00:00:00Z',
  resolutionMinutes: 15,
  buckets: [
    { bucket: '2026-09-03T09:00:00Z', pvKwh: 4, loadKwh: 2, gridImportKwh: 0, gridExportKwh: 2 },
    { bucket: '2026-09-03T10:00:00Z', pvKwh: 6, loadKwh: 3, gridImportKwh: 0, gridExportKwh: 3 },
  ] as History['buckets'],
  totals: {} as History['totals'],
};

function zoomArten(): string[] {
  return ((lastOption?.dataZoom ?? []) as Array<{ type: string }>).map((z) => z.type);
}

describe('P3 · E7 — der Zoom durch Ziehen gehört dem Rechner', () => {
  beforeEach(() => {
    lastOption = null;
  });

  it('gibt dem Telefon GAR KEINEN dataZoom — auch bei breitem Chart', () => {
    phone = true;
    render(<HistoryEnergieChart history={HISTORY} />);
    expect(zoomArten()).toEqual([]);
  });

  it('lässt dem Rechner den Streifen UND das Zoomen im Bild', () => {
    phone = false;
    render(<HistoryEnergieChart history={HISTORY} />);
    // Nicht vakuum: derselbe Aufbau, nur die andere Breiten-Antwort.
    expect(zoomArten()).toContain('slider');
    expect(zoomArten()).toContain('inside');
  });

  it('behält den Tooltip auf JEDER Breite — er ist die Touch-Bedienung', () => {
    for (const p of [true, false]) {
      phone = p;
      lastOption = null;
      render(<HistoryEnergieChart history={HISTORY} />);
      expect(lastOption?.tooltip?.confine).toBe(true);
      expect(lastOption?.tooltip?.trigger).toBe('axis');
    }
  });
});
