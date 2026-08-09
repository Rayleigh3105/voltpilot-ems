import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { PriceHistoryChart } from './PriceHistoryChart';
import type { PriceBucket, PriceHistory } from './api';

/**
 * Das Canvas gehoert ECharts (jsdom hat keins), also faengt der Mock die
 * Render-Closure ab und liest ihre `setOption`-Option UND ihre
 * Abhaengigkeiten aus.
 *
 * Die Abhaengigkeiten sind hier der Punkt: `useEChart` fuehrt die Closure NUR
 * bei einer Aenderung darin erneut aus. Stand `fokus` nicht darin, wechselten
 * Etikett und Sprung-Chip - und das Diagramm behielt sein altes Fenster. Genau
 * so ist es im Browser aufgefallen (gleicher Canvas-Hash in beiden
 * Zustaenden), und ein Test, der nur die Option prueft, haette es NICHT
 * gesehen.
 */
let lastOption: any = null;
let lastDeps: unknown[] = [];
vi.mock('./useEChart', () => ({
  useEChart: (renderFn: (chart: any, width: number) => void, deps: unknown[]) => {
    lastOption = null;
    lastDeps = deps;
    renderFn(
      {
        getZr: () => ({ on: () => {}, off: () => {} }),
        containPixel: () => false,
        convertFromPixel: () => 0,
        setOption: (opt: any) => {
          lastOption = opt;
        },
      },
      360,
    );
    return { current: null };
  },
}));

/** 48 h ab lokaler Mitternacht - die Tagesgrenze liegt exakt bei Index 96. */
function zweiTage(): PriceBucket[] {
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  return Array.from({ length: 192 }, (_, i) => {
    const p = 40 + (i % 96);
    return {
      ts: new Date(d0.getTime() + i * 15 * 60_000).toISOString(),
      avgEurMwh: p,
      minEurMwh: p - 2,
      maxEurMwh: p + 2,
    };
  });
}

function historie(buckets: PriceBucket[], bucket = 'PT15M'): PriceHistory {
  return {
    biddingZone: 'DE-LU',
    currency: 'EUR',
    bucket,
    from: buckets[0].ts,
    to: buckets[buckets.length - 1].ts,
    buckets,
    summary: {
      avgEurMwh: 76,
      minEurMwh: 40,
      maxEurMwh: 135,
      cheapestTs: buckets[0].ts,
      mostExpensiveTs: buckets[buckets.length - 1].ts,
      count: buckets.length,
      coverageStart: buckets[0].ts,
      coverageEnd: buckets[buckets.length - 1].ts,
    },
  };
}

describe('PriceHistoryChart - der Telefon-Fokus', () => {
  it('haelt `fokus` in den Abhaengigkeiten, sonst wirkt der Sprung nie', () => {
    const h = historie(zweiTage());
    render(<PriceHistoryChart history={h} fokus="heute" />);
    expect(lastDeps).toContain('heute');

    render(<PriceHistoryChart history={h} fokus="morgen" />);
    expect(lastDeps).toContain('morgen');
  });

  it('schneidet das Fenster auf den gewaehlten Tag', () => {
    const h = historie(zweiTage());
    render(<PriceHistoryChart history={h} fokus="heute" />);
    expect(lastOption.dataZoom?.[0]).toMatchObject({ startValue: 0, endValue: 95 });

    render(<PriceHistoryChart history={h} fokus="morgen" />);
    expect(lastOption.dataZoom?.[0]).toMatchObject({ startValue: 96, endValue: 191 });
  });

  it('faengt am Telefon KEINE Wischgeste ab - das Fenster ist rein programmatisch', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus="heute" />);
    expect(lastOption.dataZoom[0]).toMatchObject({
      zoomLock: true,
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
      zoomOnMouseWheel: false,
      zoomOnTouch: false,
    });
  });

  it('spricht am Telefon ct/kWh - eine Botschaft, eine Einheit', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus="heute" />);
    expect(lastOption.yAxis.name).toBe('ct/kWh');
    // Die WERTE bleiben EUR/MWh, nur die Beschriftung rechnet um.
    expect(lastOption.yAxis.axisLabel.formatter(150)).toBe('15');
  });

  it('macht die Tagesgrenze sichtbar: Strich MIT Flaeche, ungedreht beschriftet', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus={null} />);
    const s = lastOption.series[0];
    expect(s.markLine.data[0]).toEqual({ xAxis: 96 });
    expect(s.markLine.label.rotate).toBe(0);
    expect(s.markArea.data[0][0]).toEqual({ xAxis: 96 });
  });

  it('ist am Rechner byte-gleich wie vorher: EUR/MWh, kein Fenster', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} />);
    expect(lastOption.yAxis.name).toBe('EUR/MWh');
    expect(lastOption.yAxis.axisLabel.formatter).toBeUndefined();
    expect(lastOption.dataZoom).toBeUndefined();
  });

  it('setzt ohne Folgetag kein Fenster und keine Grenze', () => {
    const einTag = zweiTage().slice(0, 96);
    render(<PriceHistoryChart history={historie(einTag)} fokus="heute" />);
    expect(lastOption.dataZoom).toBeUndefined();
    expect(lastOption.series[0].markLine).toBeUndefined();
    expect(lastOption.series[0].markArea).toBeUndefined();
  });

  it('laesst den Rueckblick (Woche/Monat/Jahr) unberuehrt', () => {
    const tage = Array.from({ length: 30 }, (_, i) => ({
      ts: new Date(Date.now() - (29 - i) * 86400_000).toISOString(),
      avgEurMwh: 70 + i,
      minEurMwh: 60 + i,
      maxEurMwh: 90 + i,
    }));
    render(<PriceHistoryChart history={historie(tage, 'P1D')} fokus="heute" />);
    expect(lastOption.yAxis.name).toBe('EUR/MWh');
    expect(lastOption.dataZoom).toBeUndefined();
  });
});
