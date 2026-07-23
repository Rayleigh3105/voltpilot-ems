import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile, type IconCategory } from '../../designsystem/components/core/IconTile';
import {
  api,
  type ControlStatus,
  type Device,
  type Earnings,
  type EarningsRange,
  type HistoryTotals,
  type Overview,
  type SchedulePlan,
  type Site,
  type TelemetryPoint,
} from '../api';
import {
  BATTERY_NO_DEVICE_WARNING,
  composeSiteSentence,
  notComputableHint,
  siteLiveFresh,
  siteSnapshot,
} from '../fleet';
import { eurAmount, fmtNum, fmtRelative, plantKindLabel } from '../format';
import { periodLabel, stripSlots } from '../anlage';
import { anlageRoute, type AnlagenSub, type Route } from '../nav';
import { nextHourIndex, weatherWhy } from '../weather';
import { controlStrip } from '../control';
import { todaySlots } from '../schedule';
import { planTrafZu, type PlanTrafZu } from '../planAccuracy';
import { healthChecklist } from '../health';
import { AnlageAnlegenDrawer } from '../components/AnlageAnlegenDrawer';
import { resolveAnlage } from '../anlageNav';
import { ControlStrip } from '../components/ControlStrip';
import { EnergyFlow } from '../components/EnergyFlow';
import { AdaptiveEnergyFlow } from '../components/AdaptiveEnergyFlow';
import { useAdaptiveLive } from '../useAdaptiveLive';
import { liveState } from '../adaptiveLive';
import { moneyLayout } from '../moneyEmphasis';
import { leadArtifact, leadBlock } from '../leadSlot';
import { useAnlageSurface } from '../useAnlageSurface';
import { hasBlock, projectionActive } from '../cockpit';
import { cockpitHero, cockpitWidgets, type WidgetDef } from '../cockpitWidgets';
import { ToolboxPointer } from '../components/CockpitBlocks';
import { CockpitHero } from '../components/CockpitHero';
import { WidgetGrid } from '../components/WidgetGrid';
import { WidgetModal } from '../components/WidgetModal';
import { ErloesKomposition } from '../components/ErloesKomposition';
import { AnlageSetup } from '../components/AnlageSetup';
import { SETUP_STATUS_LINE, setupPathActive } from '../setupPath';
import { peakBand, quarterHourMeanImportKw } from '../peakBand';
import { PeakBand } from '../components/PeakBand';
import { FahrplanBand } from '../components/FahrplanBand';
import { FleetSiteCard } from '../components/FleetOverview';
import { ErtragChart } from '../components/ErtragChart';
import { HealthChecklist } from '../components/HealthChecklist';
import { AnlageHero, EnergyStatsRow, MonthRail, MonthStrip, PeriodTabs } from '../components/MoneyView';
import { NetzladenBadge } from '../components/NetzladenBadge';
import { ErrorState, Skeleton } from '../components/States';
import { FahrplanSection, WetterSection } from './DataPages';
import { HistorieSection } from './HistorieSection';
import { LiveSection } from './LiveSection';
import { AnlagenModellSection } from './AnlagenModellSection';
import { LastspitzenSection } from './LastspitzenSection';
import { SteuerungSection } from './SteuerungSection';
import { TechnikSection } from './AnlageTechnik';

/** Background refresh cadence of the live widgets (30 s poll pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness note. */
const TICK_MS = 5_000;

export interface AnlagenPageProps {
  sites: Site[];
  devices: Device[];
  route: Route;
  onNavigate: (route: Route) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
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
      sub={route.sub}
      isAdmin={isAdmin}
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

  // Freshness tick + silent background poll (the fleet-mode pattern).
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(new Date());
      if (++ticks % Math.round(POLL_MS / TICK_MS) === 0) {
        api.overview().then(
          (o) => setOverview(o),
          () => {},
        );
      }
    }, TICK_MS);
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

