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
  type Site,
} from '../api';
import { currentUser } from '../auth';
import { ctPerKwh, fmtNum, fmtRelative } from '../format';
import {
  composeSiteSentence,
  fleetDailySaved,
  fleetKind,
  notComputableHint,
  premiumIncluded,
  siteLiveFresh,
  siteSnapshot,
} from '../fleet';
import type { PageId } from '../nav';
import { nextHourIndex } from '../weather';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { AddDeviceDrawer } from '../components/DeviceDrawers';
import { ErrorState, Skeleton } from '../components/States';
import { EnergyFlow } from '../components/EnergyFlow';
import { EarningsHero, FleetSiteCard, FleetStatusCard } from '../components/FleetOverview';

/** Background refresh cadence of the live widgets (GeraetePage pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness note. */
const TICK_MS = 5_000;

interface UebersichtProps {
  sites: Site[];
  devices: Device[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
  onNavigate: (page: PageId) => void;
  onReload: (selectSiteId?: string) => void;
  isAdmin?: boolean;
}

/**
 * The ADAPTIVE Übersicht landing (captain decision: one landing, no new nav
 * item): customers with several sites get the fleet mode - money hero, fleet
 * status sentence, per-site cards - and drill into today's single-site view by
 * tapping a card ("‹ Alle Standorte" leads back). Single-site customers see
 * the unchanged single-site layout.
 */
export function UebersichtPage(props: UebersichtProps) {
  const multiSite = props.sites.length > 1;
  const [drill, setDrill] = useState(false);
  if (!multiSite) return <SingleSiteUebersicht {...props} />;
  if (drill) {
    return <SingleSiteUebersicht {...props} onBackToFleet={() => setDrill(false)} />;
  }
  return (
    <FleetUebersicht
      {...props}
      onOpenSite={(id) => {
        props.onSelectSite(id);
        setDrill(true);
      }}
    />
  );
}

/**
 * Fleet mode: one tenant-wide overview request (30 s background poll like the
 * single-site widgets) renders the hero + status sentence + site cards. No
 * Ø-Preis KPI here (captain decision - meaningless across bidding zones);
 * price detail lives in the drill-down and on the Marktpreise page.
 */
function FleetUebersicht({
  onOpenSite,
  onReload,
  sites,
}: UebersichtProps & { onOpenSite: (id: string) => void }) {
  const user = currentUser();
  const firstName = (user.name || '').split(/\s+/)[0] || user.name;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnFailed, setEarnFailed] = useState(false);
  // Realized-earnings hero period; Monat is the default (captain decision).
  const [range, setRange] = useState<EarningsRange>('month');
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

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
  }, [reloadKey]);

  // The measured money numbers - refetched when the hero period changes; the
  // hero keeps the previous numbers until the new ones arrive (no flash).
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
  }, [reloadKey, range]);

  // Freshness tick (5 s) + silent background poll (30 s) - the page keeps its
  // last good data on a poll failure, exactly like the single-site widgets.
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

  const earningsBySite = new Map((earnings?.sites ?? []).map((s) => [s.id, s]));

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Guten Tag, {firstName}</h1>
          <p>Alle Ihre Standorte auf einen Blick.</p>
        </div>
        <div className="actions">
          <Button variant="outline" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
            Standort
          </Button>
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDeviceDrawer(true)}>
            Gerät hinzufügen
          </Button>
        </div>
      </div>

      {overview == null && failed ? (
        <Card padding="lg" radius="lg">
          <ErrorState
            message="Die Übersicht konnte gerade nicht geladen werden. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        </Card>
      ) : overview == null ? (
        <>
          <div className="vp-fleet-top">
            <Skeleton height={240} radius="var(--vp-radius-lg)" />
            <Skeleton height={120} radius="var(--vp-radius-lg)" />
          </div>
          <section className="vp-section">
            <div className="vp-grid vp-fleet-grid">
              <Skeleton height={190} radius="var(--vp-radius-lg)" />
              <Skeleton height={190} radius="var(--vp-radius-lg)" />
              <Skeleton height={190} radius="var(--vp-radius-lg)" />
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="vp-fleet-top">
            {earnings == null && !earnFailed ? (
              <Skeleton height={300} radius="var(--vp-radius-lg)" />
            ) : (
              <EarningsHero
                kind={fleetKind(overview.sites.map((s) => s.plantKind))}
                money={earnings ? earnings.totals : null}
                dailySaved={earnings ? fleetDailySaved(earnings.sites) : []}
                range={range}
                dataRange={earnings?.range}
                onRange={setRange}
                now={now}
                unavailable={earnFailed}
                premium={earnings ? premiumIncluded(earnings.sites) : false}
              />
            )}
            <FleetStatusCard overview={overview} now={now} />
          </div>

          <section className="vp-section" aria-label="Meine Standorte">
            <div className="vp-section-head">
              <IconTile category="home" size={40}>
                <Icon name="map-pin" size={20} />
              </IconTile>
              <h2>Meine Standorte</h2>
              <Badge variant="tint">{overview.sites.length}</Badge>
            </div>
            <div className="vp-grid vp-fleet-grid">
              {overview.sites.map((s) => (
                <FleetSiteCard
                  key={s.id}
                  site={s}
                  earnings={earningsBySite.get(s.id) ?? null}
                  now={now}
                  onOpen={() => onOpenSite(s.id)}
                />
              ))}
            </div>
          </section>
        </>
      )}

      <CreateSiteDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onCreate={(input) => api.createSite(input)}
        onCreated={(s) => {
          onReload(s.id);
          setReloadKey((k) => k + 1);
        }}
      />
      <AddDeviceDrawer
        open={deviceDrawer}
        onClose={() => setDeviceDrawer(false)}
        sites={sites}
        onClaimed={() => {
          onReload();
          setReloadKey((k) => k + 1);
        }}
      />
    </>
  );
}

