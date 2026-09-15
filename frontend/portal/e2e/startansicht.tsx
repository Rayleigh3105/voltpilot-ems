import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  api,
  type FunktionStandort,
  type MessstellenRegisterAnfrage,
  type Overview,
  type OverviewSite,
  type Site,
} from '../src/api';
import { keycloak } from '../src/auth';
import { showAddAnlageButton } from '../src/addAnlage';
import { ohneGeld } from '../src/anlageGeld';
import {
  activeAreaKey,
  anlageSidebar,
  ebenenAktiv,
  ebenenBereiche,
  ebenenLeiste,
  ebenenOrt,
  ebenenReiter,
  ebenenTitel,
  type EbenenLesemodell,
  type EbenenSeiten,
} from '../src/ebenenNav';
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
import { EbenenTabs } from '../src/components/EbenenTabs';
import { PortfolioTabs } from '../src/components/PortfolioTabs';
import { consumersApi } from '../src/consumers/consumersApi';
import { healthBadge } from '../src/health';
import {
  anlageRoute,
  hashForRoute,
  kennzahlRoute,
  pageRoute,
  standortMessstellenRoute,
  standortRoute,
  type PageId,
  type Route,
} from '../src/nav';
import { ApiError, type KennzahlPeriodeArt } from '../src/api';
import { AnlagenPage } from '../src/pages/AnlagenPage';
import { KennzahlenPage } from '../src/pages/KennzahlenPage';
import { MessstellenPage } from '../src/pages/MessstellenPage';
import { PortfolioPage } from '../src/pages/PortfolioPage';
import { ahrenbergRegister } from '../src/test/messstellenRegisterFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from '../src/test/ortsbaumFixtures';
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
import { ahrenbergKennzahlen } from '../src/test/kennzahlenFixtures';
import {
  fassungenVon,
  kennzahlenDerWelt,
  kennzahlWerteAntwort,
  kennzahlWertVersionenAntwort,
} from '../src/test/kennzahlWerteFixtures';
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
/**
 * AP-11 IP-13: `&ansicht=kennzahlen` öffnet „Unternehmen › Kennzahlen“, `&ansicht=kennzahl&kz=KZ-0001` eine
 * Kennzahl-Seite; `&ausserhalb=KZ-0003` lässt die Werte-Route für diese Kennzahl mit 404 antworten (R-A7). Die
 * Werte (K1, K7, K8, K10, K11 aus den Vektoren) gelten zur Uhr der Bühne (`page.clock`).
 */
const kennzahlId = (kennzeichen: string | null) => kennzahlenDerWelt().find((k) => k.kennzeichen === kennzeichen)?.id ?? null;
const kzOffen = kennzahlId(params.get('kz'));
const kzAusserhalb = kennzahlId(params.get('ausserhalb'));
/**
 * AP-01 IP-7: `&seiten=kuenftig` stellt das Bild, sobald JEDER Bereich der Ebene
 * eine Seite hat (AP-04 IP-5, AP-13) — nur für die Vorschau; die Kacheln führen
 * in der Bühne auf die Übersicht der Ebene. Ohne den Schalter gilt der heutige
 * Stand (`EBENEN_SEITEN`).
 */
