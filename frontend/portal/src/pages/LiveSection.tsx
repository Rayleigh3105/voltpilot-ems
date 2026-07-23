import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import {
  api,
  ONLINE_WINDOW_MS,
  type EntityHistory,
  type Site,
  type SiteSource,
  type TelemetryPoint,
} from '../api';
import { fmtRelative } from '../format';
import { ChartSubtitle } from '../components/ChartExplain';
import { ChartCardSkeleton, ErrorState } from '../components/States';
import { AdaptiveLiveView } from '../components/AdaptiveLiveView';
import { LiveHero } from '../components/LiveHero';
import {
  componentRows,
  entitySparks,
  v1FallbackRows,
  v1Sparks,
  type LivePulsRow,
} from '../livePuls';
import { TelemetryChart } from '../TelemetryChart';
import { useAdaptiveLive } from '../useAdaptiveLive';
import { verlaufHash } from '../verlauf';

/**
 * The "Live-Daten" subpage of one Anlage (V3): the status sentence + freshness
 * chip, the energy-flow diagram, the NEW Komponenten-Board (one row per
 * component with a 60-minute sparkline + a „Verlauf →" jump into the explorer),
 * and the compact, channel-toggleable Verlauf chart with its 1 Std/3 Std/Heute
 * window toggle.
 */

/** Background refresh cadence of the live data (30 s poll pattern). */
const POLL_MS = 30_000;
/** Re-render cadence of the "Stand vor X" freshness chip. */
const TICK_MS = 5_000;
/** Sparkline refresh cadence (one entityHistory per entity). */
const SPARK_MS = 60_000;

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

export function LiveSection({ site }: { site: Site }) {
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [liveWindow, setLiveWindow] = useState<LiveWindow>('3h');
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => new Date());
  // Channels the customer has toggled off on the compact chart (V3 Q3).
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // The site's measurement points (primary inverter + configured sources), so
  // the hero can explain a multi-inverter site's composite PV. Fail-soft: an
  // older backend / a device that never reported simply yields no breakdown.
  const [sources, setSources] = useState<SiteSource[] | null>(null);

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

  useEffect(() => {
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
  }, [site.id, reloadKey, liveWindow]);

  // Live means live: silent 30 s background poll (keeps the last good values on
  // a failure) + a 5 s clock tick so the freshness chip counts honestly. One
  // stable interval reads the latest site + window via a ref.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
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

  // AE1/AE7 adaptive live view (migrated sites); un-migrated sites fall back to
  // the byte-identical v1 LiveHero below.
  const { topology, profile, adaptive } = useAdaptiveLive(site.id);

  const latest = telemetry.length ? telemetry[telemetry.length - 1] : null;
  const telemetryFresh =
    latest != null && now.getTime() - new Date(latest.ts).getTime() <= ONLINE_WINDOW_MS;
  const activeWindow = LIVE_WINDOWS.find((w) => w.id === liveWindow) ?? LIVE_WINDOWS[1];

  // The Komponenten-Board rows: one per component (migrated) or the site-level
  // fallback (v1). Both are pure derivations (livePuls.ts).
  const rows: LivePulsRow[] = useMemo(
    () => (adaptive && topology ? componentRows(topology) : v1FallbackRows(telemetry)),
    [adaptive, topology, telemetry],
  );

  // Sparklines: one entityHistory('day') per component entity, refreshed at
  // 60 s, fail-soft (a missing history simply yields no sparkline). Only the
  // migrated branch fetches — the v1 sparks come from the loaded telemetry.
  const entityIds = useMemo(() => {
    const ids = new Set<string>();
    if (adaptive) for (const r of rows) if (r.target) ids.add(r.target.entityId);
    return Array.from(ids).sort();
  }, [adaptive, rows]);
  const [histories, setHistories] = useState<Map<string, EntityHistory>>(new Map());
  const idsKey = entityIds.join(',');

  const fetchHist = useRef<() => void>(() => {});
  fetchHist.current = () => {
    if (entityIds.length === 0) return;
    Promise.all(
      entityIds.map((id) =>
        api.entityHistory(site.id, id, 'day').then(
          (h) => [id, h] as const,
          () => null,
        ),
      ),
    ).then((results) => {
      const next = new Map<string, EntityHistory>();
      for (const r of results) if (r) next.set(r[0], r[1]);
      setHistories(next);
    });
  };
  useEffect(() => {
    setHistories(new Map());
    fetchHist.current();
    if (idsKey === '') return;
    const timer = setInterval(() => fetchHist.current(), SPARK_MS);
    return () => clearInterval(timer);
    // idsKey/site.id are the stable identity of the fetch set.
  }, [site.id, idsKey]);

  const sparks = useMemo(
    () =>
      adaptive
        ? entitySparks(rows, histories, now)
        : v1Sparks(rows, telemetry, now),
    [adaptive, rows, histories, telemetry, now],
  );

  const openVerlauf = (target: { entityId: string; channel: string }) => {
    window.location.hash = verlaufHash(site.id, target, 'day');
    // An Absprung is a navigation: the hash change does not scroll on its own.
    try {
      window.scrollTo({ top: 0 });
    } catch {
      /* jsdom stub - irrelevant in the browser */
    }
  };

  const toggleChannel = (label: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
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

      {adaptive && topology ? (
        // AE2/AE3 adaptive view (topology-driven): status sentence, the N-node
        // energy flow left + the Komponenten-Board right, then the compact chart.
        <>
          <AdaptiveLiveView
            topology={topology}
            profile={profile}
            siteFresh={telemetryFresh}
            rows={rows}
            sparks={sparks}
            onOpenVerlauf={openVerlauf}
          />
          {telemetry.length > 0 && (
            <VerlaufBlock
              telemetry={telemetry}
              liveWindow={liveWindow}
              setLiveWindow={setLiveWindow}
              activeWindow={activeWindow}
              hidden={hidden}
              onToggle={toggleChannel}
            />
          )}
        </>
      ) : loading && telemetry.length === 0 && !failed ? (
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
          {/* Status-first v1 view: status sentence + energy flow + the
              Komponenten-Board (site-level fallback rows). */}
          <LiveHero
            points={telemetry}
            fresh={telemetryFresh}
            sources={sources}
            rows={rows}
            sparks={sparks}
            onOpenVerlauf={openVerlauf}
          />

          <VerlaufBlock
            telemetry={telemetry}
            liveWindow={liveWindow}
            setLiveWindow={setLiveWindow}
            activeWindow={activeWindow}
            hidden={hidden}
            onToggle={toggleChannel}
          />
        </>
      )}
    </Card>
  );
}

/** The compact, channel-toggleable Verlauf chart + window toggle (V3 Q3). */
function VerlaufBlock({
  telemetry,
  liveWindow,
  setLiveWindow,
  activeWindow,
  hidden,
  onToggle,
}: {
  telemetry: TelemetryPoint[];
  liveWindow: LiveWindow;
  setLiveWindow: (w: LiveWindow) => void;
  activeWindow: { id: LiveWindow; label: string; insight: string };
  hidden: Set<string>;
  onToggle: (label: string) => void;
}) {
  return (
    <>
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
        Der Verlauf zeigt die Messwerte Ihrer Geräte {activeWindow.insight}. Tippen Sie eine
        Kennzahl an, um sie ein- oder auszublenden.
      </ChartSubtitle>
      <TelemetryChart
        points={telemetry}
        windowLabel={activeWindow.insight}
        hidden={hidden}
        onToggle={onToggle}
        variant="compact"
      />
    </>
  );
}
