import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
/** Die Breite, mit der der Mock rendert - schmal ist die Vorgabe (Telefon). */
let renderWidth = 360;
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
      renderWidth,
    );
    return { current: null };
  },
}));

/** Am Rechner rendern (>= 480 px) - dort steht die Groesse vor der Einheit. */
function amRechner(node: React.ReactElement) {
  renderWidth = 960;
  try {
    render(node);
  } finally {
    renderWidth = 360;
  }
}

/**
 * 48 h ab lokaler Mitternacht - die Tagesgrenze liegt exakt bei Index 96.
 * Die Kurve hat eine Gratis-Mulde (12:00-14:15) und eine Abendspitze, damit
 * die benannten Fenster und die Marken etwas zu benennen haben.
 */
function zweiTage(): PriceBucket[] {
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  return Array.from({ length: 192 }, (_, i) => {
    const h = (i % 96) / 4;
    let p = 120;
    if (h >= 12 && h < 14.5) p = -10;
    else if (h >= 18 && h < 20.5) p = 213;
    return {
      ts: new Date(d0.getTime() + i * 15 * 60_000).toISOString(),
      avgEurMwh: p,
      minEurMwh: p - 20,
      maxEurMwh: p + 20,
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

/** Alle Beschriftungen, die die Option irgendwo ins Bild schreibt. */
function alleTexte(opt: any): string[] {
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
  walk(opt.series);
  return out;
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

  it('hinterlegt am Telefon nur den GEZEIGTEN Tag', () => {
    const h = historie(zweiTage());
    render(<PriceHistoryChart history={h} fokus="morgen" />);
    const bereiche = (lastOption.series[0].markArea.data as any[]).filter(
      // die Tagesgrenzen-Toenung laeuft bis zum Reihenende, die Fenster nicht
      (b) => b[1].xAxis < 191,
    );
    expect(bereiche.length).toBeGreaterThan(0);
    for (const b of bereiche) expect(b[0].xAxis).toBeGreaterThanOrEqual(96);
  });
});

describe('PriceHistoryChart - die Preis-Grammatik (Stufe 4)', () => {
  it('zeichnet eine STUFENLINIE statt Ampel-Balken - der visualMap ist weg', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} />);
    const s = lastOption.series[0];
    expect(s.type).toBe('line');
    expect(s.step).toBe('end');
    expect(lastOption.visualMap).toBeUndefined();
  });

  it('hinterlegt ZUSAMMENHAENGENDE Fenster - EIN Block, kein Kamm', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus="heute" />);
    const bereiche = (lastOption.series[0].markArea.data as any[]).filter(
      (b) => b[1].xAxis < 191,
    );
    expect(bereiche.length).toBeGreaterThan(0);
    for (const [start, ende] of bereiche) {
      expect(ende.xAxis).toBeGreaterThan(start.xAxis);
    }
  });

  it('traegt sein WORT unter dem Bild - samt Zeitraum, nie „Viertel" (K10/K4)', () => {
    const { container } = render(
      <PriceHistoryChart history={historie(zweiTage())} fokus="heute" />,
    );
    const zeile = container.querySelector('.vp-preisfenster');
    expect(zeile).toBeTruthy();
    expect(screen.getByText(/Strom kostet nichts · \d{2}:\d{2}–\d{2}:\d{2}/)).toBeTruthy();
    expect(screen.getByText(/die teuersten 2½ Stunden · \d{2}:\d{2}–\d{2}:\d{2}/)).toBeTruthy();
    expect(zeile!.textContent ?? '').not.toMatch(/Viertel/);
    // ⚠ Die Woerter stehen NICHT als markArea-Label im Canvas: ein
    // 2½-Stunden-Band ist auf 48 Stunden ~40 px breit, sein Wort ~150 px -
    // zwei solche Etiketten ueberlappten sich prompt gegenseitig UND die
    // Datums-Beschriftung der Tagesgrenze.
    const benannt = (lastOption.series[0].markArea.data as any[]).filter(
      (b) => b[0].label?.show,
    );
    expect(benannt).toEqual([]);
    expect(alleTexte(lastOption).join(' ')).not.toMatch(/Viertel/);
  });

  it('K7: der Tooltip nennt den Preis MIT seiner Einordnung, nicht nur die Zahl', () => {
    const buckets = zweiTage();
    render(<PriceHistoryChart history={historie(buckets)} fokus="heute" />);
    // Der erste Slot INNERHALB des ersten Bandes - die Einordnung muss aus
    // DEMSELBEN Fenster kommen, das dieses Band gezeichnet hat.
    const i = (lastOption.series[0].markArea.data as any[])[0][0].xAxis as number;
    const html = String(
      lastOption.tooltip.formatter([
        { axisValue: buckets[i].ts, dataIndex: i, value: lastOption.series[0].data[i] },
      ]),
    );
    expect(html).toMatch(/ ct\/kWh \(.+\) — (die günstigsten|die teuersten|Strom kostet nichts)$/);
  });

  it('K7: behauptet ohne Fenster KEINE Einordnung', () => {
    // Ein flacher Tag traegt per MIN_SPANNE_CT keine Fenster - dann steht dort
    // nur der Preis, nie eine erfundene Einordnung.
    const d0 = new Date();
    d0.setHours(0, 0, 0, 0);
    const flach: PriceBucket[] = Array.from({ length: 96 }, (_, i) => ({
      ts: new Date(d0.getTime() + i * 15 * 60_000).toISOString(),
      avgEurMwh: 100,
      minEurMwh: 100,
      maxEurMwh: 100,
    }));
    render(<PriceHistoryChart history={historie(flach)} />);
    expect(lastOption.series[0].markArea.data).toEqual([]);
    const html = String(
      lastOption.tooltip.formatter([{ axisValue: flach[10].ts, dataIndex: 10, value: 10 }]),
    );
    expect(html).toContain('ct/kWh');
    expect(html).not.toContain('—');
  });

  it('setzt hoechstens zwei benannte Marken - je mit Wort UND Zahl', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus="heute" />);
    const mp = lastOption.series[0].markPoint.data as any[];
    expect(mp).toHaveLength(2);
    expect(mp.map((m) => m.name)).toEqual(['gratis · -1,0 ct', 'Hoch 21,3 ct']);
    for (const m of mp) expect(m.label.show).toBe(true);
  });

  it('beschriftet die Tagesgrenze mit dem DATUM, nicht mit „Morgen" (F6)', () => {
    const b = zweiTage();
    render(<PriceHistoryChart history={historie(b)} />);
    const grenze = (lastOption.series[0].markLine.data as any[]).find(
      (d) => d.xAxis === 96,
    );
    expect(grenze).toBeTruthy();
    expect(grenze.label.rotate).toBe(0);
    expect(grenze.label.formatter).not.toBe('Morgen');
    expect(grenze.label.formatter).toMatch(/\d{2}\.\d{2}\./);
    // Die Linie ist durchgezogener FAKT - die Kurve wird nie gepunktet.
    expect(lastOption.series[0].lineStyle.type).toBeUndefined();
  });

  it('betont die Nulllinie nur, wo es wirklich unter Null geht', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus="heute" />);
    expect(
      (lastOption.series[0].markLine.data as any[]).some((d) => d.yAxis === 0),
    ).toBe(true);

    const ohneNegativ = zweiTage().map((b) => ({ ...b, avgEurMwh: Math.abs(b.avgEurMwh) }));
    render(<PriceHistoryChart history={historie(ohneNegativ)} fokus="heute" />);
    expect(
      (lastOption.series[0].markLine.data as any[]).some((d) => d.yAxis === 0),
    ).toBe(false);
  });

  it('spricht ct/kWh - am Telefon die Einheit allein, am Rechner mit ihrer Groesse', () => {
    render(<PriceHistoryChart history={historie(zweiTage())} fokus="heute" />);
    expect(lastOption.yAxis.name).toBe('ct/kWh');

    amRechner(<PriceHistoryChart history={historie(zweiTage())} />);
    expect(lastOption.yAxis.name).toBe('Preis (ct/kWh)');
    // Die WERTE sind jetzt ct/kWh - kein Umrechnungs-Formatter mehr noetig.
    expect(lastOption.yAxis.axisLabel.formatter).toBeUndefined();
    expect(lastOption.series[0].data[0]).toBe(12);
  });

  it('setzt ohne Folgetag kein Fenster und keine Grenze', () => {
    const einTag = zweiTage().slice(0, 96);
    render(<PriceHistoryChart history={historie(einTag)} fokus="heute" />);
    expect(lastOption.dataZoom).toBeUndefined();
    expect(
      (lastOption.series[0].markLine.data as any[]).some((d) => d.xAxis != null),
    ).toBe(false);
  });

  it('benennt auf einer FLACHEN Kurve gar kein Fenster', () => {
    const flach = zweiTage().map((b) => ({ ...b, avgEurMwh: 120 }));
    const { container } = render(<PriceHistoryChart history={historie(flach)} fokus="heute" />);
    expect(container.querySelector('.vp-preisfenster')).toBeNull();
    // Nur die Tagesgrenzen-Toenung bleibt.
    expect(lastOption.series[0].markArea.data).toHaveLength(1);
  });
});