const SUB_PAGES: Record<AnlagenSub, { title: string; subtitle: string }> = {
  live: {
    title: 'Live-Daten',
    subtitle: 'Was Ihre Anlage gerade macht: Status, Energiefluss und Messwert-Verlauf.',
  },
  fahrplan: {
    title: 'Fahrplan',
    subtitle: 'Kostenoptimaler Batterie-Fahrplan aus Börsenpreisen und Prognosen.',
  },
  historie: {
    title: 'Historie & Erlöse',
    subtitle: 'Was Ihre Anlage getan hat - und was es gekostet oder gespart hat.',
  },
  wetter: {
    title: 'Wetter',
    subtitle: 'Die Vorhersage am Standort Ihrer Anlage - Grundlage der PV-Prognose.',
  },
  technik: {
    title: 'Technik & Einstellungen',
    subtitle: 'Wechselrichter, Speicher, Anlagentyp, Stromtarif und der Standort Ihrer Anlage.',
  },
  modell: {
    title: 'Anlagen-Modell',
    subtitle: 'So ist Ihre Anlage verschaltet: Geräte, Komponenten und was das Cockpit daraus macht.',
  },
  steuerung: {
    title: 'Steuerung',
    subtitle:
      'Ihre Steuerungs-Flows: Regeln bauen, prüfen, simulieren und aktivieren - was geschaltet wird und zu welchen Bedingungen.',
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
  sub,
  isAdmin,
  onBack,
  onOpenSub,
  onReload,
}: {
  site: Site;
  sites: Site[];
  devices: Device[];
  sub: AnlagenSub;
  isAdmin: boolean;
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
      <div className="vp-page-head">
        <div className="titles">
          <h1>{meta.title}</h1>
          <p>{meta.subtitle}</p>
        </div>
      </div>
      {sub === 'live' && <LiveSection site={site} />}
      {sub === 'fahrplan' && <FahrplanSection site={site} />}
      {sub === 'historie' && <HistorieSection site={site} />}
      {sub === 'wetter' && <WetterSection site={site} />}
      {sub === 'modell' && <AnlagenModellSection site={site} />}
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
  onReload,
}: AnlagenPageProps & {
  site: Site;
  onOpenSub: (sub: AnlagenSub) => void;
  onBackToList: (() => void) | null;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnFailed, setEarnFailed] = useState(false);
  // The period tabs govern the whole page (captain 2026-07-07). `at` is the
  // selected instance (a month tapped in the strip); null = the current period.
  const [range, setRange] = useState<EarningsRange>('month');
  const [at, setAt] = useState<string | null>(null);
  const [nextHourTempC, setNextHourTempC] = useState<number | null>(null);
  const [weatherWhyText, setWeatherWhyText] = useState<string | null>(null);
  const [controlStatus, setControlStatus] = useState<ControlStatus | null>(null);
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(true);
  const [planFailed, setPlanFailed] = useState(false);
  const [planTraf, setPlanTraf] = useState<PlanTrafZu | null>(null);
  // U4: recent telemetry for the peak face's live ¼-h mean (fetched only when
  // the cockpit leads with the Peak-Band - see the gated effect below).
  const [peakSamples, setPeakSamples] = useState<TelemetryPoint[]>([]);
  // M3: today's Historie totals feed the Eigenverbrauchs-Block (Autarkie /
  // PV-Nutzung); since v3 M2 they ALSO feed the cockpit hero's rings and the
  // Haus/Netz widgets, so the projection path fetches them once for all of it.
  const [dayTotals, setDayTotals] = useState<HistoryTotals | null>(null);
  // v3 M2: the Speicher widget's read-only "Umgang mit dem Speicher" row.
  const [speicherschonung, setSpeicherschonung] = useState<string | null>(null);
  // v3 M2: which widget's modal is open (null = none).
  const [openWidget, setOpenWidget] = useState<WidgetDef | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());

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

  // The measured money numbers - tenant-wide response, rendered site-scoped.
  // Refetched when the period (range/at) changes; the page keeps the previous
  // numbers until the new ones arrive (no flash).
  useEffect(() => {
    let active = true;
    api.earnings(range, at).then(
      (e) => {
        if (!active) return;
        setEarnings(e);
        setEarnFailed(false);
      },
      () => {
        if (active) setEarnFailed(true);
      },
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

  // Plan-vs-actual accuracy for the "Fahrplan traf zu X %" one-liner (report
  // N5): the latest point of the forecast-quality plan_accuracy series,
  // graduated from Prognosequalität. Silent - null when nothing trustworthy.
  useEffect(() => {
    let active = true;
    api.forecastQuality(site.id).then(
      (fq) => {
        if (active) setPlanTraf(planTrafZu(fq.planAccuracy, new Date()));
      },
      () => {
        if (active) setPlanTraf(null);
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
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(new Date());
      if (++ticks % Math.round(POLL_MS / TICK_MS) === 0) {
        api.overview().then(
          (o) => setOverview(o),
          () => {},
        );
        api.earnings(rangeRef.current, atRef.current).then(
          (e) => setEarnings(e),
          () => {},
        );
        api.controlStatus(site.id).then(
          (c) => setControlStatus(c),
          () => {},
        );
        api.schedule(site.id).then(
          (p) => setPlan(p),
          () => {},
        );
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const ovSite = overview?.sites.find((x) => x.id === site.id) ?? null;
  const siteEarnings = earnings?.sites.find((x) => x.id === site.id) ?? null;
  const sentence = ovSite ? composeSiteSentence(ovSite, now) : null;
  const fresh = ovSite ? siteLiveFresh(ovSite, now) : false;
  // AE1/AE7: the compact "Jetzt gerade" flow becomes the adaptive N-node
  // diagram for migrated sites; un-migrated sites keep the v1 EnergyFlow.
  const adaptiveLive = useAdaptiveLive(site.id);
  // AE4: the money view is a profile-conditional lens. Only a MIGRATED site with
  // a usage profile carries an emphasis; anything else resolves to `prominent`,
  // so an un-migrated (or profile-less) site renders byte-identical to today.
  const emphasis = adaptiveLive.adaptive ? adaptiveLive.profile?.emphasis : null;
  const money = moneyLayout(emphasis?.money);

  // M3 (#531): the cockpit is the PROJECTION of the Anlage — a deterministic
  // module stack derived from the ACTIVE MODES (M0 `surface.ts`), not a fixed
  // zone raster. The v1 gate is non-negotiable (report §6.2): without entities
  // (and with the existing `useAdaptiveLive`/`hasTopology` gate closed) the
  // Anlage renders EXACTLY today's default cockpit, byte-identical.
  const { surface } = useAnlageSurface(site);
  const projection = projectionActive({
    hasEntities: surface?.base.hasEntities,
    adaptive: adaptiveLive.adaptive,
  });
  const blocks = projection ? surface?.cockpitBlocks ?? [] : [];
  const modes = projection ? surface?.modes ?? [] : [];
  // The N-ary lead rule (peak → money → flow) replaces the binary U4 switch on
  // the projected path; the v1 path keeps the AE7 emphasis lens.
  const lead = projection ? leadBlock(blocks) : null;
  const isPeakLead = projection
    ? hasBlock(blocks, 'peak-band')
    : leadArtifact(emphasis?.peak) === 'peakband';
  // v3 M2: the day totals now feed the hero rings on EVERY projected cockpit,
  // not just the Eigenverbrauchs-Block - so the gate is the projection itself.
  const needsDayTotals = projection;

  // M5 (#533): die Ausprägung "Neu / leer" — das Cockpit IST der
  // Einrichtungspfad. Die Weiche ist bewusst eng (siehe `setupPath.ts`): eine
  // LAUFENDE v1-Anlage ohne v2-Entitäten behält ihr Cockpit; nur eine Anlage,
  // die noch nie Messdaten geliefert hat, bekommt den geführten Pfad. `pinned`
  // hält ihn stehen, während der Kunde mitten in der Kette steht (nach einer
  // Übernahme), damit die Seite nicht unter ihm wegspringt.
  const [setupPinned, setSetupPinned] = useState(false);
  const showSetup =
    setupPinned ||
    setupPathActive({
      hasEntities: surface?.base.hasEntities,
      modeCount: surface?.modes.length ?? 0,
      statusLoaded: ovSite != null,
      lastSeenAt: ovSite?.lastSeenAt ?? null,
      hasLiveSample: ovSite?.live != null,
    });

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
  }, [site.id, isPeakLead, reloadKey]);

  // M3: the Eigenverbrauchs-Block's Autarkie / PV-Nutzung come from the EXISTING
  // Historie totals of today (server-computed) - fetched ONLY when that block is
  // part of the projection, so no other Ausprägung pays for it. A failure leaves
  // the numbers null and the block simply omits those tiles (never a fake 0 %).
  useEffect(() => {
    if (!needsDayTotals) {
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
  }, [site.id, needsDayTotals, reloadKey]);

  // v3 M2: the battery's effective Speicherschonung preset, read-only in the
  // Speicher widget. Fail-soft - without it the row simply does not appear.
  useEffect(() => {
    if (!projection) {
      setSpeicherschonung(null);
      return;
    }
    let active = true;
    api.siteAssets(site.id).then(
      (assets) => {
        if (!active) return;
        setSpeicherschonung(
          assets.find((a) => a.speicherschonung != null)?.speicherschonung ?? null,
        );
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, projection, reloadKey]);

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
  const controlView = controlStrip(controlStatus, now, batteryLinked);

  // The Gesundheits-Checklist (desktop Zone C).
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

  // The period label + strip selection follow the SELECTED instance.
  const atDate = at ? new Date(`${at}T12:00:00`) : now;
  const period = periodLabel(range, atDate, now);
  const currentMonthIso = `${now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7)}-01`;
  const selectedMonth = at ?? currentMonthIso;
  const series = siteEarnings?.series ?? [];

  // v3 M2 · das Live-Cockpit: Hero (bestehendes Energiefluss-Diagramm groß +
  // Ringe + Geld + Fahrplan-Zeile) und das Widget-Raster. Beide Ableitungen
  // sind rein (`cockpitWidgets.ts`); hier wird nur gefüttert und gerendert.
  const heroView = cockpitHero({
    dayTotals,
    money: siteEarnings,
    range,
    at: atDate,
    now,
    slots: planSlots,
    slotMinutes: plan?.slotMinutes ?? 15,
    plantKind: site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
  });
  const widgets = projection
    ? cockpitWidgets({
        blocks,
        modes,
        lead,
        channels: surface?.base.telemetryChannels ?? [],
        snapshot: ovSite ? siteSnapshot(ovSite.live) : null,
        dayTotals,
        money: siteEarnings,
        streams: surface?.moneyStreams ?? [],
        range,
        at: atDate,
        now,
        slots: planSlots,
        slotMinutes: plan?.slotMinutes ?? 15,
        plantKind:
          site.plantKind === 'direktvermarktung' ? 'direktvermarktung' : 'eigenverbrauch',
        peak: peakView,
        speicherschonung,
        weather: { nextHourTempC, why: weatherWhyText },
      })
    : [];
  // ONE freshness truth (G3): the hero greys out only when NEITHER the entities
  // nor the Anlage's own telemetry are current - the head sentence reads the
  // very same signal. It never fabricates a 0; the last good values stay.
  const heroStale = adaptiveLive.topology
    ? liveState({
        entityFresh: adaptiveLive.topology.entities.some((e) => e.health === 'ok'),
        siteFresh: fresh,
      }) === 'stale'
    : !fresh;

  const switchRange = (r: EarningsRange) => {
    setRange(r);
    setAt(null);
  };
  const selectMonth = (monthIso: string) => {
    setRange('month');
    setAt(monthIso);
  };

  return (
    <>
      {onBackToList && (
        <button type="button" className="vp-fleet-back" onClick={onBackToList}>
          <Icon name="chevron-left" size={18} />
          Alle Anlagen
        </button>
      )}

      {/* 1 · Kopf: Status + Warnungen bleiben oben sichtbar; Technik hinterm Zahnrad. */}
      <div className="vp-page-head vp-anlage-head">
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
          ) : sentence ? (
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
          <Badge variant="tint">{plantKindLabel(site.plantKind)}</Badge>
          <NetzladenBadge erlaubt={site.netzladenErlaubt} small />
          <button
            type="button"
            className="vp-gear-btn"
            onClick={() => onOpenSub('technik')}
            aria-label="Technik & Einstellungen"
            title="Technik & Einstellungen"
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

      {showSetup ? (
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
      ) : projection ? (
        /* ===== v3 M2 · Das Live-Cockpit ==================================
           Der Hero trägt das BESTEHENDE Energiefluss-Diagramm groß und
           zentral (kein neues "Energie-Rad", BUILD.md §2) mit Autarkie/
           Eigenverbrauch als Ringen, dem Geld des Zeitraums und der einen
           Fahrplan-Zeile. Darunter das Widget-Raster: eine kompakte Kachel
           je Block/Modus, die WIRKLICH etwas beisteuert - ein Tipp öffnet
           ihr Modal (Jetzt | Verlauf). Was kein Modus und keine Quelle
           beisteuert, erscheint nicht - auch nicht als leere Karte. */
        <>
          {/* Die Zeitraum-Tabs regieren die Geld-Zahlen; ohne Geld-Modus
              gibt es keinen Zeitraum zu wählen. */}
          {hasBlock(blocks, 'erloes-komposition') && (
            <PeriodTabs range={range} onRange={switchRange} />
          )}

          {ovSite == null ? (
            <Skeleton height={320} radius="var(--vp-radius-lg)" />
          ) : (
            <CockpitHero
              view={heroView}
              topology={adaptiveLive.topology}
              snapshot={siteSnapshot(ovSite.live)}
              stale={heroStale}
              freshnessNote={ovSite.live ? `Stand ${fmtRelative(ovSite.live.ts, now)}` : null}
              whyLine={fresh ? weatherWhyText : null}
              onOpenSub={onOpenSub}
              footer={controlView ? <ControlStrip view={controlView} /> : null}
            />
          )}

          <WidgetGrid widgets={widgets} onOpen={setOpenWidget} />

          {/* Die ruhige Toolbox-Zeile - der Abschluss (§1.3). Kein Werben
              für einen bestimmten Modus. Das Wetter ist jetzt eine Kachel. */}
          <div className="vp-stack-foot">
            <ToolboxPointer onOpen={() => onOpenSub('steuerung')} />
          </div>

          {openWidget && (
            <WidgetModal
              widget={openWidget}
              onClose={() => setOpenWidget(null)}
              onOpenSub={onOpenSub}
              jetztExtra={
                /* Die migrierten Block-Körper leben als Modal-Körper weiter -
                   dieselbe Ableitung, nur ein anderer Ort. */
                openWidget.id === 'lastspitze' && peakView ? (
                  <PeakBand view={peakView} peak={siteEarnings?.peakShaving ?? null} />
                ) : openWidget.id === 'erloes' ? (
                  <ErloesKomposition
                    streams={surface?.moneyStreams ?? []}
                    money={siteEarnings}
                    range={range}
                    at={atDate}
                    now={now}
                    onOpenErloesHistorie={() => {
                      setOpenWidget(null);
                      onOpenSub('historie');
                    }}
                  />
                ) : openWidget.id === 'handel' ? (
                  <FahrplanBand
                    plan={plan}
                    plantKind={site.plantKind}
                    now={now}
                    loading={planLoading && plan == null}
                    failed={planFailed}
                    onOpen={() => {
                      setOpenWidget(null);
                      onOpenSub('fahrplan');
                    }}
                  />
                ) : null
              }
            />
          )}
        </>
      ) : (
        /* ===== v1 (un-migrated): byte-identical to today ================== */
        <>
      {/* U4 · Peak-Band lead artifact: on the peak face the cockpit leads with
          the Spitzen-Verteidigung (¼-h-Mittel vs. Ziel + PS-4-Zahlen); Geld
          läuft darunter als Nachweis (AE4 secondary). Non-peak faces skip it. */}
      {peakView && (
        <div className="vp-lead-peakband" style={{ marginBottom: 'var(--vp-space-4)' }}>
          <PeakBand view={peakView} peak={siteEarnings?.peakShaving ?? null} />
        </div>
      )}

      {/* 2 · Zeitraum-Tabs regieren die Geld-Ansicht - nur wenn Geld geführt
          wird (AE4: für das Privat-Profil ist Geld aus dem Hero genommen). */}
      {money.showFullMoney && <PeriodTabs range={range} onRange={switchRange} />}

      {/* 3 · Monats-Leiste (Phone/Tablet): letzte 12 Monate zum Durchtippen.
          Auf Desktop ersetzt der vertikale Rail in Zone C diese Leiste. */}
      {money.showFullMoney && range === 'month' && (
        <div className="vp-mstrip-mobile">
          <MonthStrip
            slots={stripSlots(siteEarnings?.monthlyStrip ?? [], now)}
            selectedMonth={selectedMonth}
            onSelect={selectMonth}
          />
        </div>
      )}

      {/* Das 3-Zonen-Dashboard (Desktop): Geld | Live | Rail über einem
          Fahrplan-Band in voller Breite. Auf Phone/Tablet lösen sich die Zonen
          auf und die Blöcke ordnen sich geldzuerst (per CSS order). */}
      <div
        className={`vp-anlage-dash${money.nachweis ? ' vp-money-nachweis' : ''}${
          money.hiddenFromHero ? ' vp-money-min' : ''
        }`}
      >
        {/* ---- Zone A · Geld (ruhig; AE4 profil-bedingt) ----------------- */}
        <div className="vp-zone vp-zone-money">
          {money.hiddenFromHero ? (
            // Privat-Profil: Geld ist aus dem Hero genommen, aber über ein ruhiges
            // Detail erreichbar - der Fokus liegt auf Live-Flüssen + Steuerung.
            <div className="vp-dash-hero">
              <MoneyGlanceCard onOpen={() => onOpenSub('historie')} />
            </div>
          ) : (
            <>
              <div className="vp-dash-hero">
                {money.nachweis && (
                  <span className="vp-money-nachweis-tag">Nachweis · {period}</span>
                )}
                {earnings == null && !earnFailed ? (
                  <Skeleton height={300} radius="var(--vp-radius-lg)" />
                ) : (
                  <AnlageHero
                    money={siteEarnings}
                    period={period}
                    unavailable={earnFailed}
                    emptyHint={
                      siteEarnings?.reason ? notComputableHint(siteEarnings.reason) : undefined
                    }
                  />
                )}
              </div>

              <div className="vp-dash-ertrag">
                <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
                  <span className="vp-card-label">Ertrag · {period}</span>
                  {earnings == null && !earnFailed ? (
                    <Skeleton height={220} radius="var(--vp-radius-md)" />
                  ) : series.length > 0 ? (
                    <ErtragChart series={series} range={range} />
                  ) : (
                    <p className="vp-note" style={{ margin: 'var(--vp-space-2) 0 0' }}>
                      Für diesen Zeitraum liegen noch keine Erträge vor. Sobald Ihre Anlage
                      misst und Börsenpreise vorliegen, erscheint hier Ihr Verlauf.
                    </p>
                  )}
                </Card>
              </div>

              <div className="vp-dash-energy">
                <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
                  <span className="vp-card-label">Energie · {period}</span>
                  <EnergyStatsRow money={siteEarnings} />
                </Card>
              </div>
            </>
          )}
        </div>

        {/* ---- Zone B · Live (bewegt) ------------------------------------ */}
        <div className="vp-zone vp-zone-live">
          <div className="vp-dash-live">
            <Card padding="lg" radius="lg" className="vp-site-status" style={{ minWidth: 0 }}>
              <span className="vp-card-label">Jetzt gerade</span>
              {overview == null && overviewFailed ? (
                <ErrorState
                  message="Der Live-Zustand Ihrer Anlage konnte gerade nicht geladen werden."
                  onRetry={() => setReloadKey((k) => k + 1)}
                />
              ) : ovSite == null ? (
                <Skeleton height={240} radius="var(--vp-radius-md)" />
              ) : (
                <>
                  {adaptiveLive.adaptive && adaptiveLive.topology ? (
                    <AdaptiveEnergyFlow
                      topology={adaptiveLive.topology}
                      stale={
                        liveState({
                          entityFresh: adaptiveLive.topology.entities.some(
                            (e) => e.health === 'ok',
                          ),
                          siteFresh: fresh,
                        }) === 'stale'
                      }
                    />
                  ) : (
                    <EnergyFlow snapshot={siteSnapshot(ovSite.live)} stale={!fresh} />
                  )}
                  {weatherWhyText && fresh && (
                    <p className="vp-live-why">
                      <Icon name="sun" size={14} /> {weatherWhyText}
                    </p>
                  )}
                  <div className="vp-site-status-foot">
                    <span className="vp-note">
                      {ovSite.live ? `Stand ${fmtRelative(ovSite.live.ts, now)}` : ''}
                    </span>
                    <a
                      href={`#/anlage/${site.id}/live`}
                      onClick={(e) => {
                        e.preventDefault();
                        onOpenSub('live');
                      }}
                    >
                      Live-Daten im Detail →
                    </a>
                  </div>
                </>
              )}
            </Card>
          </div>

          {/* Steuerung: honest even before the first readback (report N4). */}
          {controlView && (
            <div className="vp-dash-control">
              <ControlStrip view={controlView} />
            </div>
          )}

          {/* Plan-traf-zu one-liner (report N5): the optimizer's trust number. */}
          {planTraf && (
            <div className="vp-dash-plantraf">
              <PlanTrafCard traf={planTraf} onOpen={() => onOpenSub('fahrplan')} />
            </div>
          )}
        </div>

        {/* ---- Zone C · Rail (Desktop-only) ------------------------------ */}
        <div className="vp-zone vp-zone-rail">
          {money.showFullMoney && range === 'month' && (
            <div className="vp-dash-rail">
              <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
                <MonthRail
                  slots={stripSlots(siteEarnings?.monthlyStrip ?? [], now)}
                  selectedMonth={selectedMonth}
                  onSelect={selectMonth}
                />
              </Card>
            </div>
          )}
          {health.length > 0 && (
            <div className="vp-dash-health">
              <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
                <HealthChecklist items={health} />
              </Card>
            </div>
          )}
        </div>

        {/* ---- Fahrplan-Band (volle Breite) ----------------------------- */}
        <div className="vp-dash-fahrplan">
          <FahrplanBand
            plan={plan}
            plantKind={site.plantKind}
            now={now}
            loading={planLoading && plan == null}
            failed={planFailed}
            onOpen={() => onOpenSub('fahrplan')}
          />
        </div>

        {/* ---- Tiefer schauen (volle Breite) ---------------------------- */}
        <div className="vp-dash-deep">
          <div className="vp-detail-grid">
            <DetailCard
              icon="history"
              category="home"
              title="Historie & Erlöse"
              line="Ihre Tage im Rückblick - Kosten, Ersparnis, Verhalten."
              onOpen={() => onOpenSub('historie')}
            />
            <DetailCard
              icon="sun"
              category="solar"
              title="Wetter am Standort"
              line={
                nextHourTempC != null
                  ? `Nächste Stunde ${fmtNum(nextHourTempC, '°C')}.`
                  : 'Die Vorhersage für Ihre Anlage.'
              }
              onOpen={() => onOpenSub('wetter')}
            />
            <DetailCard
              icon="settings"
              category="industry"
              title="Technik & Einstellungen"
              line="Wechselrichter, Speicher, Tarif und Standort."
              onOpen={() => onOpenSub('technik')}
            />
            <DetailCard
              icon="layers"
              category="primary"
              title="Anlagen-Modell"
              line="Geräte, Komponenten und was das Cockpit daraus macht."
              onOpen={() => onOpenSub('modell')}
            />
            <DetailCard
              icon="zap"
              category="primary"
              title="Steuerung"
              line="Was läuft - und eigene Strategien & Automationen bauen."
              onOpen={() => onOpenSub('steuerung')}
            />
          </div>
        </div>
      </div>
        </>
      )}

      {/* Single-Anlage customers have no Übersicht/Anlagen-Liste; their way to
          a SECOND Anlage is the always-visible "＋ Anlage hinzufügen" action in
          the shell header (App.tsx / AppShell, gated by showAddAnlageButton).
          From the second Anlage on, the list and fleet Übersicht carry it. */}
    </>
  );
}

/**
 * The Plan-traf-zu one-liner card (report N5): the single most trust-building
 * graduated number - "Der Fahrplan traf gestern zu 93 % zu", plus the realized
 * advantage vs. doing nothing when positive. Tapping opens the full Fahrplan.
 */
function PlanTrafCard({ traf, onOpen }: { traf: PlanTrafZu; onOpen: () => void }) {
  return (
    <button type="button" className="vp-plantraf" onClick={onOpen}>
      <span className="vp-plantraf-ico" aria-hidden="true">
        <Icon name="trending-up" size={18} />
      </span>
      <span className="vp-plantraf-text">
        Der Fahrplan traf {traf.whenLabel} zu <b>{traf.accuracyPct} %</b> zu
        {traf.savedVsBaselineEur != null && (
          <> · <b>+{eurAmount(traf.savedVsBaselineEur)}</b> ggü. ohne Speicher</>
        )}
        .
      </span>
      <span className="vp-plantraf-chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/**
 * AE4: the quiet money affordance shown in the hero slot when the usage profile
 * (private) takes money out of the hero. It de-emphasises the number without
 * destroying access - one tap reaches the full Erlöse/Wert rückblick.
 */
function MoneyGlanceCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="vp-money-glance" onClick={onOpen}>
      <span className="vp-money-glance-ico" aria-hidden="true">
        <Icon name="euro" size={18} />
      </span>
      <span className="vp-money-glance-text">
        <b>Erlöse &amp; Wert</b>
        <span>Ihr finanzieller Rückblick - im Detail ansehen.</span>
      </span>
      <span className="vp-money-glance-chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/** One "where is the detail" link card: icon, title, one calm German line. */
function DetailCard({
  icon,
  category,
  title,
  line,
  onOpen,
}: {
  icon: IconName;
  category: IconCategory;
  title: string;
  line: string;
  onOpen: () => void;
}) {
  return (
    <Card
      interactive
      className="vp-detail-card"
      style={{ minWidth: 0 }}
      onClick={onOpen}
      role="link"
      tabIndex={0}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`${title} öffnen`}
    >
      <div className="vp-detail-card-head">
        <IconTile category={category} size={40}>
          <Icon name={icon} size={20} />
        </IconTile>
        <span className="vp-fleet-chev" aria-hidden="true">
          ›
        </span>
      </div>
      <span className="vp-detail-card-title">{title}</span>
      <span className="vp-detail-card-line">{line}</span>
    </Card>
  );
}