/**
 * The simplified single-site Übersicht (single-site customers and the fleet
 * drill-down target). Three calm blocks answer, in order: (1) how much money
 * VoltPilot made me - the measured EarningsHero, unchanged; (2) is everything
 * running - ONE plain-German status sentence plus the energy-flow diagram as
 * the single centerpiece; (3) where is the detail - link cards to Fahrplan /
 * Historie / Marktpreise / Wetter, with the Live-Daten link in the status
 * card. The depth itself (Verlauf chart, price chart, weather panel, site
 * list) lives on those pages, so a phone fits this screen with gentle
 * scrolling. In fleet mode this is the drill-down target and carries the
 * "‹ Alle Standorte" back affordance.
 */
function SingleSiteUebersicht({
  sites,
  selectedSite,
  onNavigate,
  onReload,
  isAdmin = false,
  onBackToFleet,
}: UebersichtProps & { onBackToFleet?: () => void }) {
  const user = currentUser();
  const site = sites.find((s) => s.id === selectedSite) ?? null;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  // Realized earnings for the hero (captain decision 6: single-site customers
  // get the same measured hero; in fleet mode the drill-down shows it
  // site-scoped). The planned number lives on the Fahrplan page only.
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnFailed, setEarnFailed] = useState(false);
  const [range, setRange] = useState<EarningsRange>('month');
  // Teaser lines of the detail cards, loaded silently: a failure just keeps
  // the static copy - the links always work, so no error state is needed.
  const [avgPriceToday, setAvgPriceToday] = useState<number | null>(null);
  const [nextHourTempC, setNextHourTempC] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

  // The status card's data: the site's overview row (device health + newest
  // live snapshot) - the same source the fleet cards render from.
  useEffect(() => {
    if (sites.length === 0) return;
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
    // `sites` identity only changes on explicit App reloads (site created /
    // device claimed), so refetching on it keeps a brand-new site's status
    // current without waiting for the 30 s poll.
  }, [sites, reloadKey]);

  // The measured money hero - tenant-wide response, rendered site-scoped; the
  // hero keeps the previous numbers while a period switch is in flight.
  useEffect(() => {
    if (sites.length === 0) return;
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
  }, [sites, reloadKey, range]);

  // Detail-card teaser lines (Ø price today, next-hour temperature).
  useEffect(() => {
    if (!site) {
      setAvgPriceToday(null);
      setNextHourTempC(null);
      return;
    }
    let active = true;
    const today = new Date().toDateString();
    api.prices(site.id).then(
      (p) => {
        if (!active) return;
        const values = p.points
          .filter((x) => new Date(x.ts).toDateString() === today)
          .map((x) => x.priceEurMwh)
          .filter((v): v is number => v != null);
        setAvgPriceToday(
          values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
        );
      },
      () => {},
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
  }, [site?.id, reloadKey]);

  // Freshness tick (5 s) + silent 30 s background poll (the fleet-mode
  // pattern) - the page keeps its last good data on a poll failure.
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

  const retry = () => setReloadKey((k) => k + 1);
  const firstName = (user.name || '').split(/\s+/)[0] || user.name;
  const siteEarnings = earnings?.sites.find((x) => x.id === site?.id) ?? null;
  const ovSite = overview?.sites.find((x) => x.id === site?.id) ?? null;
  const sentence = ovSite ? composeSiteSentence(ovSite, now) : null;
  const fresh = ovSite ? siteLiveFresh(ovSite, now) : false;

  if (sites.length === 0) {
    // Empty-state: for a customer this is the onboarding entry (never a
    // dead-end); for an admin viewing an empty tenant it is a neutral notice,
    // not customer-directed "Willkommen"-onboarding copy (m3).
    return (
      <>
        <div className="vp-page-head">
          <div className="titles">
            <h1>{isAdmin ? 'Übersicht' : 'Willkommen bei VoltPilot'}</h1>
            <p>
              {isAdmin
                ? 'Dieser Mandant hat noch keine Standorte.'
                : 'Legen Sie Ihren ersten Standort an, um Geräte zu verbinden und Live-Daten, Preise und Fahrplan zu sehen.'}
            </p>
          </div>
        </div>
        <Card padding="lg" radius="lg">
          <div className="vp-empty">
            <IconTile category="home" size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
              <Icon name="map-pin" size={24} />
            </IconTile>
            <h3>{isAdmin ? 'Dieser Mandant hat noch keine Standorte' : 'Noch kein Standort'}</h3>
            <p>
              {isAdmin
                ? 'Sobald für diesen Mandanten ein Standort angelegt ist, erscheinen hier seine Geräte, Marktpreise, Wetter und der Batterie-Fahrplan. Sie können im Namen des Mandanten einen Standort anlegen.'
                : 'Ein Standort bündelt Ihre Geräte, Marktpreise, Wetter und den Batterie-Fahrplan. Danach verbinden Sie Ihre Geräte in wenigen Schritten.'}
            </p>
            <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setSiteDrawer(true)}>
              {isAdmin ? 'Standort anlegen' : 'Ersten Standort anlegen'}
            </Button>
          </div>
        </Card>
        <CreateSiteDrawer
          open={siteDrawer}
          onClose={() => setSiteDrawer(false)}
          onCreate={(input) => api.createSite(input)}
          onCreated={(s) => onReload(s.id)}
        />
      </>
    );
  }

  return (
    <>
      {onBackToFleet && (
        <button type="button" className="vp-fleet-back" onClick={onBackToFleet}>
          <Icon name="chevron-left" size={18} />
          Alle Standorte
        </button>
      )}
      <div className="vp-page-head">
        <div className="titles">
          <h1>{onBackToFleet ? site?.name ?? 'Standort' : `Guten Tag, ${firstName}`}</h1>
          <p>
            {onBackToFleet
              ? 'Alles Wichtige zu diesem Standort auf einen Blick.'
              : 'Ihre Anlage auf einen Blick.'}
          </p>
        </div>
        <div className="actions">
          <Button variant="primary" iconLeft={<Icon name="plus" size={18} />} onClick={() => setDeviceDrawer(true)}>
            Gerät hinzufügen
          </Button>
        </div>
      </div>

      {/* Money first + is-everything-running: the fleet mode's hero/status
          split, so both Übersicht modes feel like one product. */}
      <div className="vp-fleet-top">
        {earnings == null && !earnFailed ? (
          <Skeleton height={300} radius="var(--vp-radius-lg)" />
        ) : (
          <EarningsHero
            kind={fleetKind(site ? [site.plantKind] : [])}
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
          {overview == null && overviewFailed ? (
            <ErrorState
              message="Der Status Ihrer Anlage konnte gerade nicht geladen werden."
              onRetry={retry}
            />
          ) : ovSite == null || sentence == null ? (
            <Skeleton height={280} radius="var(--vp-radius-md)" />
          ) : (
            <>
              <p className={`vp-fleet-sentence tone-${sentence.tone}`}>
                <span className="vp-fleet-dot" aria-hidden="true" />
                <span>{sentence.text}</span>
              </p>
              <EnergyFlow snapshot={siteSnapshot(ovSite.live)} stale={!fresh} />
              <div className="vp-site-status-foot">
                <span className="vp-note">
                  {ovSite.live ? `Stand ${fmtRelative(ovSite.live.ts, now)}` : ''}
                </span>
                <a
                  href="#/live"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate('live');
                  }}
                >
                  Live-Daten im Detail →
                </a>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Where the depth lives: one calm link card per detail page. */}
      <section className="vp-section" aria-label="Mehr zu Ihrer Anlage">
        <div className="vp-detail-grid">
          <DetailCard
            icon="battery-charging"
            category="battery"
            title="Fahrplan"
            line="So plant Ihr Speicher den Tag."
            onOpen={() => onNavigate('fahrplan')}
          />
          <DetailCard
            icon="history"
            category="home"
            title="Historie"
            line="Ihre Tage im Rückblick."
            onOpen={() => onNavigate('historie')}
          />
          <DetailCard
            icon="euro"
            category="dynamic"
            title="Marktpreise"
            line={
              avgPriceToday != null
                ? `Heute im Schnitt ${ctPerKwh(avgPriceToday)}.`
                : 'Börsenpreise für heute und morgen.'
            }
            onOpen={() => onNavigate('marktpreise')}
          />
          <DetailCard
            icon="sun"
            category="solar"
            title="Wetter"
            line={
              nextHourTempC != null
                ? `Nächste Stunde ${fmtNum(nextHourTempC, '°C')}.`
                : 'Die Vorhersage für Ihren Standort.'
            }
            onOpen={() => onNavigate('wetter')}
          />
        </div>
      </section>

      <AddDeviceDrawer
        open={deviceDrawer}
        onClose={() => setDeviceDrawer(false)}
        sites={sites}
        onClaimed={() => onReload()}
      />
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
