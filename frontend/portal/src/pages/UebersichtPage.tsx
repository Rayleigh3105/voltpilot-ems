import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Button } from '../../designsystem/components/core/Button';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { Stat } from '../../designsystem/components/core/Stat';
import {
  api,
  deviceLiveStatus,
  ONLINE_WINDOW_MS,
  type Device,
  type Earnings,
  type EarningsRange,
  type Overview,
  type PriceSeries,
  type Site,
  type TelemetryPoint,
  type WeatherForecast,
} from '../api';
import { currentUser } from '../auth';
import { ctPerKwh, fmtNum, fmtRelative, zoneLabel } from '../format';
import { fleetDailySaved, fleetKind, notComputableHint, premiumIncluded } from '../fleet';
import type { PageId } from '../nav';
import { SitePicker } from '../components/SitePicker';
import { CreateSiteDrawer } from '../components/CreateSiteDrawer';
import { AddDeviceDrawer } from '../components/DeviceDrawers';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, ErrorState, Skeleton, TextSkeleton } from '../components/States';
import { LiveHero } from '../components/LiveHero';
import { EarningsHero, FleetSiteCard, FleetStatusCard } from '../components/FleetOverview';
import { TelemetryChart } from '../TelemetryChart';
import { PriceChart } from '../PriceChart';

/** Background refresh cadence of the Live-Daten widget (GeraetePage pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness chip. */
const TICK_MS = 5_000;

/** Verlauf window toggle: fetch only the selected window (F6 - the API
 *  downsamples windows > 3h server-side to keep them complete AND current). */
type LiveWindow = '1h' | '3h' | 'today';
const LIVE_WINDOWS: { id: LiveWindow; label: string; insight: string }[] = [
  { id: '1h', label: '1 Std', insight: 'in der letzten Stunde' },
  { id: '3h', label: '3 Std', insight: 'in den letzten 3 Stunden' },
  { id: 'today', label: 'Heute', insight: 'heute' },
];

/** Start of the fetched telemetry window: now-1h / now-3h / local midnight. */
function windowStart(win: LiveWindow, now: Date): Date {
  const from = new Date(now);
  if (win === '1h') from.setHours(from.getHours() - 1);
  else if (win === '3h') from.setHours(from.getHours() - 3);
  else from.setHours(0, 0, 0, 0);
  return from;
}

/**
 * A widget whose data failed to load: a distinct error card with a retry, NOT
 * the benign "waiting for data / no prices" empty copy (M2). Keeps the outage
 * honest instead of reassuring.
 */
function WidgetError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <ErrorState message={message} onRetry={onRetry} />;
}

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
 * The single-site Übersicht body: money-first KPI hero row (savings + price
 * lead), live telemetry as the primary widget, prices + weather secondary, and
 * the quick site list. Unchanged for single-site customers; in fleet mode it
 * is the drill-down target and carries the "‹ Alle Standorte" back affordance.
 */
