import { lazy, useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import {
  api,
  type ControlStatus,
  type CurtailmentStatus,
  type Device,
  type EarningsRange,
  type History,
  type HistoryTotals,
  type Overview,
  type SchedulePlan,
  type Site,
  type SiteEarnings,
  type SiteSource,
  type TelemetryPoint,
} from '../api';
import { BATTERY_NO_DEVICE_WARNING, composeSiteSentence, siteLiveFresh, siteSnapshot } from '../fleet';
import { plantKindLabel } from '../format';
import { DEFAULT_EARNINGS_RANGE } from '../anlage';
import { anlageRoute, pageRoute, type AnlagenSub, type Route } from '../nav';
import { useFreshnessPoll } from '../useFreshnessPoll';
import { useIsPhone } from '../useIsPhone';
import { useScrolledPast } from '../useScrolledPast';
import { useWake } from '../useWake';
import { nextHourIndex, weatherWhy } from '../weather';
import { controlReasonSlot, controlStrip, nextChargeStart, planOutlook } from '../control';
import { curtailTruth, curtailTruthForSlot } from '../curtailment';
import { flowConflict, flowConflictCandidate, stepFlowConflict } from '../flowConflict';
import { todaySlots } from '../schedule';
import { slotWhy, surplusWhy } from '../fahrplanWhy';
import { healthChecklist, type AnlageHealthFacts } from '../health';
import { AnlageAnlegenDrawerLazy as AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawerLazy';
import { resolveAnlage } from '../anlageNav';
import { consumersApi } from '../consumers/consumersApi';
import { consumerStrip, type ConsumerStripView } from '../consumers/fulfillment';
import { ControlStrip } from '../components/ControlStrip';
import { useAdaptiveLive } from '../useAdaptiveLive';
import { liveState, type LiveState } from '../adaptiveLive';
import { flowHasValues, headSentenceVisible, liveChip } from '../liveDetail';
import { leadBlock } from '../leadSlot';
import { useAnlageSurface } from '../useAnlageSurface';
import type { AnlageSurface } from '../surface';
import { anlageDecision, hasBlock } from '../cockpit';
import {
  cockpitHero,
  cockpitWidgets,
  historyRangeForCockpit,
  mobileWidgets,
  stickyHead,
  type WidgetDef,
} from '../cockpitWidgets';
import { CockpitHero } from '../components/CockpitHero';
import {
  MobileMoneyCard,
  MobileStickyHead,
} from '../components/CockpitBlocks';
import { KomponentenSection } from '../components/KomponentenSection';
import { ZustandCard } from '../components/ZustandCard';
import { StrompreisStrip } from '../components/StrompreisStrip';
import { gateStrompreis } from '../strompreis';
import { WidgetGrid } from '../components/WidgetGrid';
import { AnlageSetup } from '../components/AnlageSetup';
import { SETUP_STATUS_LINE, setupPathActive } from '../setupPath';
import { peakBand, quarterHourMeanImportKw } from '../peakBand';
import { FahrplanBand } from '../components/FahrplanBand';
import { FleetSiteCard } from '../components/FleetOverview';
import { PeriodTabs } from '../components/MoneyView';
import { NetzladenBadge } from '../components/NetzladenBadge';
import { ErrorState, Skeleton } from '../components/States';
import { LazyBoundary } from '../components/Lazy';
// Die Unterseiten einer Anlage werden LAZY geladen. Das Cockpit (`sub === null`)
// zeichnet keine von ihnen, zog aber über den statischen Import ihre gesamte
// Fracht ins Einstiegs-Bündel: ECharts (jede Diagramm-Fläche), Leaflet (die
// Karte auf „Einstellungen"), den Automations-Editor. Gemessen war das der
// grösste Einzelposten der Ladezeit - siehe `components/Lazy.tsx`.
const FahrplanSection = lazy(() =>
  import('./DataPages').then((m) => ({ default: m.FahrplanSection })),
);
const WetterSection = lazy(() =>
  import('./DataPages').then((m) => ({ default: m.WetterSection })),
);
const MesswerteSection = lazy(() =>
  import('./MesswerteSection').then((m) => ({ default: m.MesswerteSection })),
);
const ErloeseSection = lazy(() =>
  import('./ErloeseSection').then((m) => ({ default: m.ErloeseSection })),
);
const AnlagenModellSection = lazy(() =>
  import('./AnlagenModellSection').then((m) => ({ default: m.AnlagenModellSection })),
);
const LastspitzenSection = lazy(() =>
  import('./LastspitzenSection').then((m) => ({ default: m.LastspitzenSection })),
);
const SteuerungSection = lazy(() =>
  import('./SteuerungSection').then((m) => ({ default: m.SteuerungSection })),
);
const TechnikSection = lazy(() =>
  import('./AnlageTechnik').then((m) => ({ default: m.TechnikSection })),
);

/** Background refresh cadence of the live widgets (30 s poll pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness note. */
const TICK_MS = 5_000;
/**
 * Die knappe, begründete Frist, bevor eine hängende Entscheidungs-Eingabe
 * (Netz hängt, Backend antwortet nie) als Fehlschlag behandelt wird - "kein
 * Dauer-Spinner" (Captain-Nachtrag 06.08.2026). Am `BOOT_TIMEOUT_MS`-Präzedenz
 * orientiert (`src/boot.ts`).
 */
const ANLAGE_DECISION_TIMEOUT_MS = 10_000;

export interface AnlagenPageProps {
  sites: Site[];
  devices: Device[];
  /**
   * Bezugszeit der Geräteliste (Epoch-ms der Server-Antwort). Lebendigkeit wird
   * dagegen gemessen, nie gegen eine Uhr, die über einen nicht erneuerten
   * Schnappschuss hinausläuft - siehe `src/liveness.ts`.
   */
  devicesFetchedAt?: number | null;
  route: Route;
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
  /**
   * Reports the health facts only this page measures (plan / control / battery
   * link) up to the shell, so the top-bar badge and the plant's own Zustand
   * card are ONE truth. Absent facts stay absent — `healthBadge` drops every
   * row it was not given, so the badge never claims health it did not measure.
   */
  onHealthFacts?: (siteId: string, facts: AnlageHealthFacts) => void;
  /**
   * Das M0-Lese-Modell der Anlage, wie es die Schale ohnehin schon geladen hat
   * (`App.tsx` `useAnlageSurface`) - durchgereicht, damit die Historie-Welten
   * KEINEN eigenen Abruf brauchen, um zu wissen, ob es die Erlöse-Welt gibt.
   */
  surface?: AnlageSurface | null;
}

/**
 * "Meine Anlage(n)": ONE site = ONE Anlage (captain decision 2026-07-07).
 * Single-Anlage customers land straight on their Anlagen-Seite; fleets get
 * the Anlagen list and drill in per card. `#/anlage/{siteId}` addresses one
 * Anlage, `#/anlage/{siteId}/{sub}` its deep views (the former Live-Daten/
 * Fahrplan/Historie/Wetter menu items). A legacy hash without a site id
 * (e.g. `#/fahrplan`) resolves to the single Anlage or falls back to the
 * list when the customer has several.
 */
export function AnlagenPage(props: AnlagenPageProps) {
  const { sites, route, onNavigate, isAdmin = false } = props;

  if (sites.length === 0) {
    return <AnlagenEmpty onReload={props.onReload} isAdmin={isAdmin} />;
  }

  // The SAME resolution the shell uses to scope its trio (anlageNav.ts).
  const site = resolveAnlage(sites, route.siteId);

  if (!site) {
    return (
      <AnlagenListe
        sites={sites}
        onOpen={(id) => onNavigate(anlageRoute(id))}
        onReload={props.onReload}
      />
    );
  }

  // Portal v3 M1: every area of an Anlage lives in the SHELL now - the grouped
  // sidebar (base group + one group per active mode) plus the phone 5-slot
  // bottom bar with its Mehr sheet (`anlageNav.ts`). The page head carries no
  // navigation of its own any more; the cockpit's drill-in links stay as
  // shortcuts. Routes are unchanged, so every bookmark keeps working.
  return route.sub ? (
    <AnlagenSubPage
      site={site}
      sites={sites}
      devices={props.devices}
      devicesFetchedAt={props.devicesFetchedAt ?? null}
      sub={route.sub}
      isAdmin={isAdmin}
      surface={props.surface ?? null}
      onBack={() => onNavigate(anlageRoute(site.id))}
      onOpenSub={(sub) => onNavigate(anlageRoute(site.id, sub))}
      onReload={props.onReload}
    />
  ) : (
    <AnlageSeite
      {...props}
      site={site}
      onOpenSub={(sub) => onNavigate(anlageRoute(site.id, sub))}
      onBackToList={
        sites.length > 1 ? () => onNavigate({ page: 'anlagen', siteId: null, sub: null }) : null
      }
    />
  );
}

/** Customer without any Anlage yet (admins: an empty tenant). */
function AnlagenEmpty({
  onReload,
  isAdmin,
}: {
  onReload: (selectSiteId?: string) => void;
  isAdmin: boolean;
}) {
  const [drawer, setDrawer] = useState(false);
  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Meine Anlage</h1>
          <p>
            {isAdmin
              ? 'Dieser Mandant hat noch keine Anlage.'
              : 'Hier erscheint Ihre Anlage: Live-Daten, Fahrplan, Technik und Erlöse an einem Ort.'}
          </p>
        </div>
      </div>
      <Card padding="lg" radius="lg">
        <div className="vp-empty">
          <IconTile category="solar" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
            <Icon name="sun" size={24} />
          </IconTile>
          <h3>{isAdmin ? 'Dieser Mandant hat noch keine Anlage' : 'Noch keine Anlage'}</h3>
          <p>
            {isAdmin
              ? 'Sobald für diesen Mandanten eine Anlage angelegt ist, erscheint sie hier. Sie können im Namen des Mandanten eine Anlage anlegen.'
              : 'Legen Sie Ihre Anlage an - danach verbinden Sie Ihr Gerät und sehen Live-Daten, Fahrplan und Erlöse.'}
          </p>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDrawer(true)}>
            Anlage anlegen
          </Button>
        </div>
      </Card>
      <AnlageAnlegenDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </>
  );
}

