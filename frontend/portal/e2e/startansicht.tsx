import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { api, type FunktionStandort, type Overview, type OverviewSite, type Site } from '../src/api';
import { keycloak } from '../src/auth';
import { showAddAnlageButton } from '../src/addAnlage';
import { ohneGeld } from '../src/anlageGeld';
import { activeAreaKey, anlageSidebar } from '../src/anlageNav';
import { anlagenOptionen } from '../src/anlagenWahl';
import {
  canonicalShellRoute,
  flottenLandung,
  kopfPfad,
  orteAus,
  pfadWert,
  pfadZeile,
  showOverviewNav,
  showPortfolioNav,
  startEbene,
  type PfadGlied,
  type ShellInput,
} from '../src/betriebsart';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { consumersApi } from '../src/consumers/consumersApi';
import { healthBadge } from '../src/health';
import { anlageRoute, hashForRoute, pageRoute, standortRoute, type PageId, type Route } from '../src/nav';
import { AnlagenPage } from '../src/pages/AnlagenPage';
import { PortfolioPage } from '../src/pages/PortfolioPage';
import { StandortUebersichtPage } from '../src/pages/StandortUebersichtPage';
import { AppShell } from '../src/shell/AppShell';
import { anlageSurface } from '../src/surface';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandEineAnlage,
  FIXTURE_IDS,
  werkAhrenberg,
  werkLindach,
} from '../src/test/standorteFixtures';
import { ahrenbergFunktionen, funktionWerkAhrenberg, funktionWerkLindach } from '../src/test/funktionenFixtures';
import type { UebersichtEbene } from '../src/uebersicht';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

/**
 * E2E-Bühne „Startansicht" (UEMS AP-01 IP-5): die ECHTE Schale mit dem ECHTEN
 * Pfad und den ECHTEN Seiten der Flotten-Ebene, entschieden von denselben reinen
 * Funktionen, die `App.tsx` ruft (`startEbene` → `canonicalShellRoute` →
 * `kopfPfad`). Die Cloud ist in der Bühne gestellt, nicht verdrahtet.
 *
 * Alle Namen und Werte aus dem Referenzunternehmen Ahrenberg
 * (`docs/contracts/v2/uems-referenzunternehmen.json`, Momentaufnahme 20.10.2026
 * 10:15): Netzbezug Halle 1 312,4 kW, PV 168,2 kW, Speicher 62 %; Halle 2
 * 96,5 kW; Werk Lindach 38,7 kW. Was die Datei nicht trägt (Verbrauch, Geld),
 * bleibt leer — nie eine erfundene Zahl.
 *
 * `?bild=einzel|standort|unternehmen|messkunde` — die drei Startbilder plus
 * Peter Hollerbach (nur Werk Lindach, AP-03-Teilansicht); `&ansicht=anlage`
 * öffnet Halle 1, `&ansicht=werk` die Standort-Übersicht Werk Ahrenberg,
 * `&ansicht=lindach` die Standort-Übersicht Werk Lindach. `&messen=bestand`
 * zeigt „Messen & Auswerten" wie nach dem Umstieg (A11: noch nicht eingerichtet).
 *
 * AP-01 IP-8: `&ansicht=steuerung-halle2` / `&ansicht=steuerung-lindach` öffnen
 * die ECHTE Steuerungsseite der zwei Anlagen, die nur messen (Halle 2 mit dem
 * Ladepunkt K-9, Werk Lindach ohne steuerbare Komponente); `bild=vor-lindach`
 * ist Ahrenberg mit angelegtem Werk Lindach, aber noch ohne Anlage AN-3.
 */

const { an1, an2, an3, st2 } = FIXTURE_IDS;
const STAND = '2026-10-20T08:15:00Z';
const params = new URLSearchParams(location.search);
const bild = params.get('bild') ?? 'einzel';
const ansicht = params.get('ansicht');
const messenArt = params.get('messen') === 'bestand' ? 'bestand' : 'eingerichtet';

Object.assign(keycloak, {
  token: 'e2e-token',
  authenticated: true,
  updateToken: async () => false,
  tokenParsed: { name: 'Jonas Wendlinger', email: 'jonas.wendlinger@example.test', realm_access: { roles: ['operator'] } },
});

const halle1 = { id: an1, name: 'Werk Ahrenberg – Halle 1', biddingZone: 'DE-LU' };
const halle2 = { id: an2, name: 'Werk Ahrenberg – Halle 2', biddingZone: 'DE-LU' };
const lindach = { id: an3, name: 'Werk Lindach', biddingZone: 'DE-LU' };

