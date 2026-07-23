import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import {
  api,
  ApiError,
  type EntityHistory,
  type History,
  type HistoryRange,
  type Site,
} from '../api';
import { fmtNum } from '../format';
import { isoDate } from '../periodNav';
import {
  findItem,
  firstTarget,
  measurementTree,
  parseVerlaufParams,
  seriesFromEntityHistory,
  v1FallbackTree,
  v1SeriesFromHistory,
  verlaufHash,
  verlaufStats,
  type VerlaufGroup,
  type VerlaufItem,
  type VerlaufSeries,
  type VerlaufTarget,
} from '../verlauf';
import { ChartCardSkeleton, EmptyState, ErrorState } from './States';
import { ChartSubtitle } from './ChartExplain';
import { VerlaufChart } from './VerlaufChart';

import './Verlauf.css';

/**
 * The Verlauf-Explorer — Historie · „Messwerte" (design report §4 V1). A
 * customer browses EVERY measurement their plant stores (a Komponente's channel,
 * or a v1 site-level channel) and sees it over Tag/Woche/Monat/Jahr. Thin +
 * render-only: every decision lives in the pure `verlauf.ts`. Honesty rules:
 * an absent value is never a fabricated 0, an empty range shows an honest
 * sentence, and a raw channel name never reaches the copy (only `channelLabel`).
 */

/** The empty state when a site has genuinely nothing measurable yet. */
function NoMeasurements() {
  return (
    <Card padding="lg" radius="lg">
      <EmptyState
        icon="activity"
        category="dynamic"
        title="Noch keine Messwerte"
        description="Sobald Ihre Anlage misst, können Sie hier jeden Messwert jeder Komponente über die Zeit verfolgen - PV-Leistung, Ladestand, Netzleistung und mehr."
      />
    </Card>
  );
}