const KUENFTIG = params.get('seiten') === 'kuenftig';
const ALLE_SEITEN_KUENFTIG: EbenenSeiten = (ort) => {
  const hier = ort.art === 'unternehmen' ? pageRoute('portfolio') : standortRoute(ort.standortId);
  return {
    uebersicht: hier,
    standorte: pageRoute('portfolio-standorte'),
    gebaeude: hier,
    anlagen: hier,
    messstellen: hier,
    kennzahlen: hier,
    berichte: hier,
  };
};

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
  // AP-04 IP-5: das Messstellen-Register des Referenzunternehmens (heute = 20.10.2026, mit Stichtag und Filtern).
  messstellenRegister: async (a: MessstellenRegisterAnfrage = {}) => ahrenbergRegister(a),
  // AP-04 IP-6: was der Messstellen-Dialog beim Öffnen liest (Vorschlag, Standorte, Ortsbäume).
  kennzeichenVorschlag: async () => ({ kennzeichen: 'MS-0023' }),
  standorte: async () => structuredClone(szene.liste),
  standortOrte: async (id: string) => (id === werkLindach().id ? ortsbaumLindach() : ortsbaumAhrenberg()),
  // AP-11 IP-13: die Kennzahlen der Welt — gelesen zur Uhr der Bühne.
  kennzahlen: async () => ({ kennzahlen: kennzahlenDerWelt() }),
  kennzahl: async (id: string) => {
    const k = kennzahlenDerWelt().find((x) => x.id === id);
    if (!k) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    return k;
  },
  kennzahlFassungen: async (id: string) => ({
    kennzahl_id: id,
    kennzeichen: kennzahlenDerWelt().find((x) => x.id === id)?.kennzeichen ?? '',
    fassungen: fassungenVon(id),
  }),
  kennzahlWerte: async (id: string, periode: KennzahlPeriodeArt, von: string, bis: string) => {
    if (id === kzAusserhalb) throw new ApiError(404, 'Diese Kennzahl gibt es nicht.');
    return kennzahlWerteAntwort(id, periode, von, bis, Date.now());
  },
  kennzahlWertVersionen: async (id: string, periode: KennzahlPeriodeArt, von: string) =>
    kennzahlWertVersionenAntwort(id, periode, von, Date.now()),
  // IP-6: beide Funktionen je sichtbarem Standort (A7; `messen=bestand` = A11).
  funktionen: async () => funktionenDerSzene(),
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
/** `GET /funktionen` der Szene: beide Funktionen je sichtbarem Standort — dieselbe Antwort für Schale und Seite. */
function funktionenDerSzene() {
  return ahrenbergFunktionen({
    standorte: [funktionWerkAhrenberg(messenArt), funktionWerkLindach(messenArt)]
      .filter((f) => szene.liste.standorte.some((s) => s.id === f.id))
      .map(ohneAnlage),
  });
}

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
            : ansicht === 'messstellen'
              ? pageRoute('portfolio-messstellen')
              : ansicht === 'werk-messstellen'
                ? standortMessstellenRoute(FIXTURE_IDS.st1)
                : ansicht === 'lindach-messstellen'
                  ? standortMessstellenRoute(st2)
                  : ansicht === 'kennzahlen'
                    ? pageRoute('portfolio-kennzahlen')
                    : ansicht === 'kennzahl' && kzOffen
                      ? kennzahlRoute(kzOffen)
                      : pageRoute('uebersicht'),
    ),
  );
  useEffect(() => {
    document.body.dataset.route = hashForRoute(route);
  }, [route]);

  const navigate = (ziel: Route | PageId) => setRoute(kanonisch(typeof ziel === 'string' ? pageRoute(ziel) : ziel));
  const navigateSchale = (ziel: Route | PageId) => {
    if (ebene.art === 'standort' && ziel === 'portfolio') return navigate(flottenLandung(shell));
    if (ebene.art === 'standort' && ziel === 'portfolio-messstellen') return navigate(standortMessstellenRoute(ebene.standort.id));
    return navigate(ziel);
  };

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

  // UEMS AP-01 IP-7: die Leiste der Ebene aus denselben reinen Funktionen wie `App.tsx`.
  const lesemodell: EbenenLesemodell = {
    standorte: szene.liste.standorte,
    funktionen: funktionenDerSzene(),
    kennzahlen: ahrenbergKennzahlen(),
  };
  const ort = site ? null : ebenenOrt(route, ebene);
  const kacheln = ort ? ebenenLeiste(ort, lesemodell, KUENFTIG ? ALLE_SEITEN_KUENFTIG : undefined) : [];
  const ebenenNav =
    ort && kacheln.length > 0
      ? {
          titel: ebenenTitel(ort, lesemodell, szene.unternehmen.name ?? ''),
          kacheln,
          aktiv: ebenenAktiv(route.page, route.standortBereich),
          onOpen: (ziel: Route) => navigate(ziel),
        }
      : null;
  // AP-04 IP-5, wie `App.tsx`: der Reiter „Messstellen" nur, wo gemessen wird; am Telefon
  // entfallen die Reiter, die die Leiste trägt. `&reiter=alle` = Variante A der Vorschau (alle bleiben).
  const bereiche = ort ? ebenenBereiche(ort, lesemodell).map((b) => b.key) : [];
  const leiste = params.get('reiter') === 'alle' ? [] : kacheln.map((k) => k.key);
  const standortReiter =
    route.page === 'standort' && ebene.art !== 'standort' && ort?.art === 'standort' ? ebenenReiter(ort, lesemodell) : [];
  const portfolioReiter = (page: PageId) => (
    <PortfolioTabs
      page={page}
      showErloese={false}
      showMessstellen={bereiche.includes('messstellen')}
      showKennzahlen={bereiche.includes('kennzahlen')}
      leiste={leiste}
      fleetLabel={FLOTTE}
      onNavigate={navigateSchale}
    />
  );
  const messstellenEbene =
    route.page === 'portfolio-messstellen' && ebene.art === 'unternehmen'
      ? { art: 'unternehmen' as const, name: szene.unternehmen.name ?? '' }
      : route.page === 'portfolio-messstellen' && ebene.art === 'standort'
        ? { art: 'standort' as const, id: ebene.standort.id, name: ebene.standort.name }
        : route.page === 'standort' && route.standortBereich === 'messstellen' && standort
          ? { art: 'standort' as const, id: standort.id, name: standort.name }
          : null;

  return (
    <AppShell
      ebenen={ebenenNav}
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
          {portfolioReiter(
            ebene.art === 'standort' ? (route.standortBereich === 'messstellen' ? 'portfolio-messstellen' : 'portfolio') : route.page,
          )}
          {standortReiter.length > 0 && (
            <EbenenTabs
              reiter={standortReiter}
              aktiv={ebenenAktiv(route.page, route.standortBereich)}
              leiste={leiste}
              label={`Reiter des Standorts ${standort.name}`}
              onOpen={navigate}
            />
          )}
          {!route.standortBereich && (
            <StandortUebersichtPage
              standort={standort}
              sites={sites}
              onNavigate={navigate}
              onReload={() => undefined}
              betriebsart="endkunde"
            />
          )}
        </>
      )}
      {route.page === 'portfolio-messstellen' && portfolioReiter('portfolio-messstellen')}
      {route.page === 'portfolio-kennzahlen' && (
        <>
          {portfolioReiter('portfolio-kennzahlen')}
          <KennzahlenPage
            kennzahlId={route.kennzahlId ?? null}
            onOeffnen={(id) => navigate(kennzahlRoute(id))}
            onListe={() => navigate(pageRoute('portfolio-kennzahlen'))}
          />
        </>
      )}
      {messstellenEbene && (
        <MessstellenPage
          key={messstellenEbene.art === 'standort' ? messstellenEbene.id : 'unternehmen'}
          ebene={messstellenEbene}
          bereichDa={bereiche.includes('messstellen')}
          onUebersicht={() =>
            navigate(messstellenEbene.art === 'standort' ? standortRoute(messstellenEbene.id) : pageRoute('portfolio'))
          }
        />
      )}
      {route.page === 'portfolio' && (
        <>
          {portfolioReiter('portfolio')}
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
