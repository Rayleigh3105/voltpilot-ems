import './erloese-minus-uhr';

import React, { useState } from 'react';
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

import { api, type Site, type SiteEarnings } from '../src/api';
import { benutzerApi } from '../src/benutzer';
import { BereichTabs } from '../src/components/BereichTabs';
import { anlageSidebar, tabsFor } from '../src/ebenenNav';
import { type PageId } from '../src/nav';
import { BenutzerPage } from '../src/pages/BenutzerPage';
import { ErloeseSection } from '../src/pages/ErloeseSection';
import { keycloak } from '../src/auth';
import { setSelbstauskunft } from '../src/rollen';
import { AppShell } from '../src/shell/AppShell';
import { anlageSurface } from '../src/surface';
import { benutzerFixture } from '../src/test/benutzerFixtures';
import { rechteSeed } from '../src/test/rollenFixtures';
import { unterstuetzungApi } from '../src/unterstuetzung';

/**
 * **Beweis-Bühne „Privatkunde, drei Nebenbefunde“** (Konzept
 * `vp-privatkunde-luecken-konzept` §8, PK5-A): fiktive Privat-Anlage
 * „Zuhause“ ohne Markt-Modus, feste Uhr (`?jetzt=`).
 *
 * `?flaeche=erloese` — Reiterleiste des Verlaufs (`tabsFor`) über der echten
 * `ErloeseSection`: heute bis 12 Uhr −1,29 €, gestern bis 12 Uhr +0,36 €
 * (Befunde 1 und 2). `?flaeche=benutzer` — die echte `BenutzerPage` eines
 * Kunden, dessen Anlagen alle das Profil `privat` tragen (Befund 5);
 * `&profil=gewerbe` zeigt dieselbe Seite mit Unternehmenswörtern.
 *
 * ⚠ Die Lesepfade sind hier gefälscht — die Seiten kennen die Bühne nicht.
 */
const q = new URLSearchParams(location.search);
const flaeche = q.get('flaeche') ?? 'erloese';
const profil = q.get('profil') ?? 'privat';

const SITE: Site = {
  id: 'zuhause',
  name: 'Zuhause',
  biddingZone: 'DE-LU',
  latitude: 48.1,
  longitude: 11.6,
  plantKind: 'eigenverbrauch',
  tarifArt: 'fest',
  tarifParamCtKwh: 27.8,
  netzladenErlaubt: false,
  maxFeedInKw: null,
  profil: 'privat',
} as Site;

/** Stunden-Eimer eines Tages ab 00:00 Berlin (UTC+1 im November). */
function eimer(tag: string, netto: number[]) {
  const t0 = Date.parse(`${tag}T00:00:00+01:00`);
  return netto.map((n, i) => ({
    start: new Date(t0 + i * 3600_000).toISOString(),
    einspeiseErloesEur: 0,
    eigenverbrauchsWertEur: Math.max(0, n),
    stromkostenEur: Math.max(0, -n),
    nettoEur: n,
  }));
}
// Heute: Nacht und Morgen aus dem Netz, ab 8 Uhr Sonne - bis 12 Uhr −1,29 €.
const HEUTE = eimer('2026-11-13', [-0.25, -0.24, -0.23, -0.17, -0.14, -0.21, -0.3, -0.38, -0.08, 0.1, 0.27, 0.34, 0]);
// Gestern: sonniger Vormittag - bis 12 Uhr +0,36 €.
const GESTERN = eimer('2026-11-12', [-0.2, -0.19, -0.18, -0.15, -0.14, -0.2, -0.25, 0.1, 0.22, 0.42, 0.52, 0.41, 0.3, 0.2]);

