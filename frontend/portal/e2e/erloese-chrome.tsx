/**
 * Beweis-Harness für P3+P4 — das CHROME der Welt-Seiten (Konzept
 * `data/vp-erloese-lesbar-konzept-u3` §3.5/§3.10, Befunde B4/B5/B7/B12).
 *
 * Sie rendert GENAU EINE Welt (`?welt=erloese|messwerte|portfolio-erloese|
 * portfolio-messwerte`) unter einer 68 px hohen, klebenden Schalen-Kopfzeile —
 * denselben Bezugspunkt, gegen den `.vp-zeitleiste` mit `top: 68px` klebt.
 * Nur so ist „klebendes Chrome" im Browser messbar; die Seiten-Harness
 * `erloese-proof` stapelt bewusst mehrere Sektionen und taugt dafür nicht.
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seiten selbst kennen die Harness
 *   nicht.
 */
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

import { api } from '../src/api';
import type { Site } from '../src/api';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { MesswerteSection } from '../src/pages/MesswerteSection';
import { PortfolioErloese } from '../src/pages/PortfolioErloese';
import { PortfolioMesswerte } from '../src/pages/PortfolioMesswerte';

const SITE: Site = {
  id: 'chrome-1',
  name: 'Anlage Pilsting',
  biddingZone: 'DE-LU',
  latitude: 48.7,
  longitude: 12.6,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 8.11,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: false,
  maxFeedInKw: 30,
};

function stunden(n: number, netto: number) {
  const t0 = Date.parse('2026-09-01T05:00:00Z');
  return Array.from({ length: n }, (_, i) => ({
    start: new Date(t0 + i * 3600_000).toISOString(),
    einspeiseErloesEur: netto * 0.45,
    eigenverbrauchsWertEur: netto * 0.6,
    stromkostenEur: netto * 0.05,
    nettoEur: netto,
  }));
}

api.siteEarnings = (async () => ({
  from: '2026-09-01T00:00:00Z',
  to: '2026-09-30T23:59:59Z',
  range: 'month',
  nettoErgebnisEur: 128.4,
  einspeiseErloesEur: 92.6,
  eigenverbrauchsWertEur: 47.3,
  stromkostenEur: 11.5,
  marktpraemieEur: 4.79,
  bezogenKwh: 41.2,
  bezugspreisCtKwh: 27.9,
  savedEur: 31.2,
  savedSpeicherEur: 18.4,
  savedSteuerungEur: 12.8,
  steuerungSplitReason: null,
  arbitrageEur: 6.1,
  pvShiftEur: 25.1,
  tarifPriced: true,
  exportVerguetungPriced: false,
  plantKind: 'direktvermarktung',
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  anzulegenderWertCtKwh: 8.11,
  marketValueSolarCtKwh: 5.8,
  marketValueProvisional: true,
  realizedExportCtKwh: 6.4,
  eingespeistKwh: 345.4,
  selbstverbrauchKwh: 168.2,
  batterieBewegtKwh: 92.5,
  speicherDeltaKwh: 3.2,
  speicherWertCtKwh: 18.9,
  speicherWertEur: 0.6,
  speicherWertBasis: 'plan',
  coveredSlots: 2880,
  firstCoveredDate: '2026-01-01',
  reason: null,
  series: stunden(14, 9.2),
  monthlyStrip: null,
})) as typeof api.siteEarnings;