function zeile(
  site: { id: string; name: string },
  live: Partial<OverviewSite['live']>,
  roleCounts: OverviewSite['roleCounts'],
): OverviewSite {
  return {
    id: site.id,
    name: site.name,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: null,
    lastSeenAt: STAND,
    live: { ts: STAND, pvKw: null, loadKw: null, gridKw: null, socPct: null, ...live },
    plannedSavingsTodayEur: null,
    roleCounts,
  } as OverviewSite;
}

const ZEILEN: Record<string, OverviewSite> = {
  [an1]: zeile(halle1, { gridKw: 312.4, pvKw: 168.2, socPct: 62 }, { pv: 1, storage: 1, consumer: 0, grid: 1 }),
  [an2]: zeile(halle2, { gridKw: 96.5 }, { pv: 0, storage: 0, consumer: 1, grid: 1 }),
  [an3]: zeile(lindach, { gridKw: 38.7 }, { pv: 0, storage: 0, consumer: 0, grid: 1 }),
};

const SZENEN = {
  /** Ahrenberg bis 30.09.2026: der Standort aus der Bestandsübernahme, eine Anlage. */
  einzel: {
    sites: [halle1],
    liste: bestandEineAnlage(),
    unternehmen: ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1, sitz: null }),
  },
  /** Ahrenberg 01.10.–14.10.2026: Werk Ahrenberg mit Halle 1 und Halle 2. */
  standort: {
    sites: [halle1, halle2],
    liste: { ...ahrenbergHeute(), standorte: [werkAhrenberg()] },
    unternehmen: ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 2 }),
  },
  /** Ahrenberg am 20.10.2026: zwei Standorte, drei Anlagen. */
  unternehmen: {
    sites: [halle1, halle2, lindach],
    liste: ahrenbergHeute(),
    unternehmen: ahrenbergUnternehmen(),
  },
  /** Peter Hollerbach am 20.10.2026: Zugriff nur auf Werk Lindach — der reine Messkunde (A13). */
  messkunde: {
    sites: [lindach],
    liste: { ...ahrenbergHeute(), standorte: [werkLindach()] },
    unternehmen: ahrenbergUnternehmen(),
  },
  /** IP-8: Werk Lindach ist angelegt, AN-3 noch nicht — der Leerzustand der Standort-Übersicht. */
  'vor-lindach': {
    sites: [halle1, halle2],
    liste: { ...ahrenbergHeute(), standorte: [werkAhrenberg(), werkLindach({ anlagen: [], anlagenZahl: 0 })] },
    unternehmen: ahrenbergUnternehmen({ anlagenZahl: 2 }),
  },
};

const szene = SZENEN[bild as keyof typeof SZENEN] ?? SZENEN.einzel;
const sites = szene.sites as Site[];
const siteIds = sites.map((s) => s.id);

// Die gestellte Cloud: nur, was die Flotten-Fläche liest.
const overview: Overview = {
  sites: siteIds.map((id) => ZEILEN[id]),
  totals: {
    sites: siteIds.length,
    devices: siteIds.length,
    online: siteIds.length,
    plannedSavingsTodayEur: null,
    liveSitesCovered: siteIds.length,
  },
  dailySavings: [],
};
Object.assign(api, {
  overview: async () => structuredClone(overview),
  earnings: async () => {
    throw new Error('Das Referenzunternehmen trägt keine Geldwerte.');
  },
  tenantCockpitLayout: async () => ({ vorgabe: null, eigen: null }),
  // IP-6: beide Funktionen je sichtbarem Standort (A7; `messen=bestand` = A11).
  funktionen: async () =>
    ahrenbergFunktionen({
      standorte: [funktionWerkAhrenberg(messenArt), funktionWerkLindach(messenArt)]
        .filter((f) => szene.liste.standorte.some((s) => s.id === f.id))
        .map(ohneAnlage),
    }),
  // IP-8: die Steuerungsseite einer Anlage, die nur misst. Gestellt ist, was
  // die Zonen lesen (seit der Steuern-Regel ohne Hinweis); der Rest antwortet wie ein älteres Backend.
  siteEntities: async (id: string) => ({ registry: null, localSetup: [], staleOnDevice: [], entities: komponentenVon(id) }),
  siteVerbraucher: async (id: string) => verbraucherVon(id),
  entityStrategies: async () => ({}),
  usageProfile: nichtGestellt,
  siteProfiles: nichtGestellt,
  siteAssets: nichtGestellt,
  siteChargers: nichtGestellt,
  siteFahrzeuge: nichtGestellt,
  curtailmentStatus: nichtGestellt,
  siteInterventions: nichtGestellt,
  siteRuleEvents: nichtGestellt,
  suggestionStates: nichtGestellt,
});
Object.assign(consumersApi, {
  options: async () => ({ types: [], signals: [], intents: [], hasStorage: false, reportedSources: [] }),
  list: async () => [],
  status: async () => [],
  overrides: async () => [],
  fulfillment: async () => ({ tasks: [] }),
});
// Die Regeln der Anlage: keine. Nur die zwei Flow-Routen gehen über `fetch`.
const echtesFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (/^\/api\/v1\/sites\/[^/]+\/flows$/.test(url.pathname)) return Response.json([]);
  if (url.pathname.endsWith('/flow-node-governance')) return Response.json({ gatedNodes: [] });
  return echtesFetch(input, init);
};