function geld(series: ReturnType<typeof eimer>): SiteEarnings {
  const netto = series.reduce((s, b) => s + b.nettoEur, 0);
  const ev = series.reduce((s, b) => s + b.eigenverbrauchsWertEur, 0);
  const strom = series.reduce((s, b) => s + b.stromkostenEur, 0);
  return {
    siteId: SITE.id, name: SITE.name, plantKind: 'eigenverbrauch', tarifArt: 'fest', tarifParamCtKwh: 27.8,
    tarifPriced: true, exportVerguetungPriced: false, anzulegenderWertCtKwh: null, coveredSlots: 48,
    firstCoveredDate: '2026-11-01', reason: null, nettoErgebnisEur: netto, einspeiseErloesEur: 0,
    eigenverbrauchsWertEur: ev, stromkostenEur: strom, actualEur: strom, baselineEur: null, arbitrageEur: null,
    pvShiftEur: null, marktpraemieEur: 0, bezugspreisCtKwh: 27.8, realizedExportCtKwh: null,
    marketValueSolarCtKwh: null, marketValueProvisional: false, bezogenKwh: strom / 0.278, eingespeistKwh: 0,
    selbstverbrauchKwh: ev / 0.245, batterieBewegtKwh: 0, gesamtertragEur: ev, expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null, expectedMarketValueTo: null, expectedMarketValueSlots: null,
    steuerungSplitReason: null, series,
  } as unknown as SiteEarnings;
}

api.siteEarnings = (async (_id: string, range: string, at?: string | null) => {
  if (range !== 'day') return geld([...GESTERN, ...HEUTE]);
  return geld(at && at.startsWith('2026-11-12') ? GESTERN : HEUTE);
}) as unknown as typeof api.siteEarnings;
api.history = (async () => ({
  range: 'day', from: '2026-11-12T23:00:00Z', to: '2026-11-13T23:00:00Z', buckets: [],
  totals: { pvGenerationKwh: 6, consumptionKwh: 12, gridImportKwh: 8, gridExportKwh: 0, autarkiePct: 33, steuerungPlannedEur: null },
  protocol: [], plan: [], events: [],
  coverage: { firstDataAt: '2026-11-01T00:00:00Z', resolutionMinutes: 15, expected: 96, measured: 49, gaps: 0 },
})) as unknown as typeof api.history;

/** Reine Eigenverbrauchs-Anlage mit Speicher: kein Markt, keine Lastspitze. */
const PRIVAT = anlageSurface({
  entities: [],
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest' },
} as Parameters<typeof anlageSurface>[0]);

function Erloese() {
  const tabs = tabsFor(anlageSidebar(PRIVAT), 'erloese');
  return (
    <main className="vp-main" data-flaeche="erloese" style={{ padding: 16, minWidth: 0 }}>
      <BereichTabs tabs={tabs} active="erloese" label="Reiter des Bereichs Verlauf" onOpen={() => {}} />
      <ErloeseSection site={SITE} />
    </main>
  );
}

function Benutzer() {
  const me = rechteSeed('JW').me;
  setSelbstauskunft(me);
  keycloak.tokenParsed = { sub: me.kennung!, name: me.name!, tenant_id: me.kundenbereich!.id };
  unterstuetzungApi.liste = async () => [];
  unterstuetzungApi.anfragen = async () => [];
  unterstuetzungApi.hinweise = async () => [];
  benutzerApi.liste = async () => benutzerFixture().slice(0, 3);
  const [page, setPage] = useState<PageId>('kunden-benutzer');
  return (
    <AppShell page={page} onNavigate={setPage} isAdmin={false} showOverview={false}
      counts={{ sites: 1, devices: 0 }} tenants={[]} tenantOverride={null} onTenantChange={() => {}}>
      <BenutzerPage sites={[{ ...SITE, profil: profil === 'gewerbe' ? 'gewerbe' : 'privat' }]} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={{ minHeight: '100vh', background: 'var(--vp-c-bg, #f8fafc)' }}>
      {flaeche === 'benutzer' ? <Benutzer /> : <Erloese />}
    </div>
  </React.StrictMode>,
);
