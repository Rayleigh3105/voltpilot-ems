import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile, type IconCategory } from '../../designsystem/components/core/IconTile';
import {
  api,
  type Device,
  type Earnings,
  type EarningsRange,
  type Overview,
  type SchedulePlan,
  type Site,
} from '../api';
import {
  BATTERY_NO_DEVICE_WARNING,
  composeSiteSentence,
  fleetKind,
  notComputableHint,
  premiumIncluded,
  siteLiveFresh,
  siteSnapshot,
} from '../fleet';
import { eurAmount, fmtNum, fmtRelative, plantKindLabel } from '../format';
import { anlageRoute, type AnlagenSub, type Route } from '../nav';
import { planHourBars, planSentence, savingsTodayEur } from '../schedule';
import { nextHourIndex } from '../weather';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { EnergyFlow } from '../components/EnergyFlow';
import { FleetSiteCard } from '../components/FleetOverview';
import { EarningsHero } from '../components/FleetOverview';
import { NetzladenBadge } from '../components/NetzladenBadge';
import { ErrorState, Skeleton } from '../components/States';
import { FahrplanSection, WetterSection } from './DataPages';
import { HistorieSection } from './HistorieSection';
import { LiveSection } from './LiveSection';
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

  const requested = route.siteId ? sites.find((s) => s.id === route.siteId) ?? null : null;
  const site = requested ?? (sites.length === 1 ? sites[0] : null);

  if (!site) {
    return (
      <AnlagenListe
        sites={sites}
        onOpen={(id) => onNavigate(anlageRoute(id))}
        onReload={props.onReload}
      />
    );
  }

  if (route.sub) {
    return (
      <AnlagenSubPage
        site={site}
        sub={route.sub}
        onBack={() => onNavigate(anlageRoute(site.id))}
      />
    );
  }

  return (
    <AnlageSeite
      {...props}
      site={site}
      onOpenSub={(sub) => onNavigate(anlageRoute(site.id, sub))}
      onBackToList={sites.length > 1 ? () => onNavigate({ page: 'anlagen', siteId: null, sub: null }) : null}
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
      <CreateSiteDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onCreate={(input) => api.createSite(input)}
        onCreated={(s) => onReload(s.id)}
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

      <CreateSiteDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onCreate={(input) => api.createSite(input)}
        onCreated={(s) => onReload(s.id)}
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
};

