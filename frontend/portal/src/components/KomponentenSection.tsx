import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  api,
  type EarningsRange,
  type EntityHistory,
  type HistoryTotals,
  type Site,
  type SiteTopology,
  type TelemetryPoint,
} from '../api';
import { ChartSubtitle } from './ChartExplain';
import { ErrorState, Skeleton } from './States';
import { LivePuls } from './LivePuls';
import {
  componentRows,
  entitySparks,
  v1FallbackRows,
  v1Sparks,
  type LivePulsRow,
} from '../livePuls';
import {
  initialVerlaufOpen,
  LIVE_WINDOWS,
  VERLAUF_OPEN_KEY,
  windowStart,
  withDayTotals,
  type LiveWindow,
} from '../liveDetail';
import { TelemetryChart } from '../TelemetryChart';
import { verlaufHash } from '../verlauf';
import { verlaufRangeForCockpit } from '../verlaufTarget';
import './KomponentenSection.css';

/**
 * Cockpit + Live-Daten merge (Option A): the merged home's THIRD stratum —
 * **Komponenten im Detail**. Hosts the V3 Komponenten-Board (one row per
 * component: health dot, state word, 60-min sparkline, „Verlauf →" jump) and
 * the compact, channel-toggleable Verlauf chart behind a „Verlauf ▾"
 * disclosure (owner Q2: board visible, chart collapsed, remembered per
 * session). All derivation is the untouched `livePuls.ts` + the pure
 * `liveDetail.ts`; this component fetches and renders.
 *
 * **Lazy by design (the landing-page-weight answer):** the telemetry-window
 * fetch, its 30 s poll and the per-entity sparkline fetches arm only once the
 * section scrolls near the viewport (IntersectionObserver, jsdom-guarded) or
 * the disclosure opens — the cockpit's above-the-fold load stays exactly what
 * it was before the merge.
 *
 * A board-row jump carries the Bilanz period into the explorer
 * (`verlaufRangeForCockpit`: Heute→Tag, Monat→Monat, Jahr/Gesamt→Jahr) —
 * consistent with how the cockpit tiles jumped before the merge.
 */

/** Background refresh cadence of the live data (30 s poll pattern). */
const POLL_MS = 30_000;
/** Re-render cadence for the sparkline "now" anchor. */
const TICK_MS = 5_000;
/** Sparkline refresh cadence (one entityHistory per entity). */
const SPARK_MS = 60_000;

