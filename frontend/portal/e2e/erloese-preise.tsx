import './erloese-minus-uhr';

import React from 'react';
import ReactDOM from 'react-dom/client';

import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';
import '../src/shell/Shell.css';
import '../src/components/Historie.css';
import '../src/components/Erloese.css';
import '../src/components/SoVerdient.css';
import '../src/components/Verlauf.css';
import '../src/components/BereichTabs.css';
import '../src/components/SteuerungFormel.css';

import { api, type History, type Site, type SiteEarnings } from '../src/api';
import FIXTURES from '../src/erloeseFixtures.json';
import { ErloeseSection } from '../src/pages/ErloeseSection';

/**
 * **Beweis-Harness „Preise im Zeitraum" und „So verdient Ihre Anlage"** —
 * die echte `ErloeseSection` gegen die eingefrorenen Konzept-Fixtures
 * (`src/erloeseFixtures.json`), eine Anlage je Aufruf.
 *
 * `?fall=<Fixture-Kennung>` (Vorgabe `dv-monat`) · `?jetzt=…` (feste Uhr,
 * `erloese-minus-uhr.ts`; Vorgabe: die Uhr der Fixture wird NICHT gesetzt,
 * der Aufrufer reicht sie mit).
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seite kennt die Harness nicht.
 */

interface Fixture {
  id: string;
  range: 'day' | 'week' | 'month' | 'year';
  now: string;
  money: SiteEarnings;
}
const FX = (FIXTURES as unknown as { fixtures: Fixture[] }).fixtures;

const params = new URLSearchParams(window.location.search);
const fallId = params.get('fall') ?? 'dv-monat';
const fall = FX.find((f) => f.id === fallId) ?? FX.find((f) => f.id === 'dv-monat')!;

/** Ein Stunden-Raster, dessen Summe das Netto der Fixture trifft. */
function raster(nettoGesamt: number, tagBeginnUtc: string, mitEigenverbrauch: boolean) {
  const anteile = [0.02, 0.06, 0.12, 0.2, 0.24, 0.2, 0.12, 0.04];
  const t0 = new Date(tagBeginnUtc).getTime();
  return anteile.map((a, i) => {
    const netto = nettoGesamt * a;
    return {
      start: new Date(t0 + (7 + i) * 3600_000).toISOString(),
      einspeiseErloesEur: netto * 0.45,
      eigenverbrauchsWertEur: mitEigenverbrauch ? netto * 0.6 : null,
      stromkostenEur: netto * 0.05,
      nettoEur: netto,
    };
  });
}

const GELD: SiteEarnings = {
  ...fall.money,
  steuerungSplitReason:
    fall.money.savedSteuerungEur == null ? 'no_battery_data' : fall.money.steuerungSplitReason,
  series: raster(
    fall.money.nettoErgebnisEur ?? 0,
    fall.money.from,
    fall.money.eigenverbrauchsWertEur != null,
  ),
} as SiteEarnings;

const HISTORIE: History = {
  range: fall.range,
  from: fall.money.from,
  to: fall.money.to,
  bucketMinutes: 15,
  buckets: [],
  totals: {
    consumptionKwh: 154.7,
    pvGenerationKwh: 500,
    gridImportKwh: 6.3,
    gridExportKwh: 345.2,
    gridCostEur: 1.59,
    tarifArt: fall.money.tarifArt,
    batterySavingsPlannedEur: null,
    steuerungPlannedEur: null,
    autarkiePct: 0.96,
    eigenverbrauchPct: 0.31,
  },
  protocol: [],
  plan: [],
} as unknown as History;

api.siteEarnings = (async () => GELD) as unknown as typeof api.siteEarnings;
api.history = (async () => HISTORIE) as unknown as typeof api.history;

const SITE: Site = {
  id: `beweis-${fall.id}`,
  name: fall.id,
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: fall.money.plantKind,
  anzulegenderWertCtKwh: fall.money.anzulegenderWertCtKwh ?? null,
  tarifArt: fall.money.tarifArt,
  tarifParamCtKwh: fall.money.tarifParamCtKwh ?? null,
  netzladenErlaubt: params.get('netzladen') === '1' ? true : false,
  maxFeedInKw: null,
} as Site;

// Die Adresse trägt Zeitraum und Tag — so öffnet die echte Seite genau diesen Fall.
const WORT = { day: 'tag', week: 'woche', month: 'monat', year: 'jahr' } as const;
const mitte = new Date(Date.parse(fall.money.from) + 12 * 3600_000);
const at = `${mitte.getFullYear()}-${String(mitte.getMonth() + 1).padStart(2, '0')}-${String(mitte.getDate()).padStart(2, '0')}`;
window.location.hash = `#/anlage/${SITE.id}/erloese?z=${WORT[fall.range]}&at=${at}`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
      <main className="vp-main" data-fall={fall.id} style={{ padding: '16px', minWidth: 0 }}>
        <ErloeseSection site={SITE} />
      </main>
    </div>
  </React.StrictMode>,
);