const HISTORY = {
  range: 'month',
  from: '2026-09-01T00:00:00Z',
  to: '2026-09-30T23:59:59Z',
  buckets: Array.from({ length: 20 }, (_, i) => ({
    start: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 86_400_000).toISOString(),
    pvKwh: 40 + i,
    loadKwh: 30 + (i % 5),
    gridImportKwh: 8 + (i % 3),
    gridExportKwh: 18 + (i % 4),
    batteryChargeKwh: 12,
    batteryDischargeKwh: 10,
    socMinPct: 20,
    socMaxPct: 90,
    socLastPct: 55,
    gridCostEur: 2.1,
  })),
  totals: {
    pvGenerationKwh: 880,
    consumptionKwh: 640,
    gridImportKwh: 160,
    gridExportKwh: 380,
    batteryChargeKwh: 240,
    batteryDischargeKwh: 200,
    gridCostEur: 42.5,
    batterySavingsPlannedEur: 18.2,
    batterySavingsEur: 18.2,
    autarkiegrad: 0.75,
    eigenverbrauchsquote: 0.57,
    tarifArt: 'dynamisch',
    tarifPriced: true,
  },
  protocol: [
    { at: '2026-09-01T08:00:00Z', kind: 'charge', text: 'Speicher lädt aus dem Solarüberschuss', energyKwh: 12.4, avgPriceCtKwh: 4.2, avoidedCostEur: 0.5 },
    { at: '2026-09-01T18:15:00Z', kind: 'discharge', text: 'Speicher deckt den Abendverbrauch', energyKwh: 9.8, avgPriceCtKwh: 31.2, avoidedCostEur: 3.1 },
  ],
  plan: [
    { time: '2026-09-01T08:00:00Z', batteryKw: 5.2, socPct: 42 },
    { time: '2026-09-01T09:00:00Z', batteryKw: 6.1, socPct: 55 },
  ],
  coverage: { firstDataAt: '2026-01-01T00:00:00Z', resolutionMinutes: 15, expected: 2880, measured: 2870, gaps: 1 },
  events: [],
};
api.history = (async () => HISTORY) as unknown as typeof api.history;

// Der mandantenweite Lesepfad der Portfolio-Welten.
api.earnings = (async () => ({
  from: '2026-09-01T00:00:00Z',
  to: '2026-09-30T23:59:59Z',
  range: 'month',
  sites: [
    {
      siteId: SITE.id,
      plantKind: 'direktvermarktung',
      baselineEur: 210.4,
      actualEur: 82.0,
      savedEur: 31.2,
      arbitrageEur: 6.1,
      pvShiftEur: 25.1,
      coveredSlots: 2880,
      firstCoveredDate: '2026-01-01',
      reason: null,
      dailySaved: Array.from({ length: 14 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, '0')}`,
        savedEur: 1.8 + i * 0.1,
      })),
      realizedExportCtKwh: 6.4,
      marketValueSolarCtKwh: 5.8,
      marketValueProvisional: true,
      expectedMarketValueSolarCtKwh: 6.0,
      expectedMarketValueFrom: null,
      expectedMarketValueTo: null,
      expectedMarketValueSlots: null,
      gesamtertragEur: 128.4,
      einspeiseErloesEur: 92.6,
      eigenverbrauchsWertEur: 47.3,
      stromkostenEur: 11.5,
      nettoErgebnisEur: 128.4,
      tarifPriced: true,
      peakShaving: null,
    },
  ],
  totals: {
    baselineEur: 210.4,
    actualEur: 82.0,
    savedEur: 31.2,
    arbitrageEur: 6.1,
    pvShiftEur: 25.1,
    coveredSlots: 2880,
    firstCoveredDate: '2026-01-01',
    gesamtertragEur: 128.4,
    einspeiseErloesEur: 92.6,
    eigenverbrauchsWertEur: 47.3,
    stromkostenEur: 11.5,
    nettoErgebnisEur: 128.4,
  },
  monthlyStrip: null,
})) as unknown as typeof api.earnings;

const welt = new URLSearchParams(window.location.search).get('welt') ?? 'erloese';

function Inhalt() {
  if (welt === 'messwerte') return <MesswerteSection site={SITE} />;
  if (welt === 'portfolio-erloese') return <PortfolioErloese sites={[SITE]} />;
  if (welt === 'portfolio-messwerte') return <PortfolioMesswerte sites={[SITE]} />;
  return <ErloeseSection site={SITE} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-app" style={{ minHeight: '100vh' }}>
      {/* Die Schalen-Kopfzeile: 68 px, klebend — der Bezugspunkt der Zeit-Leiste. */}
      <div
        data-shell-top
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          height: 68,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          background: 'var(--vp-c-card, #fff)',
          borderBottom: '1px solid var(--vp-c-border, #e2e8f0)',
          font: '600 14px/1.2 var(--vp-font-sans, system-ui)',
          color: 'var(--vp-c-fg, #1e293b)',
        }}
      >
        Anlage Pilsting · {welt}
      </div>
      <main className="vp-main" style={{ padding: '16px 20px 400px', minWidth: 0 }}>
        <Inhalt />
      </main>
    </div>
  </React.StrictMode>,
);
