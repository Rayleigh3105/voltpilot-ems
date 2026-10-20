import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type HistoryBucket, type WeatherPoint } from '../src/api';
import { WetterSection } from '../src/pages/DataPages';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Die Wetter-Seite (Konzept „Preise und Wetter", Fassung 3) mit erfundenem
 * Wetter in der Form der echten Antwort: drei Tage je Stunde, die
 * PV-Prognose des Fahrplans (bis morgen Abend) und die Messung von heute.
 * Die Uhr stellt der Test (`page.clock`).
 *
 *  ?fall=normal   heute sonnig, morgen wechselnd, übermorgen bewölkt
 *  ?fall=ohne     ohne Fahrplan: Sonnenstärke und Sonnenstunden
 */
const q = new URLSearchParams(location.search);
const fall = q.get('fall') ?? 'normal';
const jetzt = new Date();
const mitternacht = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()).getTime();
const STUNDE = 3600_000;
const AUF = 7 + 40 / 60;
const UNTER = 18 + 15 / 60;

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
const klar = (h: number) => (h <= AUF || h >= UNTER ? 0 : 540 * Math.pow(Math.sin((Math.PI * (h - AUF)) / (UNTER - AUF)), 1.3));
const TAGE = [
  { tmin: 8, tmax: 17, wolken: [[0, 30], [6, 25], [8, 15], [10, 8], [14, 6], [16, 15], [18, 30], [24, 35]] as [number, number][] },
  { tmin: 7, tmax: 13, wolken: [[0, 45], [6, 68], [8, 62], [9, 48], [10, 70], [11, 40], [12, 72], [13, 46], [14, 68], [15, 78], [17, 88], [24, 92]] as [number, number][] },
  { tmin: 5, tmax: 9, wolken: [[0, 90], [24, 97]] as [number, number][] },
];
const wolkenBei = (d: number, h: number) => interp(TAGE[d].wolken, h);
const ghi = (d: number, h: number) => klar(h) * (1 - 0.8 * Math.pow(wolkenBei(d, h) / 100, 1.8));
const pv = (d: number, h: number) => (9.8 * 1.24 * klar(h) * (1 - 0.85 * Math.pow(wolkenBei(d, h) / 100, 1.8))) / 1000;

const punkte: WeatherPoint[] = [];
TAGE.forEach((t, d) => {
  for (let h = 0; h < 24; h++) {
    const temp = h < 7 ? t.tmin + 2 - (2 * h) / 7 : h <= 15 ? t.tmin + ((t.tmax - t.tmin) * (1 - Math.cos((Math.PI * (h - 7)) / 8))) / 2 : t.tmax - ((t.tmax - (t.tmin + 2)) * (h - 15)) / 9;
    const c = wolkenBei(d, h + 0.5);
    punkte.push({
      ts: new Date(mitternacht + (d * 24 + h) * STUNDE).toISOString(),
      temperatureC: Math.round(temp * 10) / 10,
      cloudCoverPct: Math.round(c),
      ghiWM2: Math.round(ghi(d, h + 0.5)),
      dniWM2: Math.round(klar(h + 0.5) * 1.25 * Math.pow(1 - c / 100, 1.5)),
      dhiWM2: null,
    });
  }
});

// Die PV-Prognose des Fahrplans: ab jetzt bis morgen 24 Uhr, je Viertelstunde.
const jetztQ = Math.floor((jetzt.getTime() - mitternacht) / 900_000);
const slots = [];
for (let i = jetztQ; i < 192; i++) {
  const d = Math.floor(i / 96);
  slots.push({ start: new Date(mitternacht + i * 900_000).toISOString(), batteryKw: 0, pvKw: Math.round(pv(d, ((i % 96) * 15 + 7.5) / 60) * 100) / 100 });
}
// Gemessen heute bis jetzt: die Prognose mit etwas Abweichung.
const buckets: Partial<HistoryBucket>[] = [];
for (let i = 0; i < jetztQ; i++) {
  const h = (i * 15 + 7.5) / 60;
  buckets.push({ start: new Date(mitternacht + i * 900_000).toISOString(), pvKwh: Math.round(pv(0, h) * (0.93 + 0.06 * Math.sin(i * 1.7)) * 25) / 100 });
}

const a = api as unknown as Record<string, unknown>;
a.weather = async () => ({ runAt: new Date(mitternacht + Math.floor((jetzt.getTime() - mitternacht) / STUNDE) * STUNDE).toISOString(), points: punkte });
a.schedule = async () => (fall === 'ohne' ? Promise.reject(new Error('kein Plan')) : { slots, slotMinutes: 15, generatedAt: null, deviceId: null });
a.history = async () => ({ range: 'day', from: new Date(mitternacht).toISOString(), to: new Date(mitternacht + 24 * STUNDE).toISOString(), bucketMinutes: 15, buckets, totals: {}, protocol: [], plan: [] });

const site = { id: 'help-site', name: 'Sonnenhof', biddingZone: 'DE-LU' } as never;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="vp-main" style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--vp-c-bg)' }}>
    <WetterSection site={site} />
  </main>,
);