/** One deep view of an Anlage, with the way back always in sight. */
function AnlagenSubPage({
  site,
  sub,
  onBack,
}: {
  site: Site;
  sub: AnlagenSub;
  onBack: () => void;
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
  devices,
  onReload,
  onOpenSub,
  onBackToList,
}: AnlagenPageProps & {
  site: Site;
  onOpenSub: (sub: AnlagenSub) => void;
  onBackToList: (() => void) | null;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnFailed, setEarnFailed] = useState(false);
  const [range, setRange] = useState<EarningsRange>('month');
  const [plan, setPlan] = useState<SchedulePlan | null>(null);
  const [nextHourTempC, setNextHourTempC] = useState<number | null>(null);
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

  // The measured money hero - tenant-wide response, rendered site-scoped.
  useEffect(() => {
    let active = true;
    api.earnings(range).then(
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
  }, [site.id, reloadKey, range]);

  // Fahrplan mini preview + Wetter teaser, loaded silently: a failure keeps
  // the calm static copy, the links always work.
  useEffect(() => {
    let active = true;
    api.schedule(site.id).then(
      (p) => {
        if (active) setPlan(p);
      },
      () => {
        if (active) setPlan(null);
      },
    );
    api.weather(site.id).then(
      (w) => {
        if (!active) return;
        const idx = nextHourIndex(w.points, Date.now());
        setNextHourTempC(idx >= 0 ? (w.points[idx].temperatureC ?? null) : null);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Freshness tick (5 s) + silent 30 s background poll.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(new Date());
      if (++ticks % Math.round(POLL_MS / TICK_MS) === 0) {
        api.overview().then(
          (o) => setOverview(o),
          () => {},
        );
        api.earnings(rangeRef.current).then(
          (e) => setEarnings(e),
          () => {},
        );
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const ovSite = overview?.sites.find((x) => x.id === site.id) ?? null;
  const sentence = ovSite ? composeSiteSentence(ovSite, now) : null;
  const fresh = ovSite ? siteLiveFresh(ovSite, now) : false;
  const siteEarnings = earnings?.sites.find((x) => x.id === site.id) ?? null;

  const slots = plan?.slots ?? [];
  const planText = planSentence(slots, site.plantKind, now);
  const planSavings = savingsTodayEur(slots, now);
  const bars = planHourBars(slots, now);
  const maxBarKw = bars.reduce((m, b) => Math.max(m, b.kw ?? 0), 0);

  return (
    <>
      {onBackToList && (
        <button type="button" className="vp-fleet-back" onClick={onBackToList}>
          <Icon name="chevron-left" size={18} />
          Alle Anlagen
        </button>
      )}

      {/* 1 · Kopf: Ist alles gut? Ein Blick. */}
      <div className="vp-page-head vp-anlage-head">
        <div className="titles">
          <h1>
            <span
              className={`vp-fleet-dot tone-${sentence?.tone ?? 'off'}`}
              aria-hidden="true"
            />
            {site.name}
          </h1>
          {sentence ? (
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
        </div>
      </div>

      {ovSite?.batteryWithoutDevice && (
        <div className="vp-alert vp-alert-warn" style={{ marginBottom: 'var(--vp-space-4)' }}>
          {BATTERY_NO_DEVICE_WARNING}
        </div>
      )}

      {/* 2 · Geld + 3 · Jetzt (side by side on wide screens, stacked on phones). */}
      <div className="vp-fleet-top">
        {earnings == null && !earnFailed ? (
          <Skeleton height={300} radius="var(--vp-radius-lg)" />
        ) : (
          <EarningsHero
            kind={fleetKind([site.plantKind])}
            money={siteEarnings}
            dailySaved={siteEarnings?.dailySaved ?? []}
            range={range}
            dataRange={earnings?.range}
            onRange={setRange}
            now={now}
            unavailable={earnFailed}
            premium={siteEarnings ? premiumIncluded([siteEarnings]) : false}
            emptyHint={
              siteEarnings?.reason ? notComputableHint(siteEarnings.reason) : undefined
            }
          />
        )}

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
              <EnergyFlow snapshot={siteSnapshot(ovSite.live)} stale={!fresh} />
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

      {/* 4 · Fahrplan: die Mini-Vorschau mit dem einen deutschen Satz. */}
      <section className="vp-section" aria-label="Fahrplan heute">
        <Card padding="lg" radius="lg" className="vp-plan-mini-card" style={{ minWidth: 0 }}>
          <span className="vp-card-label">Fahrplan · heute</span>
          {plan != null && slots.length > 0 ? (
            <>
              <div className="vp-plan-mini" role="img" aria-label="Fahrplan-Vorschau für heute">
                {bars.map((b) => (
                  <i
                    key={b.hour}
                    className={
                      b.kw == null || b.kind === 'ruhe'
                        ? 'idle'
                        : b.kind === 'entladen'
                          ? 'dis'
                          : b.kind === 'netzladen'
                            ? 'grid'
                            : 'ch'
                    }
                    style={
                      b.kw != null && b.kind !== 'ruhe' && maxBarKw > 0
                        ? { height: `${Math.max(18, Math.round((b.kw / maxBarKw) * 100))}%` }
                        : undefined
                    }
                    title={`${b.hour}–${b.hour + 1} Uhr`}
                  />
                ))}
              </div>
              <p className="vp-plan-mini-text">
                {planText ?? 'Der Fahrplan für heute liegt noch nicht vor.'}
                {planSavings != null && (
                  <>
                    {' '}
                    <b>
                      Heute geplant: {planSavings >= 0 ? '+' : ''}
                      {eurAmount(planSavings)}
                    </b>
                  </>
                )}
              </p>
            </>
          ) : (
            <p className="vp-plan-mini-text">
              Noch kein Fahrplan. Sobald Ihre Anlage einen Speicher meldet und
              Börsenpreise vorliegen, plant VoltPilot den Tag automatisch.
            </p>
          )}
          <div className="vp-site-status-foot" style={{ marginTop: 'var(--vp-space-3)' }}>
            <span />
            <a
              href={`#/anlage/${site.id}/fahrplan`}
              onClick={(e) => {
                e.preventDefault();
                onOpenSub('fahrplan');
              }}
            >
              Ganzen Fahrplan ansehen →
            </a>
          </div>
        </Card>
      </section>

      {/* 5 · Technik: Wechselrichter, Speicher, Register, Standort. */}
      <section className="vp-section" aria-label="Technik">
        <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
            <IconTile category="industry" size={40}>
              <Icon name="zap" size={20} />
            </IconTile>
            <h2>Technik</h2>
          </div>
          <TechnikSection
            site={site}
            devices={devices}
            sites={sites}
            onReload={onReload}
            onSiteSaved={(updated) => onReload(updated.id)}
            onSiteDeleted={() => {
              if (onBackToList) onBackToList();
            }}
          />
        </Card>
      </section>

      {/* 6 · Mehr zu dieser Anlage. */}
      <section className="vp-section" aria-label="Mehr zu dieser Anlage">
        <div className="vp-detail-grid two">
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
        </div>
      </section>
    </>
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