describe('PriceHistoryChart - der Rueckblick (Woche/Monat/Jahr)', () => {
  const tage = Array.from({ length: 30 }, (_, i) => ({
    ts: new Date(Date.now() - (29 - i) * 86400_000).toISOString(),
    avgEurMwh: 700 + i * 10,
    minEurMwh: 600 + i * 10,
    maxEurMwh: 900 + i * 10,
  }));

  it('traegt im Rueckblick keine Fenster-Zeile', () => {
    const { container } = render(<PriceHistoryChart history={historie(tage, 'P1D')} />);
    expect(container.querySelector('.vp-preisfenster')).toBeNull();
  });

  it('bleibt O-Linie plus Min/Max-Band - jetzt in ct/kWh', () => {
    amRechner(<PriceHistoryChart history={historie(tage, 'P1D')} fokus="heute" />);
    expect(lastOption.yAxis.name).toBe('Preis (ct/kWh)');
    expect(lastOption.dataZoom).toBeUndefined();
    expect(lastOption.series).toHaveLength(3);
    expect(lastOption.series[2].data[0]).toBe(70);
    // Das Band ist die Spanne in derselben Einheit wie die Linie.
    expect(lastOption.series[0].data[0]).toBe(60);
    expect(lastOption.series[1].data[0]).toBeCloseTo(30, 6);
  });

  it('zieht seine Geometrie aus chartStyle (Leitserie 2,2 · Band-Alpha 0,14)', () => {
    amRechner(<PriceHistoryChart history={historie(tage, 'P1D')} />);
    expect(lastOption.series[2].lineStyle.width).toBe(2.2);
    expect(lastOption.series[1].areaStyle.opacity).toBe(0.14);
  });
});
