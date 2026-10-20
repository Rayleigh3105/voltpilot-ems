import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type PriceBucket, type PriceHistory, type SchedulePlan } from '../src/api';
import { MarktpreisePage } from '../src/pages/DataPages';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Die Preis-Seite (Konzept „Preise und Wetter", Fassung 3) mit erfundenen
 * Börsenpreisen in der Form der echten Antwort. Die Uhr stellt der Test
 * (`page.clock`); die Reihe beginnt am Tag dieser Uhr um 0 Uhr.
 *
 *  ?fall=normal   heute + morgen (ab 13 Uhr veröffentlicht)
 *  ?fall=negativ  ein sonniger Sonntag mit Preisen unter null
 *  ?fall=flach    kaum Spanne - keine Stufen, keine Fenster
 *  ?fall=leer     keine Preise
 */
const q = new URLSearchParams(location.search);
const fall = q.get('fall') ?? 'normal';
const jetzt = new Date();
const mitternacht = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()).getTime();

function interp(a: [number, number][], x: number): number {
  for (let k = 1; k < a.length; k++) {
    if (x <= a[k][0]) {
      const [x0, y0] = a[k - 1];
      const [x1, y1] = a[k];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return a[a.length - 1][1];
}
/** 96 Viertelstunden in ct/kWh aus Stützstellen, mit dem Viertelstunden-Sägezahn der Börse. */
function tag(anker: [number, number][], saat: number): number[] {
  const rampe = [0.26, 0.08, -0.1, -0.24];
  return Array.from({ length: 96 }, (_, i) => {
    const h = (i * 15 + 7.5) / 60;
    const rauschen = Math.sin(i * 12.9898 + saat) * 0.18;
    return Math.round((interp(anker, h) + rampe[i % 4] + rauschen) * 100) / 100;
  });
}
const HEUTE = tag([[0, 17.2], [2, 16.9], [4, 16.6], [5.5, 17], [6.5, 19.5], [7.5, 23.5], [8.5, 25.2], [9.25, 23], [10, 19], [11, 16.2], [12, 14.8], [13, 14.4], [14, 14.6], [15, 15.3], [15.5, 16.8], [16.5, 21.5], [17.5, 25], [18.5, 26.1], [19.5, 25.2], [20.5, 23.5], [21.5, 21.2], [22.5, 19.6], [24, 18.2]], 1);
const MORGEN = tag([[0, 17.6], [1.5, 16.8], [3, 16.1], [4.5, 16.3], [5.5, 17.4], [6.5, 22], [7.25, 26.6], [8, 28], [9, 27.2], [9.75, 23], [10.5, 21.2], [12, 20.4], [13.5, 20.8], [14.5, 21.6], [15.5, 24.2], [16.5, 26.4], [17.5, 25.4], [18.5, 24.7], [19.5, 25], [20.5, 22.8], [21.5, 20.1], [22.5, 18.2], [24, 16.4]], 2);
const SONNTAG = tag([[0, 11.8], [3, 10.9], [6, 11.5], [7.5, 12.2], [8.5, 10], [9.5, 6.2], [10.5, 1.5], [11.5, -1.6], [12.5, -3], [13.5, -2.6], [14.5, -0.4], [15.5, 4.2], [16.5, 10.5], [17.5, 16.8], [18.5, 19.4], [19.5, 18.6], [20.5, 16.2], [22, 13.6], [24, 12.1]], 3);
const FLACH = tag([[0, 20], [24, 21]], 4);

const morgenDa = jetzt.getHours() >= 13;
const cts =
  fall === 'leer' ? [] : fall === 'negativ' ? SONNTAG : fall === 'flach' ? FLACH : morgenDa ? [...HEUTE, ...MORGEN] : HEUTE;
const buckets: PriceBucket[] = cts.map((ct, i) => ({
  ts: new Date(mitternacht + i * 900_000).toISOString(),
  avgEurMwh: ct * 10,
  minEurMwh: ct * 10,
  maxEurMwh: ct * 10,
}));

function historie(b: PriceBucket[], bucket = 'PT15M'): PriceHistory {
  const werte = b.map((x) => x.avgEurMwh as number);
  return {
    biddingZone: 'DE-LU',
    currency: 'EUR',
    bucket,
    from: b[0]?.ts ?? new Date(mitternacht).toISOString(),
    to: b[b.length - 1]?.ts ?? new Date(mitternacht).toISOString(),
    buckets: b,
    summary: {
      avgEurMwh: werte.length ? werte.reduce((s, v) => s + v, 0) / werte.length : null,
      minEurMwh: werte.length ? Math.min(...werte) : null,
      maxEurMwh: werte.length ? Math.max(...werte) : null,
      cheapestTs: b[werte.indexOf(Math.min(...werte))]?.ts ?? null,
      mostExpensiveTs: b[werte.indexOf(Math.max(...werte))]?.ts ?? null,
      count: b.length,
      coverageStart: b[0]?.ts ?? null,
      coverageEnd: b[b.length - 1]?.ts ?? null,
    },
  };
}

/** Der Rückblick: eine Woche Tageswerte. */
function rueckblick(range: string): PriceHistory {
  if (range === 'day') return historie(buckets);
  const n = range === 'week' ? 7 : range === 'month' ? 30 : 12;
  const b = Array.from({ length: n }, (_, i) => {
    const v = (18 + 4 * Math.sin(i * 0.9) + (i % 7 === 4 ? -7 : 0)) * 10;
    return { ts: new Date(mitternacht - (n - 1 - i) * 86_400_000).toISOString(), avgEurMwh: v, minEurMwh: v - 60, maxEurMwh: v + 80 };
  });
  return historie(b, range === 'week' ? 'PT1H' : 'P1D');
}

// Speicher laut Plan: laden in den günstigsten, abgeben in den teuersten Stunden der nächsten 24 Std.
const jetztI = Math.floor((jetzt.getTime() - mitternacht) / 900_000);
const zukunft = cts.map((ct, i) => ({ ct, i })).filter((x) => x.i >= jetztI && x.i < jetztI + 96);
const sortiert = [...zukunft].sort((a, b) => a.ct - b.ct);
const laden = new Set(sortiert.slice(0, 12).map((x) => x.i));
const abgeben = new Set(sortiert.slice(-12).map((x) => x.i));
const plan = {
  slotMinutes: 15,
  generatedAt: jetzt.toISOString(),
  deviceId: null,
  slots: zukunft.map(({ i }) => ({
    start: new Date(mitternacht + i * 900_000).toISOString(),
    batteryKw: laden.has(i) ? 3.2 : abgeben.has(i) ? -2.8 : 0,
    gridKw: 0,
    socPct: 50,
    priceEurMwh: cts[i] * 10,
    costEur: null,
    baselineCostEur: null,
    curtailKw: 0,
    pvKw: 0,
    loadKw: 0.8,
  })),
} as unknown as SchedulePlan;

const a = api as unknown as Record<string, unknown>;
a.priceHistory = async (_site: string, range: string) => (range === 'day' ? historie(buckets) : rueckblick(range));
a.schedule = async () => (q.get('plan') === 'nein' ? { ...plan, slots: [] } : plan);

const site = { id: 'help-site', name: 'Sonnenhof', biddingZone: 'DE-LU' } as never;
location.hash = '#/anlage/help-site/marktpreise';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="vp-main" style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--vp-c-bg)' }}>
    <MarktpreisePage sites={[site]} selectedSite="help-site" onSelectSite={() => {}} embedded />
  </main>,
);