async function nichtGestellt(): Promise<never> {
  throw new Error('In der Bühne nicht gestellt.');
}

/** IP-8: ein Standort ohne Anlage misst noch nicht und hat keine Teilnahme. */
function ohneAnlage(f: FunktionStandort): FunktionStandort {
  const hier = szene.liste.standorte.find((s) => s.id === f.id);
  if (!hier || hier.anlagen.length > 0) return f;
  return { ...f, messen: funktionWerkLindach('bestand').messen, steuern: { ...f.steuern, anlagen: [] } };
}

/** Die Komponenten der zwei Messanlagen aus dem Referenzunternehmen (Halle 2: Netz + K-9; Lindach: Netz). */
function komponentenVon(id: string) {
  const netz = { id: `${id}-netz`, entityType: 'grid-meter', typeLabel: 'Netzanschluss', role: 'grid', label: 'Hauptzähler', capabilities: { measure: [{ channel: 'power_kw' }] } };
  if (id !== an2) return [netz];
  return [
    netz,
    { id: 'k-9', entityType: 'ev-charger', typeLabel: 'Ladepunkt', role: 'consumer', label: 'Ladepunkt Parkplatz Halle 2 (22 kW)', capabilities: { measure: [{ channel: 'power_kw' }] } },
  ];
}

/** Die Verbraucher-Zone: Halle 2 trägt K-9 („Nur messen", keine Steuerart gesetzt), Lindach nichts. */
function verbraucherVon(id: string) {
  const k9 = {
    entityId: 'k-9',
    name: 'Ladepunkt Parkplatz Halle 2 (22 kW)',
    typ: 'ev-charger',
    typLabel: 'Ladepunkt',
    ladepunkt: true,
    chargePointId: 'AHR-LP-01',
    steuerart: { quelle: 'sofort', herkunft: 'ohne' },
    regeln: 0,
  };
  const zuHalle2 = id === an2;
  return {
    verbraucher: zuHalle2 ? [k9] : [],
    ladepunkte: { standard: null, standardFolger: 0, gesamt: zuHalle2 ? 1 : 0, rahmen: null },
    rangliste: [],
  };
}

const surface = anlageSurface({
  entities: [{ id: 'speicher', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } }],
  config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch' },
} as Parameters<typeof anlageSurface>[0]);

/** IP-8: Halle 1 wie bisher; die zwei Messanlagen mit dem Lese-Modell OHNE Geld, wie `useAnlageSurface` es bildet. */
function surfaceVon(id: string) {
  if (id === an1) return surface;
  return ohneGeld(
    anlageSurface({ entities: komponentenVon(id), config: { plantKind: 'eigenverbrauch', tarifArt: 'ohne' } } as Parameters<
      typeof anlageSurface
    >[0]),
  );
}

const FLOTTE = 'Meine Anlagen';

