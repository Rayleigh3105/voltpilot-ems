/**
 * Prüfbühne für den Verlauf (Energie · Erlöse · Messwerte): die ganze App mit
 * den fiktiven Hilfe-Fixtures, aber mit Verlaufsdaten für JEDEN Zeitraum
 * (`verlauf-fixtures.ts`), damit Woche, Monat und Jahr im Browser prüfbar
 * sind. Aufruf: `/e2e/verlauf.html#/anlage/help-site/messwerte` usw.; die Uhr
 * steht wie bei den Hilfe-Aufnahmen auf dem 10.09.2026, 12:00 Uhr Berlin.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { api } from '../src/api';
import type { Earnings, EarningsRange, EarningsSite, History, HistoryRange, SiteEarnings, SiteEarningsRange } from '../src/api';
import { installHelpFixtures } from './help-fixtures';
import { earningsFor, historyFor, TODAY } from './verlauf-fixtures';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

installHelpFixtures();

/*
 * Zwei VERSCHIEDENE Anlagen für die Portfolio-Welten („Meine Anlagen"): die
 * zweite ist kleiner (Faktor 0,55) — sonst stünden zwei gleiche Zeilen da.
 * `?kunde=1` zeigt die Endkunden-Schale (Wort „Meine Anlagen").
 */
const FAKTOR: Record<string, number> = { 'help-site': 1, 'help-site-2': 0.55 };
const NAME: Record<string, string> = { 'help-site': 'Sonnenhof', 'help-site-2': 'Werkstatt am Bach' };
const skal = (v: number | null | undefined, f: number) => (v == null ? (v as null) : Math.round(v * f * 1000) / 1000);

function historyFuer(siteId: string, range: HistoryRange, at: string): History {
  const h = historyFor(range, at);
  const f = FAKTOR[siteId] ?? 1;
  if (f === 1) return h;
  return {
    ...h,
    buckets: h.buckets.map((b) => ({
      ...b,
      pvKwh: skal(b.pvKwh, f), loadKwh: skal(b.loadKwh, f), gridImportKwh: skal(b.gridImportKwh, f),
      gridExportKwh: skal(b.gridExportKwh, f), batteryChargeKwh: skal(b.batteryChargeKwh, f),
      batteryDischargeKwh: skal(b.batteryDischargeKwh, f), costEur: skal(b.costEur, f),
    })),
  };
}

function siteEarningsFuer(siteId: string, range: SiteEarningsRange, at: string): SiteEarnings {
  const m = earningsFor(siteId, NAME[siteId] ?? 'Sonnenhof', range, at);
  const f = FAKTOR[siteId] ?? 1;
  if (f === 1) return m;
  const out = { ...m } as Record<string, unknown>;
  for (const k of ['einspeiseErloesEur', 'eigenverbrauchsWertEur', 'stromkostenEur', 'nettoErgebnisEur', 'savedEur', 'savedSpeicherEur',
    'savedSteuerungEur', 'baselineEur', 'actualEur', 'bezogenKwh', 'eingespeistKwh', 'selbstverbrauchKwh', 'batterieBewegtKwh', 'gesamtertragEur']) {
    const v = out[k];
    if (typeof v === 'number') out[k] = Math.round(v * f * 100) / 100;
  }
  out.series = m.series.map((b) => ({
    start: b.start, einspeiseErloesEur: skal(b.einspeiseErloesEur, f), eigenverbrauchsWertEur: skal(b.eigenverbrauchsWertEur, f),
    stromkostenEur: skal(b.stromkostenEur, f), nettoEur: skal(b.nettoEur, f),
  }));
  return out as unknown as SiteEarnings;
}

/** Der mandantenweite `GET /earnings` aus denselben Anlagen-Antworten. */
function earningsFuer(range: EarningsRange, at: string): Earnings {
  const r: SiteEarningsRange = range === 'all' ? 'year' : range;
  const sites: EarningsSite[] = Object.keys(FAKTOR).map((id) => {
    const m = siteEarningsFuer(id, r, at);
    return {
      ...m, id, name: NAME[id], dailySaved: [], monthlyStrip: [],
      series: m.series.map((b) => ({ start: b.start, gesamtertragEur: Math.round(((b.einspeiseErloesEur ?? 0) + (b.eigenverbrauchsWertEur ?? 0)) * 100) / 100 })),
    } as unknown as EarningsSite;
  });
  const first = sites[0] as unknown as SiteEarnings;
  return {
    range, from: first.from, to: first.to, sites,
    totals: { baselineEur: null, actualEur: null, savedEur: null, arbitrageEur: null, pvShiftEur: null,
      coveredSlots: sites.reduce((n, s) => n + s.coveredSlots, 0), firstCoveredDate: null },
    vergleich: null,
  };
}

const kunde = new URLSearchParams(location.search).get('kunde') === '1';
const tenantContext = api.tenantContext;
Object.assign(api, {
  history: async (siteId: string, range: HistoryRange, at: string) => historyFuer(siteId, range, at || TODAY),
  siteEarnings: async (siteId: string, range: SiteEarningsRange = 'month', at?: string | null) =>
    siteEarningsFuer(siteId, range, at || TODAY),
  earnings: async (range: EarningsRange = 'month', at?: string | null) => earningsFuer(range, at || TODAY),
  tenantContext: kunde
    ? async () => ({ ...(await tenantContext()), betriebsart: 'endkunde' })
    : tenantContext,
});
// Messhilfe für Performance-Prüfungen: zählt jeden API-Aufruf mit Argumenten.
const zaehler: { name: string; args: string }[] = [];
(window as unknown as { __apiCalls: typeof zaehler }).__apiCalls = zaehler;
for (const key of Object.keys(api)) {
  const fn = (api as Record<string, unknown>)[key];
  if (typeof fn !== 'function') continue;
  (api as Record<string, unknown>)[key] = (...args: unknown[]) => {
    zaehler.push({ name: key, args: JSON.stringify(args).slice(0, 80) });
    return (fn as (...a: unknown[]) => unknown)(...args);
  };
}
ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
