import React from 'react';
import ReactDOM from 'react-dom/client';
import { api, type ForecastValue, type HistoryBucket, type ScheduleSlot, type SiteAsset, type WeatherPoint } from '../src/api';
import { PrognoseSeite } from '../src/pages/PrognoseSeite';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * Der Sonnen-Teppich (Konzept `vp-prognosen-konzept`, E1 = C) mit erfundenem
 * Wetter und Prognose in der Form der echten Antwort - sieben Tage, die
 * ersten zwei viertelstündlich, danach als Ausblick stündlich. Die Uhr
 * stellt der Test (`page.clock`).
 *
 *  ?fall=mit-speicher      Fahrplan vorhanden: Reiter, Speicher-Streifen, "Ihr Fahrplan"
 *  ?fall=nur-messen-pv     kein Fahrplan, mit PV: eigener Bereich, ohne Speicher-Streifen
 *  ?fall=nur-messen-ohne-pv kein Fahrplan, ohne PV: der Teppich zeigt nur den Verbrauch
 */
const q = new URLSearchParams(location.search);
const fall = q.get('fall') ?? 'mit-speicher';
const hatFahrplan = fall === 'mit-speicher';
const mitPv = fall !== 'nur-messen-ohne-pv';

const jetzt = new Date();
const mitternacht = new Date(jetzt.getFullYear(), jetzt.getMonth(), jetzt.getDate()).getTime();
const STUNDE = 3600_000;
const VIERTEL = 900_000;
const TAGE_ANZAHL = 7;
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
/** Je Tag ein Wolken-Verlauf - sonnig zuerst, danach wechselhafter (nicht gewählt, aber plausibel). */
const wolkenKurve = (tag: number): [number, number][] => {
  const basis = 20 + tag * 10;
  return [
    [0, basis],
    [8, Math.max(5, basis - 15)],
    [13, Math.max(5, basis - 20)],
    [18, basis],
    [24, basis + 5],
  ];
};
const wolkenBei = (d: number, h: number) => interp(wolkenKurve(d), h);
const ghi = (d: number, h: number) => klar(h) * (1 - 0.8 * Math.pow(wolkenBei(d, h) / 100, 1.8));
const pvKwBei = (d: number, h: number) => (mitPv ? (9.8 * 1.24 * klar(h) * (1 - 0.85 * Math.pow(wolkenBei(d, h) / 100, 1.8))) / 1000 : 0);
/** Grundlast 0,3 kW, Morgenspitze 6-9, Abendspitze 17-22 - an jedem Tag gleich (plausibel, nicht gewählt). */
const verbrauchKwBei = (h: number) => {
  const morgen = h >= 6 && h < 9 ? 1.4 * Math.sin((Math.PI * (h - 6)) / 3) : 0;
  const abend = h >= 17 && h < 22 ? 2.2 * Math.sin((Math.PI * (h - 17)) / 5) : 0;
  return 0.3 + morgen + abend;
};

const weather: WeatherPoint[] = [];
for (let d = 0; d < TAGE_ANZAHL; d++) {
  for (let h = 0; h < 24; h++) {
    const c = wolkenBei(d, h + 0.5);
    weather.push({
      ts: new Date(mitternacht + (d * 24 + h) * STUNDE).toISOString(),
      temperatureC: Math.round((10 + 6 * Math.sin((Math.PI * (h - 6)) / 12) - d * 0.6) * 10) / 10,
      cloudCoverPct: Math.round(c),
      ghiWM2: Math.round(ghi(d, h + 0.5)),
      dniWM2: null,
      dhiWM2: null,
      dniNormalWM2: Math.round(klar(h + 0.5) * 1.25 * Math.pow(1 - c / 100, 1.5)),
    });
  }
}

function werte(vonQ: number, bisQ: number, fn: (d: number, h: number) => number): ForecastValue[] {
  const out: ForecastValue[] = [];
  for (let i = vonQ; i < bisQ; i++) {
    const d = Math.floor(i / 96);
    const h = ((i % 96) * 15 + 7.5) / 60;
    out.push({ ts: new Date(mitternacht + i * VIERTEL).toISOString(), valueKw: Math.round(fn(d, h) * 1000) / 1000 });
  }
  return out;
}
function stundenWerte(vonTag: number, bisTag: number, fn: (d: number, h: number) => number): ForecastValue[] {
  const out: ForecastValue[] = [];
  for (let d = vonTag; d < bisTag; d++) {
    for (let h = 0; h < 24; h++) {
      out.push({ ts: new Date(mitternacht + (d * 24 + h) * STUNDE).toISOString(), valueKw: Math.round(fn(d, h + 0.5) * 1000) / 1000 });
    }
  }
  return out;
}