function Vorschau() {
  const rahmen = { isAdmin: false, loaded: true, tenantReady: true, betriebsart: 'endkunde' as const };
  const orte = orteAus(szene.liste, szene.unternehmen);
  const ebene = startEbene({ ...rahmen, siteIds, orte });
  const shell: ShellInput = { ...rahmen, siteCount: siteIds.length, ebene };
  const kanonisch = (r: Route) => canonicalShellRoute({ shell, route: r, siteIds }) ?? r;
  const [route, setRoute] = useState<Route>(() =>
    kanonisch(
      ansicht === 'anlage'
        ? anlageRoute(an1)
        : ansicht === 'steuerung-halle2'
          ? anlageRoute(an2, 'steuerung')
          : ansicht === 'steuerung-lindach'
            ? anlageRoute(an3, 'steuerung')
            : ansicht === 'lindach'
          ? standortRoute(st2)
          : ansicht === 'werk'
            ? standortRoute(FIXTURE_IDS.st1)
            : pageRoute('uebersicht'),
    ),
  );
  useEffect(() => {
    document.body.dataset.route = hashForRoute(route);
  }, [route]);

  const navigate = (ziel: Route | PageId) => setRoute(kanonisch(typeof ziel === 'string' ? pageRoute(ziel) : ziel));
  const navigateSchale = (ziel: Route | PageId) =>
    navigate(ziel === 'portfolio' && ebene.art === 'standort' ? flottenLandung(shell) : ziel);

  const site = route.page === 'anlagen' ? sites.find((s) => s.id === route.siteId) ?? null : null;
  const pfad = kopfPfad({ shell, route, anlageId: site?.id ?? null, fleetLabel: FLOTTE });
  const eintrag = (g: PfadGlied) => ({ wert: pfadWert(g), label: g.label, onOpen: () => navigate(g.route) });
  const rueckwege = pfad.vor.some((g) => g.ebene !== 'flotte') ? pfad.vor.map(pfadZeile) : undefined;
  const flotte = showPortfolioNav(shell) || showOverviewNav(shell);
  const standort =
    route.page === 'standort' ? szene.liste.standorte.find((s) => s.id === route.standortId) ?? null : null;
  // Wie `App.tsx`: bei mehreren Standorten ist `#/portfolio` die Unternehmens-Übersicht.
  const unternehmensEbene: UebersichtEbene | null =
    ebene.art === 'unternehmen'
      ? { art: 'unternehmen', name: szene.unternehmen.name ?? '', standorte: szene.liste.standorte }
      : null;

  return (
    <AppShell
      page={route.page}
      onNavigate={navigateSchale}
      isAdmin={false}
      showOverview={showOverviewNav(shell)}
      showPortfolio={showPortfolioNav(shell)}
      fleetLabel={FLOTTE}
      showAddAnlage={showAddAnlageButton({ ...rahmen, onboarding: false, siteCount: siteIds.length })}
      onAddAnlage={() => undefined}
      counts={{ sites: siteIds.length, devices: siteIds.length }}
      tenants={[]}
      tenantOverride={null}
      onTenantChange={() => undefined}
      anlage={
        site
          ? {
              siteId: site.id,
              siteName: site.name,
              sites,
              siteOptions: anlagenOptionen({
                sites,
                devices: { devices: [], fetchedAt: null },
                mitFlotte: sites.length > 1,
                flottenLabel: FLOTTE,
                rueckwege,
              }),
              onSelectSite: (id) => navigate(anlageRoute(id)),
              sidebar: anlageSidebar(surfaceVon(site.id), 0),
              activeKey: activeAreaKey(route.sub ?? null),
              onOpenSub: (sub) => navigate(anlageRoute(site.id, sub ?? null)),
              onOpenPage: (p) => navigate(p),
              onOpenFleet: flotte ? () => navigate(flottenLandung(shell)) : null,
              health: healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } }),
              pfad: pfad.vor.map(eintrag),
            }
          : null
      }
      ortsPfad={!site && pfad.hier ? { vor: pfad.vor.map(eintrag), hier: pfad.hier } : null}
    >
      {site && route.sub && (
        <AnlagenPage
          sites={sites}
          devices={[]}
          devicesFetchedAt={null}
          route={route}
          onNavigate={navigate}
          onReload={() => undefined}
          surface={surfaceVon(site.id)}
        />
      )}
      {site && !route.sub && (
        <div className="vp-page-head">
          <div className="titles">
            <h1>{site.name}</h1>
            <p>Das Cockpit dieser Anlage bleibt unverändert — die Bühne zeigt nur Kopfzeile, Pfad und Navigation.</p>
          </div>
        </div>
      )}
      {route.page === 'standort' && standort && (
        <>
          <PortfolioTabs
            page={ebene.art === 'standort' ? 'portfolio' : route.page}
            showErloese={false}
            fleetLabel={FLOTTE}
            onNavigate={navigateSchale}
          />
          <StandortUebersichtPage
            standort={standort}
            sites={sites}
            onNavigate={navigate}
            onReload={() => undefined}
            betriebsart="endkunde"
          />
        </>
      )}
      {route.page === 'portfolio' && (
        <>
          <PortfolioTabs page="portfolio" showErloese={false} fleetLabel={FLOTTE} onNavigate={navigateSchale} />
          <PortfolioPage
            sites={sites}
            onNavigate={navigate}
            onReload={() => undefined}
            betriebsart="endkunde"
            ebene={unternehmensEbene}
          />
        </>
      )}
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Vorschau />
  </React.StrictMode>,
);