/** One rail row (a measurement), reused by the desktop rail + the phone sheet. */
function ItemRow({
  item,
  selected,
  onSelect,
}: {
  item: VerlaufItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`vp-verlauf-item${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      title={item.raw}
    >
      <span className="vp-vi-label">{item.label}</span>
      {item.unit && <span className="vp-vi-unit">{item.unit}</span>}
    </button>
  );
}

const HEALTH_DOT: Record<string, { cls: string; title: string }> = {
  ok: { cls: 'vp-health-ok', title: 'Liefert Daten' },
  stale: { cls: 'vp-health-warn', title: 'Meldet gerade keine Daten' },
  never: { cls: 'vp-health-off', title: 'Noch keine Daten' },
};

/** The grouped list of measurements (desktop rail body + phone sheet body). */
function GroupList({
  groups,
  target,
  onSelect,
}: {
  groups: VerlaufGroup[];
  target: VerlaufTarget | null;
  onSelect: (t: VerlaufTarget) => void;
}) {
  return (
    <div className="vp-verlauf-groups" role="listbox" aria-label="Messwerte">
      {groups.map((g) => {
        const dot = HEALTH_DOT[g.health] ?? HEALTH_DOT.ok;
        return (
          <div key={`${g.entityId}:${g.items[0]?.channel ?? g.label}`} className="vp-verlauf-group">
            <div className="vp-vg-head">
              <span className={`vp-health-dot ${dot.cls}`} title={dot.title} aria-hidden="true" />
              <Icon name={g.icon as IconName} size={16} />
              <span className="vp-vg-name">{g.label}</span>
            </div>
            {g.deviceLine && <p className="vp-vg-device">{g.deviceLine}</p>}
            {g.items.map((it) => (
              <ItemRow
                key={`${it.entityId}:${it.channel}`}
                item={it}
                selected={target?.entityId === it.entityId && target?.channel === it.channel}
                onSelect={() => onSelect({ entityId: it.entityId, channel: it.channel })}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Filter groups by a search term across group + measurement labels. */
function filterGroups(groups: VerlaufGroup[], q: string): VerlaufGroup[] {
  const term = q.trim().toLowerCase();
  if (!term) return groups;
  return groups
    .map((g) => {
      if (g.label.toLowerCase().includes(term)) return g;
      const items = g.items.filter((it) => it.label.toLowerCase().includes(term));
      return items.length ? { ...g, items } : null;
    })
    .filter((g): g is VerlaufGroup => g != null);
}

export function VerlaufExplorer({
  site,
  range,
  anchor,
  initialTarget,
}: {
  site: Site;
  range: HistoryRange;
  anchor: Date;
  /** Seeded once from the deep-link `m` param, else null. */
  initialTarget: VerlaufTarget | null;
}) {
  // The tree: entities+topology → measurementTree; else the v1 site-level tree.
  const [groups, setGroups] = useState<VerlaufGroup[] | null>(null);
  const [isV1, setIsV1] = useState(false);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [target, setTarget] = useState<VerlaufTarget | null>(initialTarget);
  const [search, setSearch] = useState('');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setGroups(null);
    setTreeErr(null);
    Promise.all([api.siteEntities(site.id), api.topology(site.id).catch(() => null)])
      .then(([entities, topology]) => {
        if (!active) return;
        const tree = topology ? measurementTree(entities, topology) : [];
        if (tree.length > 0) {
          setGroups(tree);
          setIsV1(false);
        } else {
          setGroups(v1FallbackTree());
          setIsV1(true);
        }
      })
      .catch(() => {
        // No v2 entity surface (older backend / fresh site): the v1 tree still
        // lets the customer browse the site-level measurements.
        if (!active) return;
        setGroups(v1FallbackTree());
        setIsV1(true);
      });
    return () => {
      active = false;
    };
  }, [site.id, reloadKey]);

  // Resolve/seed the selected measurement once the tree is known.
  useEffect(() => {
    if (!groups) return;
    setTarget((prev) => {
      if (prev && findItem(groups, prev)) return prev;
      return firstTarget(groups);
    });
  }, [groups]);

  // Keep the URL reflecting (measurement, range, anchor) - shareable/bookmarkable
  // via replaceState (no history spam, no reload).
  const at = isoDate(anchor);
  useEffect(() => {
    if (!target) return;
    window.history.replaceState(null, '', verlaufHash(site.id, target, range, at));
  }, [site.id, target, range, at]);

  // A V2 cockpit jump changes the hash while this section stays mounted; re-read
  // the target so the explorer follows the deep link.
  useEffect(() => {
    const onHash = () => {
      const params = parseVerlaufParams(window.location.hash);
      if (params.target && groups && findItem(groups, params.target)) setTarget(params.target);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [groups]);

  // Fetch the history for the selected entity/range/anchor (entity mode) or the
  // site history (v1 mode). Switching channel within one entity reuses the fetch.
  const entityId = target?.entityId ?? null;
  const [entHist, setEntHist] = useState<EntityHistory | null>(null);
  const [siteHist, setSiteHist] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataErr, setDataErr] = useState<string | null>(null);

  useEffect(() => {
    if (!groups || !entityId) return;
    let active = true;
    setLoading(true);
    setDataErr(null);
    const p = isV1
      ? api.history(site.id, range, at).then((h) => active && (setSiteHist(h), setEntHist(null)))
      : api
          .entityHistory(site.id, entityId, range, at)
          .then((h) => active && (setEntHist(h), setSiteHist(null)));
    p.catch((e) => active && setDataErr(e instanceof ApiError ? e.message : 'Fehler')).finally(
      () => active && setLoading(false),
    );
    return () => {
      active = false;
    };
  }, [groups, isV1, site.id, entityId, range, at]);

  const selected = groups && target ? findItem(groups, target) : null;

  const series: VerlaufSeries | null = useMemo(() => {
    if (!selected) return null;
    if (isV1) return siteHist ? v1SeriesFromHistory(siteHist, selected.channel) : null;
    return entHist ? seriesFromEntityHistory(entHist, selected.channel) : null;
  }, [selected, isV1, siteHist, entHist]);

  const stats = series ? verlaufStats(series) : null;

  const shown = groups ? filterGroups(groups, search) : [];

  const select = (t: VerlaufTarget) => {
    setTarget(t);
    setSheetOpen(false);
  };

  if (treeErr) {
    return (
      <ErrorState message={treeErr} onRetry={() => setReloadKey((k) => k + 1)} />
    );
  }
  if (groups && groups.length === 0) return <NoMeasurements />;

  const railBody = (
    <>
      <div className="vp-verlauf-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Messwert suchen"
          aria-label="Messwert suchen"
        />
      </div>
      {shown.length === 0 ? (
        <p className="vp-muted vp-verlauf-noresult">Kein Messwert gefunden.</p>
      ) : (
        <GroupList groups={shown} target={target} onSelect={select} />
      )}
    </>
  );

  return (
    <div className="vp-verlauf">
      <aside className="vp-verlauf-rail" aria-label="Messwerte">
        {railBody}
      </aside>

      <div className="vp-verlauf-main">
        {/* Phone: a summary button opening the "Messwert wählen" bottom sheet. */}
        <button
          type="button"
          className="vp-verlauf-pick"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
        >
          <span className="vp-vp-label">
            {selected ? selected.label : 'Messwert wählen'}
            {selected?.unit ? <span className="vp-vp-unit">{selected.unit}</span> : null}
          </span>
          <Icon name="chevron-down" size={18} />
        </button>

        <Card padding="lg" radius="lg">
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
            <IconTile category="dynamic" size={40}>
              <Icon name={(selected?.role ? ROLE_ICON[selected.role] : 'activity') as IconName} size={20} />
            </IconTile>
            <h2>{selected ? selected.label : 'Messwert'}</h2>
            {selected?.unit && <Badge variant="tint">{selected.unit}</Badge>}
          </div>
          <ChartSubtitle>
            Der zeitliche Verlauf dieses Messwerts.{' '}
            {range === 'day'
              ? 'Der Tagesverlauf in feiner Auflösung.'
              : 'Als Mittelwert je Abschnitt' +
                (!isV1 ? ' mit dem gemessenen Schwankungsband (min - max).' : '.')}
          </ChartSubtitle>

          {loading && <ChartCardSkeleton />}
          {dataErr && !loading && (
            <ErrorState
              message={`Der Verlauf konnte nicht geladen werden (${dataErr}).`}
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          )}
          {!loading && !dataErr && series && series.empty && (
            <EmptyState
              icon="activity"
              category="dynamic"
              title="Keine Werte in diesem Zeitraum"
              description="Für diesen Messwert liegen im gewählten Zeitraum keine Daten vor. Wählen Sie einen anderen Zeitraum oder Messwert."
            />
          )}
          {!loading && !dataErr && series && !series.empty && selected && (
            <>
              <VerlaufChart series={series} range={range} role={selected.role} channel={selected.channel} label={selected.label} />
              {stats && (
                <div className="vp-verlauf-stats" aria-label="Kennzahlen im Zeitraum">
                  <StatCell
                    label="Minimum"
                    value={fmtNum(stats.min?.value, series.unit)}
                    note={stats.min ? atTime(stats.min.t, range) : null}
                  />
                  <StatCell
                    label="Maximum"
                    value={fmtNum(stats.max?.value, series.unit)}
                    note={stats.max ? atTime(stats.max.t, range) : null}
                  />
                  <StatCell label="Durchschnitt" value={fmtNum(stats.avg, series.unit)} note={null} />
                  <StatCell label="Letzter Wert" value={fmtNum(stats.last, series.unit)} note={null} />
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {sheetOpen && (
        <div className="vp-verlauf-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div
            className="vp-verlauf-sheet"
            role="dialog"
            aria-label="Messwert wählen"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vp-vs-head">
              <h3>Messwert wählen</h3>
              <button type="button" className="vp-vs-close" aria-label="Schließen" onClick={() => setSheetOpen(false)}>
                <Icon name="x" size={20} />
              </button>
            </div>
            {railBody}
          </div>
        </div>
      )}
    </div>
  );
}

const ROLE_ICON: Record<string, IconName> = {
  pv: 'sun',
  storage: 'battery',
  grid: 'activity',
  house: 'home',
  consumer: 'zap',
};

/** A short German time/date note for a stat's extreme. */
function atTime(iso: string, range: HistoryRange): string {
  const d = new Date(iso);
  if (range === 'day') {
    return 'um ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
  }
  if (range === 'week') {
    return 'am ' + d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  }
  return 'am ' + d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function StatCell({ label, value, note }: { label: string; value: string; note: string | null }) {
  return (
    <div className="vp-verlauf-stat">
      <span className="vp-vs-label">{label}</span>
      <span className="vp-vs-value">{value}</span>
      {note && <span className="vp-vs-note">{note}</span>}
    </div>
  );
}
