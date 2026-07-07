import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import { api, ONLINE_WINDOW_MS, type Site, type TelemetryPoint } from '../api';
import { fmtRelative } from '../format';
import { SitePicker } from '../components/SitePicker';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, ErrorState } from '../components/States';
import { LiveHero } from '../components/LiveHero';
import { TelemetryChart } from '../TelemetryChart';

/**
 * The "Live-Daten" page: the live DEPTH of one site - status sentence, verdict
 * tiles, energy-flow diagram and the Verlauf chart with its window toggle.
 * This owns everything the simplified Übersicht links to ("Live-Daten im
 * Detail"); the Übersicht itself keeps only the one status sentence and the
 * energy-flow centerpiece.
 */

/** Background refresh cadence of the live data (GeraetePage pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness chip. */
const TICK_MS = 5_000;

/** Verlauf window toggle: fetch only the selected window (the API downsamples
 *  windows > 3h server-side to keep them complete AND current). */
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

export function LiveDatenPage({
  sites,
  selectedSite,
  onSelectSite,
}: {
  sites: Site[];
  selectedSite: string | null;
  onSelectSite: (id: string) => void;
}) {
  const site = sites.find((s) => s.id === selectedSite) ?? null;

  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [liveWindow, setLiveWindow] = useState<LiveWindow>('3h');
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!site) {
      setTelemetry([]);
      setFailed(false);
      return;
    }
    let active = true;
    setLoading(true);
    const to = new Date();
    api
      .telemetry(site.id, windowStart(liveWindow, to).toISOString(), to.toISOString())
      .then(
        (t) => {
          if (!active) return;
          setTelemetry(t);
          setFailed(false);
          setLoading(false);
        },
        () => {
          if (!active) return;
          setFailed(true);
          setLoading(false);
        },
      );
    return () => {
      active = false;
    };
  }, [site?.id, reloadKey, liveWindow]);

  // Live means live: silent 30 s background poll (keeps the last good values on
  // a failure) + a 5 s clock tick so the freshness chip counts honestly. One
  // stable interval reads the latest site + window via a ref.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    if (!site) return;
    const to = new Date();
    api.telemetry(site.id, windowStart(liveWindow, to).toISOString(), to.toISOString()).then(
      (t) => setTelemetry(t),
      () => {},
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

  const latest = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const telemetryFresh =
    latest != null && now.getTime() - new Date(latest.ts).getTime() <= ONLINE_WINDOW_MS;
  const activeWindow = LIVE_WINDOWS.find((w) => w.id === liveWindow) ?? LIVE_WINDOWS[1];

  return (
    <>
      <div className="vp-page-head">
        <div className="titles">
          <h1>Live-Daten</h1>
          <p>Was Ihre Anlage gerade macht: Status, Energiefluss und Messwert-Verlauf.</p>
        </div>
        <div className="actions">
          <SitePicker sites={sites} value={selectedSite} onChange={onSelectSite} />
        </div>
      </div>

      {sites.length === 0 ? (
        <Card padding="lg" radius="lg">
          <p className="vp-muted">
            Noch kein Standort - legen Sie zuerst unter „Standorte“ einen an.
          </p>
        </Card>
      ) : !site ? (
        <Card padding="lg" radius="lg">
          <ChartCardSkeleton />
        </Card>
      ) : (
        <Card padding="lg" radius="lg">
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
            <IconTile category="dynamic" size={40}>
              <Icon name="activity" size={20} />
            </IconTile>
            <h2>{site.name}</h2>
            {latest && (
              <Badge variant={telemetryFresh ? 'ok' : 'off'} dot>
                {telemetryFresh ? `Stand ${fmtRelative(latest.ts, now)}` : 'keine aktuellen Daten'}
              </Badge>
            )}
          </div>

          {loading && telemetry.length === 0 && !failed ? (
            <ChartCardSkeleton />
          ) : failed ? (
            <ErrorState
              message="Die Live-Daten konnten nicht geladen werden."
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          ) : telemetry.length === 0 ? (
            <p className="vp-muted">
              Für den gewählten Zeitraum liegen noch keine Messwerte vor. Sobald Ihr Gerät
              sendet, erscheinen die Live-Daten hier.
            </p>
          ) : (
            <>
              {/* Status-first: German status sentence + verdict tiles +
                  energy-flow diagram (the edge dashboard's mental model). */}
              <LiveHero points={telemetry} fresh={telemetryFresh} />

              {/* Verlauf: the history chart; the toggle fetches only the
                  selected window. */}
              <div className="vp-live-verlauf-head" style={{ marginTop: 'var(--vp-space-5)' }}>
                <h3>Verlauf</h3>
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
              </div>
              <ChartSubtitle>
                Der Verlauf zeigt die Messwerte Ihrer Geräte {activeWindow.insight}.
              </ChartSubtitle>
              <TelemetryChart points={telemetry} windowLabel={activeWindow.insight} />
            </>
          )}
        </Card>
      )}
    </>
  );
}
