/**
 * Beweis-Harness für **P6** — Portfolio › Erlöse in der Ledger-Grammatik
 * (Konzept `data/vp-erloese-lesbar-konzept-u3` §3.7, Befund **B13**,
 * Entscheide E2 = „beide" · E3 · E9).
 *
 * Sie rendert die Portfolio-Welt „Erlöse" mit einer **DREI-Anlagen-Flotte**
 * unter derselben 68-px-Schalen-Kopfzeile wie `erloese-chrome` (der
 * Bezugspunkt, gegen den `.vp-zeitleiste` klebt) — die Zahlen des Mockups
 * `rvC-1440-portfolio.png`.
 *
 * ⚠ Der Server-Block `vergleich` ist hier GESETZT (`gleicher_zeitpunkt`,
 *   bis 11 Uhr). Ohne ihn bliebe die Einordnung am laufenden Tag weg — genau
 *   die B13-Regel; `?vergleich=aus` zeigt diesen Fall.
 *
 * ⚠ Die Lesepfade sind gefälscht — die Seite selbst kennt die Harness nicht.
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
import '../src/components/Verlauf.css';
import '../src/components/BereichTabs.css';

import { api } from '../src/api';
import type { EarningsSite, Site } from '../src/api';
import { PortfolioErloese } from '../src/pages/PortfolioErloese';

const params = new URLSearchParams(window.location.search);
const mitVergleich = params.get('vergleich') !== 'aus';

function site(id: string, name: string): Site {
  return {
    id,
    name,
    biddingZone: 'DE-LU',
    latitude: 48.9,
    longitude: 12.6,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'fest',
    tarifParamCtKwh: 32.5,
    anzulegenderWertCtKwh: null,
    maxFeedInKw: null,
    leistungspreisEurKw: null,
    abrechnungLeistung: null,
    peakReserveSocPct: null,
    backupReserveSocPct: null,
    usageProfileOverride: null,
    componentAuthority: 'portal',
    profil: null,
  } as unknown as Site;
}

const SITES: Site[] = [
  site('a', 'Pilsting'),
  site('b', 'Auernheim'),
  site('c', 'Mienbach'),
];

/** Eine Flotten-Zeile; die vier Zahlen des Mockups je Anlage. */
function zeile(o: {
  id: string;
  name: string;
  einspeise: number;
  eigen: number;
  actual: number;
  saved: number;
  eingespeist: number;
}): EarningsSite {
  return {
    id: o.id,
    name: o.name,
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: o.actual,
    savedEur: o.saved,
    arbitrageEur: null,
    pvShiftEur: null,
    savedSpeicherEur: null,
    savedSteuerungEur: null,
    steuerungSplitReason: null,
    coveredSlots: 44,
    firstCoveredDate: '2026-09-03',
    reason: null,
    dailySaved: [],
    tarifArt: 'fest',
    tarifParamCtKwh: 32.5,
    tarifPriced: true,
    exportVerguetungPriced: false,
    einspeiseErloesEur: o.einspeise,
    eigenverbrauchsWertEur: o.eigen,
    gesamtertragEur: o.einspeise + o.eigen,
    selbstverbrauchKwh: null,
    eingespeistKwh: o.eingespeist,
    batterieBewegtKwh: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: Array.from({ length: 11 }, (_, i) => ({
      start: `2026-09-03T${String(i).padStart(2, '0')}:00:00Z`,
      gesamtertragEur: 0.4 + i * 0.35,
    })),
    monthlyStrip: [],
    peakShaving: null,
  } as unknown as EarningsSite;
}

// Die Zahlen des Mockups: Einspeise 26,56 · Eigenverbrauch 34,16 ·
// Netzbezug −18,52 · Speicher + 9,39. Das Ergebnis ist damit 42,20 (das
// Mockup nennt 42,19 — ein Cent Rundung; die Fläche rechnet konsistent).
// netto je Zeile = eigen − actual;  actual = stromkosten − einspeise.
const ZEILEN: EarningsSite[] = [
  zeile({ id: 'a', name: 'Pilsting', einspeise: 14.02, eigen: 18.4, actual: -4.1, saved: 5.2, eingespeist: 132.6 }),
  zeile({ id: 'b', name: 'Auernheim', einspeise: 8.32, eigen: 10.86, actual: -1.63, saved: 2.71, eingespeist: 78.4 }),
  zeile({ id: 'c', name: 'Mienbach', einspeise: 4.22, eigen: 4.9, actual: -2.31, saved: 1.48, eingespeist: 39.9 }),
];

api.earnings = (async () => ({
  range: 'day',
  from: '2026-09-03T00:00:00Z',
  to: '2026-09-04T00:00:00Z',
  sites: ZEILEN,
  totals: {
    baselineEur: null,
    actualEur: -8.0,
    savedEur: 9.39,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 132,
    firstCoveredDate: '2026-09-03',
  },
  vergleich: mitVergleich
    ? { modus: 'gleicher_zeitpunkt', bisStunde: 11, jetztEur: 42.19, vorherEur: 56.24 }
    : null,
})) as unknown as typeof api.earnings;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="vp-app" style={{ minHeight: '100vh' }}>
      {/* Die Schalen-Kopfzeile: 68 px, klebend — der Bezugspunkt der Zeit-Leiste. */}
      <div
        className="vp-topbar"
        style={{ position: 'sticky', top: 0, zIndex: 40, height: 68 }}
      >
        <strong style={{ paddingInline: 16 }}>VoltPilot</strong>
      </div>
      <main className="vp-main" style={{ padding: 0 }}>
        <PortfolioErloese sites={SITES} />
      </main>
    </div>
  </React.StrictMode>,
);