export function KomponentenSection({
  site,
  topology,
  adaptive,
  stale = false,
  range,
  at = null,
  dayTotals = null,
}: {
  site: Site;
  /** The AE1 topology read-model; null = un-migrated site (v1 fallback rows). */
  topology: SiteTopology | null;
  /** true = the board derives per-component rows from the topology. */
  adaptive: boolean;
  /** R4: stale dims the board together with the hero (values keep last-good). */
  stale?: boolean;
  /** The Bilanz period tab — carried into every „Verlauf →" jump. */
  range: EarningsRange;
  /** The tapped month instance (YYYY-MM-01) — carried into the jump too. */
  at?: string | null;
  /** Today's Historie totals for the optional kWh sub-lines (R2). */
  dayTotals?: HistoryTotals | null;
}) {
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [liveWindow, setLiveWindow] = useState<LiveWindow>('3h');
  const [now, setNow] = useState(() => new Date());
  // Channels the customer has toggled off on the compact chart.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  // Q2: the Verlauf chart sits behind a disclosure, remembered per session.
  const [open, setOpen] = useState(() => {
    try {
      return initialVerlaufOpen(sessionStorage.getItem(VERLAUF_OPEN_KEY));
    } catch {
      return false;
    }
  });

  // Lazy-mount gate: fetches start when the section nears the viewport or the
  // disclosure is open. Environments without IntersectionObserver (jsdom) arm
  // immediately (the useScrollSpy guard precedent).
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [armed, setArmed] = useState(open);
  useEffect(() => {
    if (armed) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setArmed(true);
      return undefined;
    }
    const el = hostRef.current;
    if (!el) {
      setArmed(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setArmed(true);
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [armed]);

  // The telemetry window (board v1 fallback + the compact chart).
  useEffect(() => {
    if (!armed) return undefined;
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
  }, [site.id, armed, liveWindow, reloadKey]);

  // Live means live: silent 30 s background poll (keeps the last good values
  // on a failure) + a 5 s clock tick anchoring the sparklines. One stable
  // interval reads the latest site + window via a ref; armed gates it.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    const to = new Date();
    api.telemetry(site.id, windowStart(liveWindow, to).toISOString(), to.toISOString()).then(
      (t) => setTelemetry(t),
      () => {},
    );
  };
  useEffect(() => {
    if (!armed) return undefined;
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(new Date());
      if (++ticks % Math.round(POLL_MS / TICK_MS) === 0) pollRef.current();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [armed]);

  // The board rows: one per component (migrated) or the site-level fallback
  // (v1) — both pure derivations (livePuls.ts), plus the optional kWh
  // sub-lines the retired flow tiles used to carry (liveDetail.ts).
  const rows: LivePulsRow[] = useMemo(
    () =>
      withDayTotals(
        adaptive && topology ? componentRows(topology) : v1FallbackRows(telemetry),
        dayTotals,
      ),
    [adaptive, topology, telemetry, dayTotals],
  );

  // Sparklines: one entityHistory('day') per component entity, refreshed at
  // 60 s, fail-soft. Only the migrated branch fetches — the v1 sparks come
  // from the loaded telemetry window. Armed gates the fetches.
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
    if (!armed) return undefined;
    setHistories(new Map());
    fetchHist.current();
    if (idsKey === '') return undefined;
    const timer = setInterval(() => fetchHist.current(), SPARK_MS);
    return () => clearInterval(timer);
    // idsKey/site.id are the stable identity of the fetch set.
  }, [site.id, idsKey, armed]);

  const sparks = useMemo(
    () => (adaptive ? entitySparks(rows, histories, now) : v1Sparks(rows, telemetry, now)),
    [adaptive, rows, histories, telemetry, now],
  );

  // A board-row jump navigates into the Verlauf-Explorer, carrying the Bilanz
  // period (the hash carries `?m&z&at`, so it is set directly).
  const openVerlauf = (target: { entityId: string; channel: string }) => {
    window.location.hash = verlaufHash(site.id, target, verlaufRangeForCockpit(range), at);
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

  const toggleVerlauf = () =>
    setOpen((o) => {
      const next = !o;
      try {
        sessionStorage.setItem(VERLAUF_OPEN_KEY, next ? '1' : '0');
      } catch {
        /* private mode - the default simply applies next time */
      }
      if (next) setArmed(true);
      return next;
    });

  const activeWindow = LIVE_WINDOWS.find((w) => w.id === liveWindow) ?? LIVE_WINDOWS[1];
  const hasBoard = adaptive && topology != null;
  const showEmpty = !hasBoard && !loading && !failed && telemetry.length === 0;

  return (
    <Card padding="lg" radius="lg" className="vp-komponenten" style={{ minWidth: 0 }}>
      <div ref={hostRef} className={stale ? 'vp-stale' : undefined}>
        {failed && !hasBoard ? (
          <ErrorState
            message="Die Live-Daten konnten nicht geladen werden."
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : showEmpty ? (
          <p className="vp-muted">
            Es liegen noch keine Messwerte vor. Sobald Ihr Gerät sendet, erscheinen Ihre
            Komponenten hier.
          </p>
        ) : !hasBoard && loading && telemetry.length === 0 ? (
          <Skeleton height={180} radius="var(--vp-radius-md)" />
        ) : (
          <LivePuls rows={rows} sparks={sparks} onOpenVerlauf={openVerlauf} />
        )}
      </div>

      {/* Q2 · the compact Verlauf chart behind the disclosure. The window seg
          stays GLUED to the chart (R3: two time controls, two meanings). */}
      {!showEmpty && !failed && (
        <div className="vp-verlauf-fold">
          <div className="vp-live-verlauf-head">
            <button
              type="button"
              className={`vp-verlauf-toggle${open ? ' is-open' : ''}`}
              aria-expanded={open}
              onClick={toggleVerlauf}
            >
              <Icon name="chevron-down" size={18} />
              Verlauf
            </button>
            {open && telemetry.length > 0 && (
              <div className="vp-seg" role="tablist" aria-label="Zeitfenster">
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
            )}
          </div>
          {open &&
            (telemetry.length > 0 ? (
              <>
                <ChartSubtitle>
                  Der Verlauf zeigt die Messwerte Ihrer Geräte {activeWindow.insight}. Tippen
                  Sie eine Kennzahl an, um sie ein- oder auszublenden.
                </ChartSubtitle>
                <TelemetryChart
                  points={telemetry}
                  windowLabel={activeWindow.insight}
                  hidden={hidden}
                  onToggle={toggleChannel}
                  variant="compact"
                />
              </>
            ) : loading ? (
              <Skeleton height={160} radius="var(--vp-radius-md)" />
            ) : (
              <p className="vp-muted">
                Für das gewählte Zeitfenster liegen noch keine Messwerte vor.
              </p>
            ))}
        </div>
      )}
    </Card>
  );
}