const jetztQ = Math.floor((jetzt.getTime() - mitternacht) / VIERTEL);
const forecastRunAt = new Date(mitternacht + Math.floor((jetzt.getTime() - mitternacht) / STUNDE) * STUNDE).toISOString();

// Gemessen heute bis jetzt: die Prognose mit etwas Abweichung.
const buckets: HistoryBucket[] = [];
for (let i = 0; i < jetztQ; i++) {
  const h = (i * 15 + 7.5) / 60;
  buckets.push({
    start: new Date(mitternacht + i * VIERTEL).toISOString(),
    pvKwh: Math.round(pvKwBei(0, h) * (0.93 + 0.06 * Math.sin(i * 1.7)) * 0.25 * 100) / 100,
    loadKwh: Math.round(verbrauchKwBei(h) * (0.9 + 0.1 * Math.cos(i * 1.3)) * 0.25 * 100) / 100,
    gridImportKwh: null,
    gridExportKwh: null,
    batteryChargeKwh: null,
    batteryDischargeKwh: null,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
  });
}

// Speicher-Streifen (nur mit Fahrplan): lädt vormittags aus der Sonne, gibt abends ab.
const slots: ScheduleSlot[] = [];
if (hatFahrplan) {
  for (let i = jetztQ; i < 192; i++) {
    const h = ((i % 96) * 15 + 7.5) / 60;
    const batteryKw = h >= 10 && h < 15 ? 3 : h >= 18 && h < 22 ? -2.5 : 0;
    slots.push({
      start: new Date(mitternacht + i * VIERTEL).toISOString(),
      batteryKw,
      gridKw: null,
      socPct: null,
      priceEurMwh: null,
      costEur: null,
      baselineCostEur: null,
      curtailKw: null,
      pvKw: null,
      loadKw: null,
      slotRole: null,
      slotFlags: null,
      storedValueCtKwh: null,
      gridValueCtKwh: null,
      peakPressureEurKw: null,
      importPriceCtKwh: null,
      exportValueCtKwh: null,
      importPriceSource: null,
    });
  }
}

const a = api as unknown as Record<string, unknown>;
a.weather = async () => ({ runAt: forecastRunAt, points: weather });
a.schedule = async () => ({ slots, slotMinutes: 15, generatedAt: null, deviceId: null });
a.history = async () => ({
  range: 'day',
  from: new Date(mitternacht).toISOString(),
  to: new Date(mitternacht + 24 * STUNDE).toISOString(),
  bucketMinutes: 15,
  buckets,
  totals: {},
  protocol: [],
  plan: [],
});
a.forecast = async () => ({
  activePvModel: 'pv-physical',
  activeLoadModel: 'load-persistence',
  pvRunAt: forecastRunAt,
  pvKw: werte(jetztQ, 192, pvKwBei),
  loadRunAt: forecastRunAt,
  loadKw: werte(jetztQ, 192, (_d, h) => verbrauchKwBei(h)),
  yesterdayExpected: {
    pvRunAt: forecastRunAt,
    pvKw: werte(0, jetztQ, (_d, h) => pvKwBei(0, h) * 0.85),
    loadRunAt: forecastRunAt,
    loadKw: werte(0, jetztQ, (_d, h) => verbrauchKwBei(h) * 1.1),
  },
  weekly: {
    pvRunAt: forecastRunAt,
    pvKw: stundenWerte(2, TAGE_ANZAHL, pvKwBei),
    loadRunAt: forecastRunAt,
    loadKw: stundenWerte(2, TAGE_ANZAHL, (_d, h) => verbrauchKwBei(h)),
  },
});
// Der Maßstab des Teppichs misst sich an der Anlage (9,8 kWp - dieselbe
// Zahl, mit der die Sonnenkurve oben rechnet), nicht an ihrer eigenen
// Spitze der Woche.
a.siteAssets = async (): Promise<SiteAsset[]> =>
  mitPv
    ? [
        {
          id: 'e2e-pv', type: 'pv', deviceId: null, capacityKwh: null, maxChargeKw: null, maxDischargeKw: null,
          roundtripEfficiencyPct: null, speicherschonung: null, pvCapacityKwp: 9.8, moduleCount: 25,
          azimuthDeg: null, tiltDeg: null, commissionedOn: null, registry: null, registryUnitId: null, registryFetchedAt: null,
        },
      ]
    : [];

const site = { id: 'help-site', name: 'Sonnenhof', biddingZone: 'DE-LU' } as never;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="vp-main" style={{ padding: 16, maxWidth: 1180, margin: '0 auto', background: 'var(--vp-c-bg)' }}>
    <PrognoseSeite site={site} hatFahrplan={hatFahrplan} />
  </main>,
);
