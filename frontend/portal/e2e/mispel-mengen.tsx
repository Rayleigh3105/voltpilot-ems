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
import MISPEL from './mispel-mengen-fixtures.json';
import type { MispelJahr, MispelMonat } from '../src/mispelMengen';
import { ErloeseSection } from '../src/pages/ErloeseSection';

/**
 * **Bühne „MiSpeL · Mengen nach Anlage 1“** (MP-18, BK-18 Variante A) — die echte `ErloeseSection` einer
 * Simulator-Anlage mit Förderweg Abgrenzungsoption. Die MiSpeL-Antworten sind die der Route aus
 * `MispelMengenApiTest` (echter Monatslauf MP-8; der Test hält diese Datei gleich der Antwort). Kennzahlleiste und
 * Abrechnung stammen aus der Konzept-Fixture `dv-monat` (nicht Teil von MP-18).
 *
 * `?z=monat&at=2026-11-15` · `?z=jahr&at=2026-11-15` · `?jetzt=…` (feste Uhr). Nachweis-Abrufe landen in
 * `window.__nachweise` statt im Netz.
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seite kennt die Bühne nicht.
 */
interface Fixture {
  id: string;
  money: SiteEarnings;
}
const fall = (FIXTURES as unknown as { fixtures: Fixture[] }).fixtures.find((f) => f.id === 'dv-monat')!;
const FX = MISPEL as unknown as Record<string, unknown>;
const params = new URLSearchParams(window.location.search);

api.siteEarnings = (async () => ({ ...fall.money, series: [] }) as unknown as SiteEarnings) as typeof api.siteEarnings;
api.history = (async () =>
  ({ range: 'month', from: fall.money.from, to: fall.money.to, bucketMinutes: 15, buckets: [], protocol: [], plan: [], totals: {} }) as unknown as History) as typeof api.history;
api.mispelMonat = (async (_s: string, monat: string) => {
  const m = FX[`monat-${monat}`] as MispelMonat | undefined;
  return m ?? ({ monat, foerderweg: 'marktpraemie_abgrenzung', foerderwegBegriff: 'Marktprämie mit Abgrenzungsoption', mispel: true, abgrenzung: true, stand: null, gruende: [], giltAlsNachweis: false, teile: [], wert: null } as MispelMonat);
}) as typeof api.mispelMonat;
api.mispelJahr = (async () => FX['jahr-2026'] as MispelJahr) as typeof api.mispelJahr;
const nachweise: unknown[] = [];
(window as unknown as { __nachweise: unknown[] }).__nachweise = nachweise;
api.mispelNachweis = (async (...args: unknown[]) => {
  nachweise.push(args);
}) as typeof api.mispelNachweis;

const SITE: Site = {
  id: 'simulator-anlage',
  name: 'Simulator-Anlage',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'direktvermarktung',
  anzulegenderWertCtKwh: 6.85,
  tarifArt: fall.money.tarifArt,
  tarifParamCtKwh: fall.money.tarifParamCtKwh ?? null,
  netzladenErlaubt: true,
  maxFeedInKw: null,
} as Site;

window.location.hash = `#/anlage/${SITE.id}/erloese?z=${params.get('z') ?? 'monat'}&at=${params.get('at') ?? '2026-11-15'}`;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
      <main className="vp-main" data-buehne="mispel-mengen" style={{ padding: '16px', minWidth: 0 }}>
        <ErloeseSection site={SITE} />
      </main>
    </div>
  </React.StrictMode>,
);