function SingleSiteUebersicht({
  sites,
  devices,
  selectedSite,
  onSelectSite,
  onNavigate,
  onReload,
  isAdmin = false,
  onBackToFleet,
}: UebersichtProps & { onBackToFleet?: () => void }) {
  const user = currentUser();
  const site = sites.find((s) => s.id === selectedSite) ?? null;

  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [prices, setPrices] = useState<PriceSeries | null>(null);
  const [weather, setWeather] = useState<WeatherForecast | null>(null);
  // Realized earnings for the hero (captain decision 6: single-site customers
  // get the same measured hero; in fleet mode the drill-down shows it
  // site-scoped). The planned number lives on the Fahrplan page only.
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [earnFailed, setEarnFailed] = useState(false);
  const [range, setRange] = useState<EarningsRange>('month');
  // Per-widget load failure flags: an outage must render a distinct
  // "konnte nicht geladen werden" card, NOT the benign "waiting for data /
  // no prices" empty state (M2). Each is set when its endpoint rejects.
  const [failed, setFailed] = useState({
    telemetry: false,
    prices: false,
    weather: false,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingTelemetry, setLoadingTelemetry] = useState(false);
  const [liveWindow, setLiveWindow] = useState<LiveWindow>('3h');
  // The status layer (sentence/tiles/flow) always shows; the Verlauf chart is
  // secondary and collapses behind a toggle on phones (report direction B).
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
  );
  const [chartOpen, setChartOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 720px)');
    const on = () => setIsPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [siteDrawer, setSiteDrawer] = useState(false);
  const [deviceDrawer, setDeviceDrawer] = useState(false);

  // Secondary widgets (prices/weather) - independent of the live window, so a
  // window toggle never re-flashes their skeletons.
  useEffect(() => {
    if (!site) {
      setPrices(null);
      setWeather(null);
      setFailed((f) => ({ ...f, prices: false, weather: false }));
      return;
    }
    let active = true;
    setLoading(true);
    Promise.allSettled([api.prices(site.id), api.weather(site.id)]).then(
      ([p, w]) => {
        if (!active) return;
        if (p.status === 'fulfilled') setPrices(p.value);
        if (w.status === 'fulfilled') setWeather(w.value);
        setFailed((f) => ({
          ...f,
          prices: p.status === 'rejected',
          weather: w.status === 'rejected',
        }));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [site?.id, reloadKey]);

  // The measured money hero - tenant-wide response, rendered site-scoped.
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
  }, [sites.length === 0, reloadKey, range]);

  // Live telemetry - refetched on the selected window (F6: only that window,
  // downsampled server-side beyond 3 h so it stays complete and current).
  useEffect(() => {
    if (!site) {
      setTelemetry([]);
      setFailed((f) => ({ ...f, telemetry: false }));
      return;
    }
    let active = true;
    setLoadingTelemetry(true);
    const to = new Date();
    api
      .telemetry(site.id, windowStart(liveWindow, to).toISOString(), to.toISOString())
      .then(
        (t) => {
          if (!active) return;
          setTelemetry(t);
          setFailed((f) => ({ ...f, telemetry: false }));
          setLoadingTelemetry(false);
        },
        () => {
          if (!active) return;
          setFailed((f) => ({ ...f, telemetry: true }));
          setLoadingTelemetry(false);
        },
      );
    return () => {
      active = false;
    };
  }, [site?.id, reloadKey, liveWindow]);

  const retry = () => setReloadKey((k) => k + 1);

  // "Live-Daten" must be live (F4): poll the telemetry every 30 s in the
  // background - silent on failure, the card keeps its last good values - and
  // tick a clock every 5 s so the freshness chip counts honestly. One stable
  // interval reads the latest site + window via refs (the GeraetePage pattern).
  const [now, setNow] = useState(() => new Date());
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    if (!site) return;
    const to = new Date();
    api.telemetry(site.id, windowStart(liveWindow, to).toISOString(), to.toISOString()).then(
      (t) => setTelemetry(t),
      () => {}, // background poll: fail silently, keep the last good data
    );
  };
  useEffect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(new Date());
      if (++ticks % Math.round(POLL_MS / TICK_MS) === 0) pollRef.current();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // --- Hero derivations (money first, measured) -----------------------------
  const today = new Date();
  const siteEarnings = earnings?.sites.find((x) => x.id === site?.id) ?? null;

  const todayPrices = (prices?.points ?? [])
    .filter((p) => new Date(p.ts).toDateString() === today.toDateString())
    .map((p) => p.priceEurMwh)
    .filter((v): v is number => v != null);
  const avgPriceToday = todayPrices.length
    ? todayPrices.reduce((a, b) => a + b, 0) / todayPrices.length
    : null;

  const online = devices.filter((d) => deviceLiveStatus(d) === 'online').length;
  const latest = telemetry.length ? telemetry[telemetry.length - 1] : null;
  // Honest freshness for the Live-Daten card: green + "Stand vor X" while the
  // newest sample is inside the 5-min liveness window (deviceLiveStatus
  // convention), grey + "keine aktuellen Daten" beyond it. The status hero
  // keeps its last good values but dims (the edge dashboard's .stale precedent).
  const telemetryFresh =
    latest != null && now.getTime() - new Date(latest.ts).getTime() <= ONLINE_WINDOW_MS;
  const weatherNow = weather?.points?.[0] ?? null;
  const activeWindow = LIVE_WINDOWS.find((w) => w.id === liveWindow) ?? LIVE_WINDOWS[1];
  const allFailed =
    site != null && failed.telemetry && failed.prices && failed.weather && earnFailed;

  const firstName = (user.name || '').split(/\s+/)[0] || user.name;

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
              ? 'Live-Daten, Preise, Wetter und Fahrplan dieses Standorts.'
              : 'Alles Wichtige zu Ihren Standorten und Geräten auf einen Blick.'}
          </p>
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

      {allFailed && (
        <div
          className="vp-alert vp-alert-err"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--vp-space-3)', flexWrap: 'wrap' }}
        >
          <span style={{ flex: '1 1 320px' }}>
            Die Daten dieses Standorts konnten gerade nicht geladen werden. Bitte prüfen Sie
            Ihre Verbindung und versuchen Sie es erneut.
          </span>
          <Button variant="outline" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} onClick={retry}>
            Erneut versuchen
          </Button>
        </div>
      )}

      {/* Money-first hero: the MEASURED "mit VoltPilot vs. ungeregelt" number
          leads (Phase 2 of the fleet overview - same hero as the fleet mode,
          scoped to this site). The planned number lives on the Fahrplan page. */}
      {site &&
        (earnings == null && !earnFailed ? (
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
              siteEarnings?.reason
                ? notComputableHint(siteEarnings.reason)
                : undefined
            }
          />
        ))}

      {/* Bestand: counts demoted to a calm secondary strip; the day's Ø price
          keeps a quiet home here since the hero leads with measured money. */}
      <div className="vp-count-strip" role="group" aria-label="Bestand">
        <span className="vp-count-item">
          <Icon name="map-pin" size={16} />
          <strong>{sites.length}</strong> Standorte
        </span>
        <span className="vp-count-item">
          <Icon name="zap" size={16} />
          <strong>{devices.length}</strong> Geräte
        </span>
        <span className="vp-count-item">
          <Badge variant={online > 0 ? 'ok' : 'off'} dot>
            {online}/{devices.length} online
          </Badge>
        </span>
        {!failed.prices && avgPriceToday != null && (
          <span className="vp-count-item">
            <Icon name="trending-up" size={16} />
            <strong>{ctPerKwh(avgPriceToday)}</strong> Ø Börsenpreis heute
          </span>
        )}
      </div>

      {/* Hero split: live telemetry primary, prices + weather secondary. */}
      <section className="vp-section">
        <div className="vp-hero-split">
          <Card padding="lg" radius="lg" style={{ minWidth: 0 }}>
            <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
              <IconTile category="dynamic" size={40}>
                <Icon name="activity" size={20} />
              </IconTile>
              <h2>Live-Daten</h2>
              {site && <Badge variant="tint">{site.name}</Badge>}
              {latest && (
                <Badge variant={telemetryFresh ? 'ok' : 'off'} dot>
                  {telemetryFresh ? `Stand ${fmtRelative(latest.ts, now)}` : 'keine aktuellen Daten'}
                </Badge>
              )}
              <span className="actions">
                <SitePicker sites={sites} value={selectedSite} onChange={onSelectSite} />
              </span>
            </div>
            {loadingTelemetry && telemetry.length === 0 && !failed.telemetry ? (
              <ChartCardSkeleton />
            ) : failed.telemetry ? (
              <WidgetError
                message="Die Live-Daten konnten nicht geladen werden."
                onRetry={retry}
              />
            ) : telemetry.length === 0 ? (
              <p className="vp-muted">
                Für den gewählten Zeitraum liegen noch keine Messwerte vor. Sobald Ihr Gerät
                sendet, erscheinen die Live-Daten hier.
              </p>
            ) : (
              <>
                {/* Status-first hero: German status sentence + verdict tiles +
                    energy-flow diagram (the edge dashboard's mental model). */}
                <LiveHero points={telemetry} fresh={telemetryFresh} />

                {/* Verlauf: the history chart, secondary. Window toggle fetches
                    only the selected window; collapses behind a toggle on phones. */}
                <div className="vp-live-verlauf-head" style={{ marginTop: 'var(--vp-space-5)' }}>
                  <h3>Verlauf</h3>
                  <span style={{ display: 'flex', gap: 'var(--vp-space-2)', alignItems: 'center' }}>
                    {isPhone && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setChartOpen((o) => !o)}
                        aria-expanded={chartOpen}
                      >
                        {chartOpen ? 'Ausblenden' : 'Anzeigen'}
                      </Button>
                    )}
                    <div className="vp-seg" role="tablist" aria-label="Zeitraum">
                      {LIVE_WINDOWS.map((w) => (
                        <button
                          key={w.id}
                          role="tab"
                          aria-selected={liveWindow === w.id}
                          className={liveWindow === w.id ? 'active' : ''}
                          onClick={() => setLiveWindow(w.id)}
                        >
                          {w.label}
                        </button>
                      ))}
                    </div>
                  </span>
                </div>
                {(!isPhone || chartOpen) && (
                  <>
                    <ChartSubtitle>
                      Der Verlauf zeigt die Messwerte Ihrer Geräte {activeWindow.insight}.
                    </ChartSubtitle>
                    <TelemetryChart points={telemetry} windowLabel={activeWindow.insight} />
                  </>
                )}
              </>
            )}
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--vp-gap)', minWidth: 0 }}>
            <Card style={{ minWidth: 0 }}>
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="dynamic" size={40}>
                  <Icon name="euro" size={20} />
                </IconTile>
                <h2 style={{ fontSize: '1.1rem' }}>Börsen-Strompreise</h2>
                <span className="actions">
                  {prices && <Badge variant="tint">{zoneLabel(prices.biddingZone)}</Badge>}
                </span>
              </div>
              {loading && !prices && !failed.prices ? (
                <Skeleton height={140} radius="var(--vp-radius-md)" />
              ) : failed.prices ? (
                <WidgetError
                  message="Die Börsenpreise konnten nicht geladen werden."
                  onRetry={retry}
                />
              ) : prices && prices.points.length > 0 ? (
                <>
                  <PriceChart series={prices} />
                  <p className="vp-note" style={{ marginTop: 'var(--vp-space-2)' }}>
                    <a href="#/marktpreise" onClick={(e) => { e.preventDefault(); onNavigate('marktpreise'); }}>
                      Alle Marktpreise →
                    </a>
                  </p>
                </>
              ) : (
                <p className="vp-muted">
                  Noch keine Börsenpreise. Sie werden automatisch geladen, sobald die
                  Strombörse sie veröffentlicht.
                </p>
              )}
            </Card>

            <Card style={{ minWidth: 0 }}>
              <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
                <IconTile category="solar" size={40}>
                  <Icon name="sun" size={20} />
                </IconTile>
                <h2 style={{ fontSize: '1.1rem' }}>Wetter</h2>
                <span className="actions">
                  <span className="vp-note">nächste Stunde</span>
                </span>
              </div>
              {loading && !weather && !failed.weather ? (
                <TextSkeleton lines={2} />
              ) : failed.weather ? (
                <WidgetError
                  message="Die Wettervorhersage konnte nicht geladen werden."
                  onRetry={retry}
                />
              ) : weatherNow ? (
                <div style={{ display: 'flex', gap: 'var(--vp-space-5)', flexWrap: 'wrap' }}>
                  <Stat value={fmtNum(weatherNow.temperatureC, '°C')} label="Temperatur" />
                  <Stat value={fmtNum(weatherNow.cloudCoverPct, '%', 0)} label="Bewölkung" />
                  <Stat value={fmtNum(weatherNow.ghiWM2, 'W/m²', 0)} label="Einstrahlung" />
                </div>
              ) : (
                <p className="vp-muted">Noch keine Vorhersage für diesen Standort.</p>
              )}
              <p className="vp-note" style={{ marginTop: 'var(--vp-space-2)' }}>
                <a href="#/wetter" onClick={(e) => { e.preventDefault(); onNavigate('wetter'); }}>
                  Zur Wettervorhersage →
                </a>
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* Quick site list (first rung of the entity pattern). */}
      <section className="vp-section">
        <div className="vp-section-head">
          <IconTile category="home" size={40}>
            <Icon name="map-pin" size={20} />
          </IconTile>
          <h2>Ihre Standorte</h2>
          <Badge variant="tint">{sites.length}</Badge>
          <span className="actions">
            <Button variant="outline" size="sm" iconLeft={<Icon name="plus" size={16} />} onClick={() => setSiteDrawer(true)}>
              Standort anlegen
            </Button>
          </span>
        </div>
        <div className="vp-grid vp-grid-cards">
          {sites.map((s) => {
            const siteDevices = devices.filter((d) => d.siteId === s.id);
            const siteOnline = siteDevices.filter((d) => deviceLiveStatus(d) === 'online').length;
            return (
              <Card
                key={s.id}
                interactive
                accent="primary"
                className={`vp-selectable ${selectedSite === s.id ? 'vp-selected' : ''}`}
                style={{ minWidth: 0 }}
                onClick={() => onSelectSite(s.id)}
              >
                <h4 style={{ marginBottom: 'var(--vp-space-2)' }}>{s.name}</h4>
                <div style={{ display: 'flex', gap: 'var(--vp-space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge variant="tint">{zoneLabel(s.biddingZone)}</Badge>
                  {siteDevices.length > 0 ? (
                    <Badge variant={siteOnline > 0 ? 'ok' : 'off'} dot>
                      {siteOnline}/{siteDevices.length} online
                    </Badge>
                  ) : (
                    <span className="vp-note">keine Geräte</span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <CreateSiteDrawer
        open={siteDrawer}
        onClose={() => setSiteDrawer(false)}
        onCreate={(input) => api.createSite(input)}
        onCreated={(s) => onReload(s.id)}
      />
      <AddDeviceDrawer
        open={deviceDrawer}
        onClose={() => setDeviceDrawer(false)}
        sites={sites}
        onClaimed={() => onReload()}
      />
    </>
  );
}