/** The fleet's Anlagen list: one card per Anlage, tap to open its Seite. */
function AnlagenListe({
  sites,
  onOpen,
  onReload,
}: {
  sites: Site[];
  onOpen: (siteId: string) => void;
  onReload: (selectSiteId?: string) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    let active = true;
    api.overview().then(
      (o) => {
        if (!active) return;
        setOverview(o);
        setFailed(false);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [reloadKey, sites]);

  // Freshness tick + silent background poll (the fleet-mode pattern). Der
  // DATEN-Takt läuft über `useFreshnessPoll`, damit die Rückkehr in einen
  // verdeckten Tab sofort nachholt statt den Stand von vorhin zu zeigen.
  useFreshnessPoll(() => {
    setNow(new Date());
    api.overview().then(
      (o) => setOverview(o),
      () => {},
    );
  }, POLL_MS);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Meine Anlagen</h1>
          <p>Wählen Sie eine Anlage - jede hat ihre eigene Seite.</p>
        </div>
        <div className="actions">
          <Button variant="outline" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDrawer(true)}>
            Anlage anlegen
          </Button>
        </div>
      </div>

      {overview == null && failed ? (
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Ihre Anlagen konnten gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
      ) : overview == null ? (
        <div className="vp-grid vp-fleet-grid">
          <Skeleton height={190} radius="var(--vp-radius-lg)" />
          <Skeleton height={190} radius="var(--vp-radius-lg)" />
          <Skeleton height={190} radius="var(--vp-radius-lg)" />
        </div>
      ) : (
        <div className="vp-grid vp-fleet-grid">
          {overview.sites.map((s) => (
            <FleetSiteCard
              key={s.id}
              site={s}
              earnings={null}
              now={now}
              onOpen={() => onOpen(s.id)}
            />
          ))}
        </div>
      )}

      <AnlageAnlegenDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        existingSites={sites}
        onChanged={(createdSiteId) => onReload(createdSiteId)}
      />
    </>
  );
}

/**
 * Titel + Untertitel je Unterseite. **Die zwei Historie-Welten stehen bewusst
 * NICHT darin**: sie tragen ihren eigenen Welt-Kopf (Icon · Titel · Abzeichen ·
 * Kartenpaar), und eine zweite generische Überschrift darüber wäre genau die
 * Kopfzone, die das Konzept abbaut.
 */
const SUB_PAGES: Partial<Record<AnlagenSub, { title: string; subtitle: string }>> = {
  fahrplan: {
    title: 'Fahrplan',
    subtitle: 'Kostenoptimaler Batterie-Fahrplan aus Börsenpreisen und Prognosen.',
  },
  wetter: {
    title: 'Wetter',
    subtitle: 'Die Vorhersage am Standort Ihrer Anlage - Grundlage der PV-Prognose.',
  },
  technik: {
    // D2 (Captain, 31.07.2026): die Seite heisst „Einstellungen". Der Untertitel
    // nennt seit E1 wieder das, was dort auch WIRKLICH steht - Stromtarif und
    // Vergütung sind zurueck (Konzept `vp-settings-ux-konzept` §3.4).
    title: 'Einstellungen',
    subtitle:
      'Stromtarif, Vergütung, Speicher, Wechselrichter und der Standort Ihrer Anlage - an einem Ort.',
  },
  modell: {
    title: 'Anlagen-Modell',
    subtitle: 'So ist Ihre Anlage verschaltet: Geräte, Komponenten und was das Cockpit daraus macht.',
  },
  steuerung: {
    title: 'Steuerung',
    // EIN Satz, kein Technik-Vokabular: „Steuerungs-Flows" ist unser Wort fuer
    // die Regel-Dokumente, nicht das des Kunden - und vier Zeilen Untertitel
    // schoben am Telefon die Kapseln unter den Falz (Mobil-Umbau Stufe 4).
    subtitle: 'Was Ihre Anlage automatisch tut - und was es bringt.',
  },
  lastspitzen: {
    title: 'Lastspitzen',
    subtitle:
      'Lastspitzenkappung: gehaltene Spitze, vermiedene Leistungskosten und der Fahrplan zum Halten Ihrer Zielspitze.',
  },
};

