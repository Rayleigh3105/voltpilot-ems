import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **E7 · am Telefon zieht niemand einen Ausschnitt** (Captain-Entscheid
 * 03.09.2026, wörtlich: „a) Tooltip + Legenden-Schalter, KEIN Zoom durch Ziehen
 * am Telefon"; Paket P4, der Zwilling von `historyChartZoom.test.tsx`).
 *
 * ⚠ **Der Reiter „Marktpreise" ist der Grenzfall des Entscheids:** seine Kurve
 *   trägt am Telefon SEHR WOHL einen `dataZoom` — er ist aber der FOKUS-
 *   Ausschnitt (Heute/Morgen), keine Geste. Was der Entscheid verbietet, ist
 *   das ZIEHEN, und das steht in den Flags: `zoomLock`, kein Verschieben per
 *   Maus/Rad, kein Zoomen per Rad/Touch. Ohne diesen Test wäre ein
 *   versehentlich entferntes Flag im Browser nur an einer Geste zu merken, die
 *   niemand mehr prüft.
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
      900,
    );
    return { current: null };
  },
}));

import { PriceHistoryChart } from './PriceHistoryChart';
import type { PriceBucket, PriceHistory } from './api';

/** Zwei lokale Tage in Viertelstunden — die Reihe MIT Tagesgrenze. */
function zweiTage(): PriceBucket[] {
  const mitternacht = new Date(2026, 8, 3, 0, 0, 0, 0);
  return Array.from({ length: 192 }, (_, i) => {
    const p = i >= 47 && i <= 61 ? -20 : 60;
    return {
      ts: new Date(mitternacht.getTime() + i * 15 * 60_000).toISOString(),
      avgEurMwh: p,
      minEurMwh: p,
      maxEurMwh: p,
    };
  });
}

const HISTORY: PriceHistory = {
  biddingZone: 'DE-LU',
  currency: 'EUR',
  bucket: 'PT15M',
  from: zweiTage()[0].ts,
  to: zweiTage()[191].ts,
  buckets: zweiTage(),
  summary: {
    avgEurMwh: 40,
    minEurMwh: -20,
    maxEurMwh: 60,
    cheapestTs: zweiTage()[47].ts,
    mostExpensiveTs: zweiTage()[0].ts,
    count: 192,
    coverageStart: zweiTage()[0].ts,
    coverageEnd: zweiTage()[191].ts,
  },
};

describe('P4 · E7 — die Tageskurve zoomt nicht durch Ziehen', () => {
  beforeEach(() => {
    lastOption = null;
  });

  it('gibt der Kurve OHNE Fokus gar keinen dataZoom', () => {
    render(<PriceHistoryChart history={HISTORY} />);
    expect(lastOption?.dataZoom).toBeUndefined();
  });

  it('sperrt den Fokus-Ausschnitt gegen jede Geste', () => {
    render(<PriceHistoryChart history={HISTORY} fokus="heute" />);
    const zoom = (lastOption?.dataZoom ?? [])[0];
    // Nicht vakuum: der Ausschnitt IST gesetzt — er ist nur unbeweglich.
    expect(zoom?.type).toBe('inside');
    expect(zoom?.endValue).toBeGreaterThan(zoom?.startValue);
    expect(zoom?.zoomLock).toBe(true);
    expect(zoom?.moveOnMouseMove).toBe(false);
    expect(zoom?.moveOnMouseWheel).toBe(false);
    expect(zoom?.zoomOnMouseWheel).toBe(false);
    expect(zoom?.zoomOnTouch).toBe(false);
  });

  it('behält den Tooltip — er IST die Touch-Bedienung', () => {
    for (const fokus of ['heute', null] as const) {
      lastOption = null;
      render(<PriceHistoryChart history={HISTORY} fokus={fokus} />);
      expect(lastOption?.tooltip?.confine).toBe(true);
      expect(lastOption?.tooltip?.trigger).toBe('axis');
    }
  });
});