/** One deep view of an Anlage, with the way back always in sight. */
function AnlagenSubPage({
  site,
  sites,
  devices,
  devicesFetchedAt,
  sub,
  isAdmin,
  surface,
  onBack,
  onOpenSub,
  onReload,
}: {
  site: Site;
  sites: Site[];
  devices: Device[];
  devicesFetchedAt: number | null;
  sub: AnlagenSub;
  isAdmin: boolean;
  surface: AnlageSurface | null;
  onBack: () => void;
  onOpenSub: (sub: AnlagenSub) => void;
  onReload: (selectSiteId?: string) => void;
}) {
  const meta = SUB_PAGES[sub];
  return (
    <>
      <button type="button" className="vp-fleet-back" onClick={onBack}>
        <Icon name="chevron-left" size={18} />
        Anlage {site.name}
      </button>
      {meta && (
        <div className="vp-page-head">
          <div className="titles">
            <h1>{meta.title}</h1>
            <p>{meta.subtitle}</p>
          </div>
        </div>
      )}
      <LazyBoundary>
        {sub === 'fahrplan' && <FahrplanSection site={site} />}
        {sub === 'messwerte' && (
          <MesswerteSection
            site={site}
            surface={surface}
            onOpenWelt={(welt) => onOpenSub(welt)}
          />
        )}
        {sub === 'erloese' && (
          <ErloeseSection site={site} surface={surface} onOpenWelt={(welt) => onOpenSub(welt)} />
        )}
        {sub === 'wetter' && <WetterSection site={site} />}
      {/* The Anlagen-Modell names the ONE VoltPilot-Box every reported device
          hangs off (Captain-Korrektur) — from the devices list the shell already
          holds and keeps fresh, so this page adds no request of its own. Its
          Bezugszeit travels along: der Zustand der Box altert gegen die
          Server-Antwort, nie gegen eine weiterlaufende Uhr (`liveness.ts`). */}
        {sub === 'modell' && (
          <AnlagenModellSection site={site} devices={devices} devicesFetchedAt={devicesFetchedAt} />
        )}
        {sub === 'lastspitzen' && <LastspitzenSection site={site} />}
        {sub === 'steuerung' && (
          <SteuerungSection
            site={site}
            isAdmin={isAdmin}
            onOpenSub={onOpenSub}
            onSiteSaved={(updated) => onReload(updated.id)}
          />
        )}
        {sub === 'technik' && (
          <TechnikSection
            site={site}
            devices={devices}
            sites={sites}
            onReload={onReload}
            onSiteSaved={(updated) => onReload(updated.id)}
            onSiteDeleted={onBack}
          />
        )}
      </LazyBoundary>
    </>
  );
}

/**
 * THE Anlagen-Seite: one scrollable story per Anlage (captain mockup order) -
 * Kopf (name, status dot, one German sentence, badges), Geld (the measured
 * EarningsHero, site-scoped), Jetzt (energy flow + link into the live depth),
 * Fahrplan (mini preview + one derived German sentence + today's planned
 * saving), Technik (Wechselrichter/Speicher/Register/Standort - everything
 * that used to live on Standorte/Geräte), and Mehr (Historie & Erlöse,
 * Wetter). All wording derivation is pure (fleet.ts / schedule.ts).
 */
export function AnlageSeite({
  site,
  sites,
  onOpenSub,
  onBackToList,
  onNavigate,
  onReload,
  onHealthFacts,
}: AnlagenPageProps & {
  site: Site;
  onOpenSub: (sub: AnlagenSub) => void;
  onBackToList: (() => void) | null;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  // Das GEMESSENE Geld dieser Anlage. Seit dem Perf-Audit (vp-portal-perf-a4,
  // B2) vom anlagen-scharfen `/sites/{id}/earnings` (3 Queries, ~0,42 s) statt
  // vom mandantenweiten `/earnings` (8 Queries, 1,8 s bei range=year) mit
  // Client-Filter - der Flotten-Endpunkt bleibt der Portfolio-Seite.
  const [siteEarnings, setSiteEarnings] = useState<SiteEarnings | null>(null);
  // The period tabs govern the whole page (captain 2026-07-07). `at` is the
  // selected instance (a month tapped in the strip); null = the current period.
  // Die Voreinstellung ist „Heute" und steht an EINER Stelle (`anlage.ts`);
  // eine getroffene Wahl gewinnt danach wie bisher (Captain 2026-07-30).
  const [range, setRange] = useState<EarningsRange>(DEFAULT_EARNINGS_RANGE);
  const [at, setAt] = useState<string | null>(null);
  const [nextHourTempC, setNextHourTempC] = useState<number | null>(null);
  const [weatherWhyText, setWeatherWhyText] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<ControlStatus | null>(null);
  // Die Abregel-Wahrheit (PR 3): setzt die Anlage eine geplante Drosselung
  // wirklich um? Eigener Abruf (der Herzschlag-Block kommt unabhängig vom
  // Rücklese-Block), fail-soft - null = kein Beleg = Plan-Wortlaut.
  const [curtailStatus, setCurtailStatus] = useState<CurtailmentStatus | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planFailed, setPlanFailed] = useState(false);
  // U4: recent telemetry for the peak face's live ¼-h mean (fetched only when
  // the cockpit leads with the Peak-Band - see the gated effect below).
  const [peakSamples, setPeakSamples] = useState<TelemetryPoint[]>([]);
  // M3: today's Historie totals feed the Eigenverbrauchs-Block (Autarkie /
  // PV-Nutzung); since v3 M2 they ALSO feed the cockpit hero's rings and the
  // Haus/Netz widgets, so the projection path fetches them once for all of it.
  const [dayTotals, setDayTotals] = useState<HistoryTotals | null>(null);
  // v3.2 M1: the hero rings (Autarkie / Eigenverbrauch) follow the SELECTED
  // period tab, so they read range-scoped Historie totals (day/month/year) -
  // distinct from `dayTotals`, which stays "today" for the widget grid. The
  // energy flow stays live regardless. null while loading / for "Gesamt".
  // v3.2 M2: the SAME range-scoped Historie also feeds the rich widget-detail
  // modal's Verlauf chart (one fetch, buckets + totals), so we keep the whole
  // `History` and derive the totals from it.
  const [rangeHistory, setRangeHistory] = useState<History | null>(null);
  const rangeTotals: HistoryTotals | null = rangeHistory?.totals ?? null;
  // The site's measurement points (primary inverter + configured sources), so
  // the hero can explain a multi-inverter site's composite PV (#524).
  // Fail-soft: an older backend simply yields no breakdown.
  const [sources, setSources] = useState<SiteSource[] | null>(null);
  // Der Cockpit-Verbraucherstreifen (§14.10): steuerbare Verbraucher + ihr
  // Live-Zustand, fail-soft geladen. Ohne Verbraucher / auf einem älteren
  // Backend bleibt es null und das Cockpit ist byte-identisch zu vorher.
  const [consumersView, setConsumersView] = useState<ConsumerStripView | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  // Aufwach-Signal: die drei BEDINGTEN Lade-Effekte unten holen beim Betreten
  // sofort und hängen sonst nur an einem Intervall - das ein verdeckter Tab
  // drosselt oder einfriert. `wake` in ihrer Abhängigkeitsliste lässt sie beim
  // Zurückkommen (auch aus dem bfcache) erneut laufen, ihre Bedingungen und
  // Abbruch-Wächter bleiben unangetastet (`useWake.ts`).
  const wake = useWake();
  // Mobil-Umbau Stufe 2: unterhalb der Telefon-Grenze rendert das Cockpit eine
  // eigene KOMPOSITION (Konzept `data/vp-mobile-views-x1`, Sektion „Cockpit").
  // Ohne `matchMedia` (jsdom/SSR) ist das `false` — also die Bühne, unverändert.
  const isPhone = useIsPhone();
  // Der Auslöser der Sticky-Kopfzahl: sie erscheint erst, wenn die Geld-Karte
  // nach oben aus dem Bild gescrollt ist.
  const [moneyRef, scrolledPastMoney] = useScrolledPast<HTMLDivElement>(isPhone);

  // Status + live snapshot: the site's overview row (device health + newest
  // sample) - the same source the fleet cards render from.
  useEffect(() => {
    let active = true;
    api.overview().then(
      (o) => {
        if (!active) return;
        setOverview(o);
        setOverviewFailed(false);
      },
      () => {
        if (active) setOverviewFailed(true);
      },
    );
    return () => {
      active = false;
    };
    // `sites` identity changes on explicit App reloads (device claimed, site
    // edited), keeping a fresh claim's status current without the 30 s poll.
  }, [site.id, sites, reloadKey]);

  // The measured money numbers - site-scoped (B2). Refetched when the period
  // (range/at) changes; the page keeps the previous numbers until the new ones
  // arrive (no flash). Fail-soft: an older backend / a 404 leaves the last
  // value.
  useEffect(() => {
    let active = true;
    api.siteEarnings(site.id, range, at).then(
      (e) => {
        if (active) setSiteEarnings(e);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey, range, at]);

  // Inverter-control confirmation for the calm "Steuerung" strip, loaded
  // silently (null while none has arrived yet or on any failure).
  useEffect(() => {
    let active = true;
    api.controlStatus(site.id).then(
      (c) => {
        if (active) setControlStatus(c);
      },
      () => {
        if (active) setControlStatus(null);
      },
    );
    api.curtailmentStatus(site.id).then(
      (c) => {
        if (active) setCurtailStatus(c);
      },
      () => {
        if (active) setCurtailStatus(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // The PV breakdown's measurement points, loaded silently (#524).
  useEffect(() => {
    let active = true;
    api.siteSources(site.id).then(
      (s) => {
        if (active) setSources(s);
      },
      () => {
        if (active) setSources(null);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // The cockpit consumer strip (§14.10): controllable consumers + their live
  // state. Fail-soft - an older backend / a site without consumers yields null,
  // and the strip renders nothing (cockpit byte-identical to before).
  useEffect(() => {
    let active = true;
    Promise.all([
      consumersApi.list(site.id).catch(() => []),
      consumersApi.status(site.id).catch(() => []),
    ]).then(([list, statuses]) => {
      if (!active) return;
      setConsumersView(
        consumerStrip(
          (list ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            ratedPowerKw: Number(c.ratedPowerKw),
            connection: c.connection,
          })),
          statuses ?? [],
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Wetter: the "Mehr" card teaser temp AND the live-zone "why" one-liner
  // (report N3), loaded silently.
  useEffect(() => {
    let active = true;
    api.weather(site.id).then(
      (w) => {
        if (!active) return;
        const idx = nextHourIndex(w.points, Date.now());
        setNextHourTempC(idx >= 0 ? (w.points[idx].temperatureC ?? null) : null);
        setWeatherWhyText(weatherWhy(w.points, new Date()));
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // The battery-dispatch plan: drives the promoted Fahrplan band, the
  // Fahrplan-aktiv health item and whether control is expected.
  useEffect(() => {
    let active = true;
    setPlanLoading(true);
    api.schedule(site.id).then(
      (p) => {
        if (!active) return;
        setPlan(p);
        setPlanFailed(false);
        setPlanLoading(false);
      },
      () => {
        if (!active) return;
        setPlanFailed(true);
        setPlanLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Freshness tick (5 s) + silent 30 s background poll.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const atRef = useRef(at);
  atRef.current = at;
  // Daten-Takt über `useFreshnessPoll` (holt beim Aufwachen SOFORT nach), Uhr
  // daneben - sonst zeigt das Cockpit dem zurückkehrenden Kunden bis zu 30 s
  // lang die Zahlen von vorhin.
  useFreshnessPoll(() => {
    setNow(new Date());
    api.overview().then(
      (o) => setOverview(o),
      () => {},
    );
    api.siteEarnings(site.id, rangeRef.current, atRef.current).then(
      (e) => setSiteEarnings(e),
      () => {},
    );
    api.controlStatus(site.id).then(
      (c) => setControlStatus(c),
      () => {},
    );
    api.curtailmentStatus(site.id).then(
      (c) => setCurtailStatus(c),
      () => {},
    );
    api.schedule(site.id).then(
      (p) => setPlan(p),
      () => {},
    );
  }, POLL_MS);
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const ovSite = overview?.sites.find((x) => x.id === site.id) ?? null;
  const sentence = ovSite ? composeSiteSentence(ovSite, now) : null;
  const fresh = ovSite ? siteLiveFresh(ovSite, now) : false;
  // AE1/AE7: the compact "Jetzt gerade" flow becomes the adaptive N-node
  // diagram once the site has a renderable topology; otherwise the cockpit
  // falls back to the plain `EnergyFlow` (`CockpitHero` decides internally).
  // `reloadKey` doubles as the retry key: bumping it (an "Erneut versuchen"
  // click) forces a fresh fetch of the SAME site.
  const adaptiveLive = useAdaptiveLive(site.id, reloadKey);

  // M3 (#531): the cockpit is the PROJECTION of the Anlage — a deterministic
  // module stack derived from the ACTIVE MODES (M0 `surface.ts`). `blocks`/
  // `modes` come straight from the read-model - `cockpitBlocks` already
  // returns `[]` for a site without entities, so there is no separate
  // "projected ? … : []" ternary any more.
  const {
    surface,
    entities: siteEntityPins,
    loading: surfaceLoading,
    failed: surfaceFailed,
  } = useAnlageSurface(site, reloadKey);
  const blocks = surface?.cockpitBlocks ?? [];
  const modes = surface?.modes ?? [];
  const lead = leadBlock(blocks);
  const isPeakLead = hasBlock(blocks, 'peak-band');

  // Der DREIWERTIGE Render-Entscheid (Captain-Nachtrag 06.08.2026, `cockpit.ts`
  // `anlageDecision`): SOLANGE die Entscheidungs-Eingaben laufen — `/entities`,
  // `/topology` UND die Übersichts-Zeile (die `setupPathActive` unten braucht,
  // um „noch nie Daten geliefert" von „noch nicht geladen" zu unterscheiden) —
  // wird KEIN Layout gewählt. Das ist der eigentliche Fix des „erst zeigt das
  // Portal die alte Ansicht"-Defekts: die frühere Weiche entschied, BEVOR ihre
  // Eingaben geladen waren.
  const overviewPending = overview == null && !overviewFailed;
  const decisionLoading = surfaceLoading || adaptiveLive.loading || overviewPending;
  const decisionFailed = surfaceFailed || adaptiveLive.failed || overviewFailed;
  const [decisionTimedOut, setDecisionTimedOut] = useState(false);
  useEffect(() => {
    if (!decisionLoading) {
      setDecisionTimedOut(false);
      return undefined;
    }
    const timer = setTimeout(() => setDecisionTimedOut(true), ANLAGE_DECISION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [decisionLoading, site.id, reloadKey]);
  const decision = anlageDecision({
    loading: decisionLoading,
    failed: decisionFailed,
    timedOut: decisionTimedOut,
    hasEntities: surface?.base.hasEntities,
    adaptive: adaptiveLive.adaptive,
  });
  const decided = decision === 'stack' || decision === 'unassigned';

  // M5 (#533): die Ausprägung "Neu / leer" — das Cockpit IST der
  // Einrichtungspfad. Die Weiche ist bewusst eng (siehe `setupPath.ts`): eine
  // bereits messende Anlage ohne v2-Entitäten bekommt NICHT den Einrichtungspfad
  // (siehe den „nicht zugeordnet"-Endzustand unten) — nur eine Anlage, die noch
  // nie Messdaten geliefert hat. `pinned` hält ihn stehen, während der Kunde
  // mitten in der Kette steht (nach einer Übernahme), damit die Seite nicht
  // unter ihm wegspringt. Ausgewertet erst, sobald wirklich ENTSCHIEDEN ist -
  // während `decision === 'pending'` bräuchte sie eine Übersichts-Zeile, die es
  // noch gar nicht gibt.
  const [setupPinned, setSetupPinned] = useState(false);
  const showSetup =
    decided &&
    (setupPinned ||
      setupPathActive({
        hasEntities: surface?.base.hasEntities,
        modeCount: surface?.modes.length ?? 0,
        statusLoaded: ovSite != null,
        lastSeenAt: ovSite?.lastSeenAt ?? null,
        hasLiveSample: ovSite?.live != null,
      }));
  // Der Modul-Stapel selbst rendert nur, wenn ENTSCHIEDEN, nicht der
  // Einrichtungspfad, UND `projectionActive` (in `decision` verrechnet) wirklich
  // zutrifft - sonst ist es der ehrliche „nicht zugeordnet"-Endzustand.
  const showStack = decided && !showSetup && decision === 'stack';

  // Recent telemetry for the Peak-Band's live ¼-h mean - fetched ONLY when the
  // cockpit leads with the Peak-Band, so non-peak faces never pay for it. A
  // 20-min window always covers the running quarter; polled on the 30 s cadence.
  useEffect(() => {
    if (!isPeakLead) {
      setPeakSamples([]);
      return;
    }
    let active = true;
    const load = () => {
      const from = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      api.telemetry(site.id, from).then(
        (pts) => active && setPeakSamples(pts),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [site.id, isPeakLead, reloadKey, wake]);

  // M3: the Eigenverbrauchs-Block's Autarkie / PV-Nutzung come from the EXISTING
  // Historie totals of today (server-computed) - fetched ONLY while the stack
  // truly renders, so neither the setup nor the "nicht zugeordnet" end state
  // pays for it. A failure leaves the numbers null and the block simply omits
  // those tiles (never a fake 0 %).
  // Beim Standard-Zeitraum „Heute" (ohne getippten Vormonat) fragt dieser
  // Abruf ZEICHENGLEICH dasselbe wie der Zeitraum-Abruf darunter - es war zwei
  // Mal dieselbe Anfrage samt zweitem 30-s-Takt. Dann wird er ausgelassen und
  // der Wert kommt aus `rangeHistory`; die Aussage ist identisch, weil es
  // dieselbe Antwort ist.
  const dayIsRange = range === 'day' && at == null;
  /** Die Tages-Summen: eigener Abruf - oder die des Zeitraums, wenn er GENAU
   *  derselbe ist. Nie ein anderer Wert, nur eine Anfrage weniger. */
  const dayTotalsEffective: HistoryTotals | null = dayIsRange ? rangeTotals : dayTotals;
  useEffect(() => {
    if (!showStack || dayIsRange) {
      setDayTotals(null);
      return undefined;
    }
    let active = true;
    const load = () => {
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
      api.history(site.id, 'day', today).then(
        (h) => active && setDayTotals(h.totals),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [site.id, showStack, dayIsRange, reloadKey, wake]);

  // v3.2 M1: the hero rings follow the SELECTED period tab. They read
  // range-scoped Historie totals (Tag/Monat/Jahr) so "Autarkie · Monat" is
  // genuinely the month's autarky, not today's. The `at` selects a past month
  // (MonthStrip) exactly like the earnings fetch. "Gesamt" (`all`) has no
  // all-time Historie endpoint -> no fetch -> the rings are honestly absent
  // (never a wrong-range value). Fail-soft; the energy flow is untouched.
  useEffect(() => {
    const hRange = historyRangeForCockpit(range);
    if (!showStack || hRange == null) {
      setRangeHistory(null);
      return undefined;
    }
    let active = true;
    const load = () => {
      const atForHistory =
        at ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
      api.history(site.id, hRange, atForHistory).then(
        (h) => active && setRangeHistory(h),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [site.id, showStack, range, at, reloadKey, wake]);

  // The Peak-Band view: live ¼-h mean (import-only, from the window above) vs.
  // the plan's Ziel + the PS-4 numbers. Null when not the peak lead.
  const peakView = isPeakLead
    ? peakBand({
        current: quarterHourMeanImportKw(peakSamples, now),
        targetKw: plan?.peakTargetKw ?? null,
        peak: siteEarnings?.peakShaving ?? null,
      })
    : null;

  // Fahrplan-derived flags: whether the plan is current for today (health) and
  // whether the site is controllable (a plan published to a battery device),
  // which keeps the Steuerung strip honest even before the first readback.
  const planSlots = plan?.slots ?? [];
  const hasPlanToday = todaySlots(planSlots, now).length > 0;
  const batteryLinked = plan?.deviceId != null;
  // WHY the current setpoint is what it is: the OPTIMIZER's own recorded reason
  // for the slot being executed (Fahrplan-Warum), never a second explanation
  // logic here. Null outside the horizon or on a plan from before the why-layer
  // - the strip then claims no cause (the idleReason discipline).
  const activePlanSlot = controlReasonSlot(planSlots, now, plan?.slotMinutes ?? 15);
  // Die Abregel-Beleg-Lage gilt NUR für die laufende Viertelstunde und nur,
  // wenn dort abgeregelt werden soll - `curtailTruthForSlot` ist der Filter,
  // sonst behauptete die Karte etwas über eine Stunde, die noch kommt.
  const controlCurtail = curtailTruthForSlot(
    curtailTruth(curtailStatus, now),
    activePlanSlot?.slotRole,
  );
  const planKind =
    site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch';
  // Teil 4b: warum geht der Solar-Überschuss GERADE ins Netz statt in die
  // Batterie? Overrides the plain slot reason when the slot exports; null
  // otherwise, so the strip falls back to the base reason (Null-Degradation).
  const surplusReason = activePlanSlot
    ? surplusWhy(activePlanSlot, planKind, nextChargeStart(planSlots, now))
    : null;
  const baseReason = activePlanSlot ? slotWhy(activePlanSlot, planKind, controlCurtail) : null;
  const controlReason = surplusReason ?? baseReason;
  // Teil 3: der nächste geplante Einsatz - im Ruhefall als eigene Ausblick-Zeile.
  const controlOutlook = planOutlook(planSlots, now);
  const controlView = controlStrip(
    controlStatus,
    now,
    batteryLinked,
    controlReason,
    controlCurtail,
    controlOutlook,
    surplusReason != null,
  );

  // Flussabgleich (Scout `vp-verkauf-praemisse-s8` §3): der Speicherknoten-Haken
  // hängt am `controlStrip`-healthy - aber eine register-bestätigte, nicht
  // fließende Order darf keinen Haken tragen. Dieselbe reine Ableitung wie der
  // Fahrplan-Held (eine Wahrheit, zwei Flächen), entprellt über den
  // Rücklese-Zeitpunkt des Geräts.
  const cockpitFlowInput = {
    commandedKw: controlStatus?.commandedKw,
    snapshot: siteSnapshot(ovSite?.live ?? null),
    snapshotFresh: fresh,
    executionMode: controlStatus?.executionMode,
    maxFeedInKw: site.maxFeedInKw,
  };
  const hasFlowConflictCandidate = flowConflictCandidate(cockpitFlowInput) != null;
  const [flowConflictStreak, setFlowConflictStreak] = useState(0);
  const flowCandRef = useRef(hasFlowConflictCandidate);
  flowCandRef.current = hasFlowConflictCandidate;
  const flowConflictObs = controlStatus?.checkedAt ?? null;
  useEffect(() => {
    if (flowConflictObs == null) return;
    setFlowConflictStreak((s) => stepFlowConflict(s, flowCandRef.current));
  }, [flowConflictObs]);
  const cockpitFlowConflict = flowConflict(cockpitFlowInput, flowConflictStreak) != null;

  // The Gesundheits-Checklist — rendered on BOTH cockpit paths (the projected
  // one lists it as its "Zustand" card, so a migrated plant has the surface the
  // header badge drills to; before this it existed only on the v1 branch).
  const health = healthChecklist({
    deviceCount: ovSite?.deviceCount ?? 0,
    onlineCount: ovSite?.onlineCount ?? 0,
    waitingCount: ovSite?.waitingCount ?? 0,
    hasPlanToday,
    hasAnyPlan: planSlots.length > 0,
    controlState: controlView?.state ?? null,
    batteryWithoutDevice: ovSite?.batteryWithoutDevice ?? false,
    batteryLinked,
  });

  // Report the facts only this page measures up to the shell badge, so header
  // and cockpit can never disagree about the same Anlage. The overview drives
  // whether the battery fact is KNOWN at all — without it the badge must not
  // conclude "kein Speicher" (an absent fact contributes nothing).
  const planKnown = !planLoading && !planFailed;
  const hasAnyPlan = planSlots.length > 0;
  const controlState = controlView?.state ?? null;
  const batteryKnown = ovSite != null;
  const batteryWithoutDevice = ovSite?.batteryWithoutDevice ?? false;
  useEffect(() => {
    if (!onHealthFacts) return;
    onHealthFacts(site.id, {
      plan: planKnown ? { hasPlanToday, hasAnyPlan } : null,
      controlState,
      battery: batteryKnown ? { withoutDevice: batteryWithoutDevice, linked: batteryLinked } : null,
    });
  }, [
    onHealthFacts,
    site.id,
    planKnown,
    hasPlanToday,
    hasAnyPlan,
    controlState,
    batteryKnown,
    batteryWithoutDevice,
    batteryLinked,
  ]);

  // The selected period instance (`at` = a tapped past month; null = current).
  const atDate = at ? new Date(`${at}T12:00:00`) : now;

  // v3 M2 · das Live-Cockpit: Hero (bestehendes Energiefluss-Diagramm groß +
  // Ringe + Geld + Fahrplan-Zeile) und das Widget-Raster. Beide Ableitungen
  // sind rein (`cockpitWidgets.ts`); hier wird nur gefüttert und gerendert.
  const heroView = cockpitHero({
    totals: rangeTotals,
    money: siteEarnings,
    range,
    at: atDate,
    now,
    slots: planSlots,
    slotMinutes: plan?.slotMinutes ?? 15,
    plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
  });
  // `cockpitWidgets` is safe to call unconditionally: `blocks`/`modes` are
  // already the correctly-empty read-model of a non-stack Anlage, so it
  // returns `[]` on its own - no separate gate needed here.
  const widgets = cockpitWidgets({
    blocks,
    modes,
    lead,
    dayTotals: dayTotalsEffective,
    money: siteEarnings,
    streams: surface?.moneyStreams ?? [],
    range,
    at: atDate,
    now,
    slots: planSlots,
    slotMinutes: plan?.slotMinutes ?? 15,
    plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
    peak: peakView,
    weather: { nextHourTempC, why: weatherWhyText },
  });
  // Mobil-Umbau Stufe 2 (`<= 720px`): dieselben Kacheln minus die, deren
  // Aussage auf demselben Telefon-Bildschirm schon steht. Die Regel ist rein
  // (`mobileWidgets`), hier wird nur gewählt.
  const shownWidgets = isPhone
    ? mobileWidgets(widgets, { hasRings: heroView.rings.length > 0 })
    : widgets;
  // ONE freshness truth (G3/R4): the three-state `liveState` drives BOTH the
  // head chip and the hero/board dimming. `site-only` (the Anlage delivers,
  // the per-device breakdown does not) gets its own honest chip wording and
  // never greys anything; only `stale` dims — values keep last-good, absent
  // stays "—", never a 0.
  const liveSt: LiveState = adaptiveLive.topology
    ? liveState({
        entityFresh: adaptiveLive.topology.entities.some((e) => e.health === 'ok'),
        siteFresh: fresh,
      })
    : fresh
      ? 'live'
      : 'stale';
  const heroStale = liveSt === 'stale';
  const chip = ovSite && !showSetup ? liveChip(liveSt, ovSite.live?.ts ?? null, now) : null;

  // Die Kopfsatz-Regel der Bühne (Konzept §6.2): der Prosa-Satz doppelte im
  // Normalfall die drei Zahlen, die 100 px tiefer an den Fluss-Knoten stehen.
  // Er wird nicht abgeschafft - er spricht nur noch, wenn er etwas ANDERES
  // sagt als das Diagramm (Warnung, kein zeichenbarer Fluss, Einrichtung).
  // `flowHasValues` ist dieselbe reine Funktion, die auch der Hero benutzt -
  // kein zweites Urteil über dieselbe Frage.
  const heroSnapshot = ovSite ? siteSnapshot(ovSite.live) : null;
  const showHeadSentence = headSentenceVisible({
    projected: showStack,
    tone: sentence?.tone ?? null,
    hasFlow: flowHasValues(adaptiveLive.topology, heroSnapshot),
  });

  const switchRange = (r: EarningsRange) => {
    setRange(r);
    setAt(null);
  };

  // „Eine Kachel ist ein Absprung" (V2): ein Tipp navigiert direkt zum Ziel der
  // Kachel — kein Modal. Seit dem Cockpit+Live-Merge sind alle Kacheln Geld-/
  // Modus-Kacheln und öffnen ihre Seite; die Verlauf-Sprünge (mit Zeitraum-
  // Übernahme) leben auf den Komponenten-Board-Zeilen.
  const jumpToWidget = (widget: WidgetDef) => onOpenSub(widget.target.sub);

  // --- Mobil-Umbau Stufe 2 --------------------------------------------------
  // Dieselben zwei Bausteine, nur in zwei Kleidern und zwei Reihenfolgen: am
  // Rechner Preis → Fahrplan als Karten, am Telefon Fahrplan → Preis als je
  // EINE Zeile mit Absprung. Sie werden hier EINMAL gebaut, damit die zwei
  // Fassungen nicht auseinanderlaufen können.
  const strompreisRow = gateStrompreis(modes, site.tarifArt) ? (
    <StrompreisStrip
      siteId={site.id}
      isDv={site.plantKind === 'direktvermarktung'}
      tarifArt={site.tarifArt}
      kind={site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch'}
      slots={planSlots}
      slotMinutes={plan?.slotMinutes ?? 15}
      activeSlot={activePlanSlot}
      onOpenMarktpreise={() => onNavigate(pageRoute('marktpreise'))}
      compact={isPhone}
    />
  ) : null;
  // ①b Speicher-Fahrplan (PR 4, Konzept §4b). Gated wie die Fahrplan-Ansicht
  // selbst; der volle Chart lebt nur auf der Fahrplan-Seite (D7). Am Telefon
  // trägt die Zeile zusätzlich den Wetter-Satz — die Wetter-Kachel entfällt
  // dafür, und ohne erklärenden Satz erscheint gar nichts.
  const fahrplanRow = (surface?.deepViews ?? []).includes('fahrplan') ? (
    <FahrplanBand
      plan={plan}
      plantKind={site.plantKind}
      now={now}
      loading={planLoading && plan == null}
      failed={planFailed}
      onOpen={() => onOpenSub('fahrplan')}
      compact={isPhone}
      weatherWhy={weatherWhyText}
    />
  ) : null;
  // Die geschrumpfte Kopfzahl beim Scrollen: die zwei Anker (Geld + Zustand).
  const sticky = isPhone
    ? stickyHead({ money: heroView.money, status: showSetup ? null : (sentence ?? null) })
    : null;

  return (
    <>
      {onBackToList && (
        <button type="button" className="vp-fleet-back" onClick={onBackToList}>
          <Icon name="chevron-left" size={18} />
          Alle Anlagen
        </button>
      )}

      {/* 1 · Kopf: Status + Warnungen bleiben oben sichtbar; Technik hinterm Zahnrad.
             Mobil-Umbau Stufe 2: am Telefon trägt die Topbar seit Stufe 1 die
             IDENTITÄT (Name als Wechsler + Zustands-Wort als Unterzeile), also
             ist dieser Block dort die zweite Kopie davon — er entfällt bis auf
             den Frische-Chip (die EINE Frischewahrheit, R4) und das Zahnrad.
             Die Überschrift bleibt als sr-only bestehen: 0 px hoch, aber die
             Seite verliert ihr Sprungziel nicht. */}
      <div className={`vp-page-head vp-anlage-head${isPhone ? ' is-phone' : ''}`}>
        {isPhone && <h1 className="vp-sr-only">{site.name}</h1>}
        <div className="titles">
          <h1>
            <span
              className={`vp-fleet-dot tone-${sentence?.tone ?? 'off'}`}
              aria-hidden="true"
            />
            {site.name}
          </h1>
          {showSetup ? (
            // M5: der Leer-Zustand spricht nicht von "offline", sondern vom Weg.
            <p className="vp-anlage-sentence tone-warn">{SETUP_STATUS_LINE}</p>
          ) : !showHeadSentence ? null : sentence ? (
            <p className={`vp-anlage-sentence tone-${sentence.tone}`}>{sentence.text}</p>
          ) : overviewFailed ? (
            <p className="vp-anlage-sentence tone-off">
              Der Status Ihrer Anlage konnte gerade nicht geladen werden.
            </p>
          ) : (
            <p className="vp-anlage-sentence tone-off">Status wird geladen …</p>
          )}
        </div>
        <div className="vp-anlage-badges">
          {/* R4: the ONE freshness chip of the merged home (head sentence +
              chip; the hero/board dim on `stale` from the same signal). */}
          {chip && (
            <Badge variant={chip.tone} dot>
              {chip.label}
            </Badge>
          )}
          {/* Stammdaten-Abzeichen: sie ändern sich nie und beantworten keine
              Tagesfrage — am Telefon wohnen sie in den Einstellungen. */}
          {!isPhone && <Badge variant="tint">{plantKindLabel(site.plantKind)}</Badge>}
          {!isPhone && <NetzladenBadge erlaubt={site.netzladenErlaubt} small />}
          <button
            type="button"
            className="vp-gear-btn"
            onClick={() => onOpenSub('technik')}
            aria-label="Einstellungen"
            title="Einstellungen"
          >
            <Icon name="settings" size={18} />
          </button>
        </div>
      </div>

      {ovSite?.batteryWithoutDevice && (
        <div className="vp-alert vp-alert-warn" style={{ marginBottom: 'var(--vp-space-4)' }}>
          {BATTERY_NO_DEVICE_WARNING}
        </div>
      )}

      {decision === 'pending' ? (
        /* ===== Zwischenzustand: die Entscheidungs-Eingaben laufen noch =====
           Der eigentliche Fix (Captain-Nachtrag 06.08.2026): solange
           `/entities`/`/topology`/die Übersichts-Zeile noch laufen, wird KEIN
           Layout gewählt - weder der Modul-Stapel noch der Einrichtungspfad
           noch der „nicht zugeordnet"-Endzustand. Layout-stabil, ruhig,
           begrenzt (siehe die knappe Frist oben in `decisionTimedOut`). */
        <AnlagePending />
      ) : decision === 'error' ? (
        /* ===== Ehrlicher Fehlerzustand statt Dauer-Spinner ================
           Ein entscheidungskritischer Abruf ist fehlgeschlagen ODER die
           knappe Frist ist überschritten - beides wird wie „fertig"
           behandelt: kein endloses Warten, sondern Wiederholen. */
        <ErrorState
          message="Diese Anlage konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : showSetup ? (
        /* ===== M5 · Der Leer-Zustand IST der Einrichtungspfad =============
           Ausprägung "Neu / leer" (report §3): keine Entitäten, keine Modi,
           noch nie Daten - also keine Platzhalter-Karten, sondern die drei
           Schritte zum fertigen EMS. */
        <AnlageSetup
          site={site}
          deviceCount={ovSite?.deviceCount ?? 0}
          onOpenSteuerung={() => onOpenSub('steuerung')}
          onOpenGeraete={() => onOpenSub('modell')}
          onReload={onReload}
          onStay={setSetupPinned}
        />
      ) : showStack ? (
        /* ===== v3 M2 · Das Live-Cockpit ==================================
           Der Hero trägt das BESTEHENDE Energiefluss-Diagramm groß und
           zentral (kein neues "Energie-Rad", BUILD.md §2) mit Autarkie/
           Eigenverbrauch als Ringen, dem Geld des Zeitraums und der einen
           Fahrplan-Zeile. Darunter das Widget-Raster: eine kompakte Kachel
           je Block/Modus, die WIRKLICH etwas beisteuert - ein Tipp öffnet
           ihr Modal (Jetzt | Verlauf). Was kein Modus und keine Quelle
           beisteuert, erscheint nicht - auch nicht als leere Karte. */
        <>
          {sticky && <MobileStickyHead head={sticky} shown={scrolledPastMoney} />}

          {ovSite == null ? (
            <Skeleton height={320} radius="var(--vp-radius-lg)" />
          ) : (
            <CockpitHero
              view={heroView}
              topology={adaptiveLive.topology}
              snapshot={siteSnapshot(ovSite.live)}
              stale={heroStale}
              sources={sources}
              pins={siteEntityPins}
              consumers={consumersView}
              onOpenConsumers={() => onOpenSub('steuerung')}
              onOpenSub={onOpenSub}
              /* Der Zeitraum steht in der Bilanz-Leiste, direkt über den
                 Zahlen, die er regiert (Konzept §6.3) - nicht mehr als volle
                 Seitenzeile für vier Knöpfe. Ohne Geld-Modus gibt es keinen
                 Zeitraum zu wählen.
                 Am Telefon (Stufe 2) trägt die EINE Geld-Karte darunter das
                 Segment - dort gibt es keine Leiste. */
              periodSeg={
                !isPhone && hasBlock(blocks, 'erloes-komposition') ? (
                  <PeriodTabs range={range} onRange={switchRange} variant="seg" />
                ) : null
              }
              showRail={!isPhone}
              /* Der Stift in der PV-Zusammensetzung — die Abkürzung zum
                 Umbenennen dort, wo der Wunsch entsteht. Nach dem Speichern
                 dieselbe Auffrischung wie jeder „Erneut versuchen"-Klick, damit
                 der neue Name sofort überall steht. */
              rename={{ siteId: site.id, onRenamed: () => setReloadKey((k) => k + 1) }}
              /* Die Bestätigung ist AM Diagramm ablesbar (Speicher-Knoten),
                 der Bühnenfuß liefert Satz und Grund. Ein Flusskonflikt
                 (register-bestätigt, aber nicht fließend) entzieht den Haken -
                 er wäre sonst genau die „lädt 3,3 kW ✓"-Lüge aus Pilsting. */
              controlConfirmed={controlView?.state === 'healthy' && !cockpitFlowConflict}
              /* Am Telefon steht die Geld-Karte „direkt unterm Fluss"
                 (Konzept) — der Bühnenfuß wandert deshalb unter die
                 Fahrplan-Zeile, deren Aussage er fortsetzt (was ist geplant →
                 was bestätigt der Wechselrichter). Er entfällt NICHT: er ist
                 die einzige Fläche, die einen abweichenden Sollwert meldet. */
              footer={
                !isPhone && controlView ? (
                  <ControlStrip view={controlView} variant="bare" />
                ) : null
              }
            />
          )}

          {/* Mobil-Umbau Stufe 2: die EINE Geld-Karte direkt unter dem Fluss —
              Zahl, Zurechnung, Zeitraum-Segment und die Ringe als Chips. Sie
              ersetzt am Telefon die Bilanz-Leiste UND die zwei Geld-Kacheln
              (dieselbe Aussage stand dort bis zu viermal auf 550 px). */}
          {isPhone && (
            <div ref={moneyRef}>
              <MobileMoneyCard
                view={heroView}
                periodSeg={
                  hasBlock(blocks, 'erloes-komposition') ? (
                    <PeriodTabs range={range} onRange={switchRange} variant="seg" />
                  ) : null
                }
              />
            </div>
          )}

          {/* Am Telefon führen die zwei täglichen Fragen als ZEILEN (Fahrplan
              zuerst, dann der Preis, der ihn erklärt); die Kacheln folgen
              darunter. Am Rechner bleibt die Reihenfolge der Bühne. */}
          {isPhone && fahrplanRow}
          {isPhone && controlView && (
            <ControlStrip view={controlView} variant="card" />
          )}
          {isPhone && strompreisRow}

          {/* Eine Kachel ist ein Absprung (V2): der Tipp navigiert direkt zum
              Ziel der Kachel - kein Modal mehr. */}
          <WidgetGrid widgets={shownWidgets} onSelect={jumpToWidget} />

          {/* Markt & Tag (vp-cockpit-unten-ux-n3, PR 1): der Börsenpreis-
              Streifen führt die untere Hälfte an — er erklärt, warum der
              Fahrplan gerade tut, was er tut. Am Telefon stehen beide weiter
              oben (siehe dort) und je als EINE Zeile. */}
          {!isPhone && strompreisRow}
          {!isPhone && fahrplanRow}

          {/* Merge Option A · Stratum 3: Komponenten im Detail — das Board
              (sichtbar) + der kompakte Verlauf hinter „Verlauf ▾" (Q2). Die
              Abrufe starten erst nahe dem Viewport (lazy-mount). */}
          <KomponentenSection
            site={site}
            topology={adaptiveLive.topology}
            adaptive={adaptiveLive.adaptive}
            stale={heroStale}
            range={range}
            at={at}
            dayTotals={dayTotalsEffective}
          />

          {/* Zustand (vp-cockpit-unten-ux-n3 PR 3): leise, wenn gesund — EINE
              Zeile; laut nur mit Befund (Ursache + Hebel je Zeile). Der
              Modus-Fuß wohnt IN der Fläche (D6) — der Stack endet mit einer
              Karte statt mit einem baumelnden Absatz. Gated auf die geladene
              Übersicht: vor der ersten Antwort gäbe es nur erfundene
              „noch nicht verbunden"-Befunde. id="zustand" bleibt das
              Sprungziel des Schalen-Abzeichens. */}
          {ovSite != null && health.length > 0 && (
            <div className="vp-cockpit-health" id="zustand">
              <ZustandCard
                items={health}
                onOpenSub={onOpenSub}
                onOpenModus={() => onOpenSub('steuerung')}
              />
            </div>
          )}
        </>
      ) : (
        /* ===== Ehrlicher Endzustand: Anlage MIT Daten, ohne Komponenten ====
           Captain-Nachtrag 06.08.2026 §3: der automatische v2-Backfill
           überspringt eine Anlage ohne EINDEUTIGES Gateway-Gerät (kein Gerät
           oder mehrere) - sie bleibt un-migriert, obwohl sie längst misst
           (eine Anlage ohne Gerät landet stattdessen im M5-Einrichtungspfad
           oben). Kein Ersatz-Layout mehr, das gleich wieder verschwindet -
           die NEUE Schale, plus eine ruhige, benennende Zeile und der
           konkrete Hebel (Anlagen-Modell / Zuordnung). */
        <AnlageUnassigned onOpenModell={() => onOpenSub('modell')} />
      )}

      {/* Single-Anlage customers have no Übersicht/Anlagen-Liste; their way to
          a SECOND Anlage is the always-visible "＋ Anlage hinzufügen" action in
          the shell header (App.tsx / AppShell, gated by showAddAnlageButton).
          From the second Anlage on, the list and fleet Übersicht carry it. */}
    </>
  );
}

/**
 * Der ruhige Zwischenzustand, solange die Entscheidungs-Eingaben laufen
 * (Captain-Nachtrag 06.08.2026): weder v1 noch der Modul-Stapel - ein
 * layout-stabiler Platzhalter, der weder wie das eine noch wie das andere
 * aussieht, damit nie eine Fassung zu sehen ist, die gleich wieder
 * verschwindet. Die Kopf-Informationen (Name, Status-Satz, Badges) bleiben
 * unverändert sichtbar - sie sind bereits Teil des immer gerenderten Kopfs.
 */
function AnlagePending() {
  return (
    <div className="vp-anlage-pending" role="status" aria-live="polite" aria-busy="true">
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      <Skeleton height={420} radius="var(--vp-radius-lg)" />
      <div className="vp-anlage-pending-grid">
        <Skeleton height={96} radius="var(--vp-radius-md)" />
        <Skeleton height={96} radius="var(--vp-radius-md)" />
        <Skeleton height={96} radius="var(--vp-radius-md)" />
      </div>
    </div>
  );
}

/**
 * Der ehrliche Endzustand einer Anlage, die MISST, aber (noch) keiner
 * v2-Komponente zugeordnet ist (Captain-Nachtrag 06.08.2026 §"Was entfällt"
 * Punkt 3). Der einzige heute bekannte Weg dorthin: der automatische Backfill
 * überspringt eine Anlage ohne EINDEUTIGES Gateway-Gerät (kein Gerät oder
 * mehrere) - eine Mehr-Geräte-Anlage bleibt dann un-migriert, obwohl sie
 * längst Daten liefert. Der frühere v1-Zonen-Dashboard-Rückfall ist mit
 * dieser Umstellung ENTFALLEN (kein Ersatz-Layout) - an seine Stelle tritt
 * diese ruhige, benennende Zeile mit dem konkreten Hebel, nie ein leeres
 * weißes Feld und nie ein Dauer-Spinner.
 */
function AnlageUnassigned({ onOpenModell }: { onOpenModell: () => void }) {
  return (
    <Card padding="lg" radius="lg" accent="primary" className="vp-resume-banner vp-anlage-unassigned">
      <div style={{ display: 'flex', gap: 'var(--vp-space-4)', flex: '1 1 360px', minWidth: 0 }}>
        <IconTile category="primary" size={48}>
          <Icon name="layers" size={22} />
        </IconTile>
        <div style={{ minWidth: 0 }}>
          <h4 style={{ marginBottom: 4 }}>Diese Anlage ist noch nicht zugeordnet</h4>
          <p className="vp-muted" style={{ margin: 0 }}>
            Ihre Anlage sendet bereits Messwerte, aber die Komponenten (PV, Speicher, Netz)
            fehlen - vermutlich, weil mehrere Geräte gemeldet werden. Ordnen Sie sie im
            Anlagen-Modell zu.
          </p>
        </div>
      </div>
      <Button variant="primary" onClick={onOpenModell}>
        Zuordnung öffnen
      </Button>
    </Card>
  );
}
