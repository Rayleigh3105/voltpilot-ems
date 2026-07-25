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
  findItems,
  firstTarget,
  isSelected,
  MAX_SELECTED,
  measurementTree,
  parseVerlaufParams,
  selectionNote,
  seriesFromEntityHistory,
  toggleTarget,
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
import { VerlaufChart, seriesColor, type VerlaufSelection } from './VerlaufChart';

import './Verlauf.css';

/**
 * The Verlauf-Explorer — Historie · Energie → „Messwerte" (Struktur B1-c). The
 * owner's explicit ask: *„ein Measurement auswählen was aufgezeichnet wird und
 * dort alle Daten anschauen"* — plus **up to three at once** so measurements can
 * be compared. Thin + render-only: every decision lives in the pure `verlauf.ts`.
 *
 * Honesty rules: an absent value is never a fabricated 0, an empty range shows an
 * honest sentence, a raw channel name never reaches the copy (only
 * `channelLabel`), and a component whose values are read through the inverter
 * says so in the rail instead of being offered as an empty curve.
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
  disabled,
  color,
  onToggle,
}: {
  item: VerlaufItem;
  selected: boolean;
  /** The 3-measurement ceiling is reached and this one is not part of it. */
  disabled: boolean;
  color: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      className={`vp-verlauf-item${selected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
      onClick={onToggle}
      title={disabled ? `Höchstens ${MAX_SELECTED} Messwerte gleichzeitig` : item.raw}
    >
      <span className="vp-vi-check" aria-hidden="true" style={selected ? { background: color, borderColor: color } : undefined}>
        {selected ? <Icon name="check" size={12} /> : null}
      </span>
      <span className="vp-vi-label">{item.label}</span>
      {item.unit && <span className="vp-vi-unit">{item.unit}</span>}
    </button>
  );
}

const HEALTH_DOT: Record<string, { cls: string; title: string }> = {
  ok: { cls: 'vp-health-ok', title: 'Liefert Daten' },
  stale: { cls: 'vp-health-warn', title: 'Meldet gerade keine Daten' },
  never: { cls: 'vp-health-off', title: 'Noch keine Daten' },
  unknown: { cls: 'vp-health-off', title: 'Noch keine Rückmeldung' },
};

/** The grouped list of measurements (desktop rail body + phone sheet body). */
function GroupList({
  groups,
  targets,
  onToggle,
}: {
  groups: VerlaufGroup[];
  targets: VerlaufTarget[];
  onToggle: (t: VerlaufTarget) => void;
}) {
  const full = targets.length >= MAX_SELECTED;
  return (
    <div className="vp-verlauf-groups" role="listbox" aria-label="Messwerte" aria-multiselectable="true">
      {groups.map((g) => {
        const dot = HEALTH_DOT[g.health] ?? HEALTH_DOT.unknown;
        return (
          <div key={`${g.entityId}:${g.items[0]?.channel ?? g.label}`} className="vp-verlauf-group">
            <div className="vp-vg-head">
              <span className={`vp-health-dot ${dot.cls}`} title={dot.title} aria-hidden="true" />
              <Icon name={g.icon as IconName} size={16} />
              <span className="vp-vg-name" title={g.rawLabel}>
                {g.label}
              </span>
            </div>
            {/* F2a: the honest reason comes FIRST - a customer reads why this
                component has no own curve before clicking one. */}
            {g.measuredVia ? (
              <p className="vp-vg-device vp-vg-measuredvia">{g.measuredVia}</p>
            ) : (
              g.deviceLine && <p className="vp-vg-device">{g.deviceLine}</p>
            )}
            {g.items.map((it) => {
              const t = { entityId: it.entityId, channel: it.channel };
              const selected = isSelected(targets, t);
              return (
                <ItemRow
                  key={`${it.entityId}:${it.channel}`}
                  item={it}
                  selected={selected}
                  disabled={!selected && full}
                  color={seriesColor(it.channel, it.role)}
                  onToggle={() => onToggle(t)}
                />
              );
            })}
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

/** Prefix a measurement with its component when several components are shown. */
function selectionLabel(groups: VerlaufGroup[], item: VerlaufItem, ambiguous: boolean): string {
  if (!ambiguous) return item.label;
  const group = groups.find((g) => g.entityId === item.entityId);
  return group ? `${group.label} · ${item.label}` : item.label;
}

export function VerlaufExplorer({
  site,
  range,
  anchor,
  initialTargets,
}: {
  site: Site;
  range: HistoryRange;
  anchor: Date;
  /** Seeded once from the deep-link `m` params, else empty. */
  initialTargets: VerlaufTarget[];
}) {
  // The tree: entities+topology → measurementTree; else the v1 site-level tree.
  const [groups, setGroups] = useState<VerlaufGroup[] | null>(null);
  const [isV1, setIsV1] = useState(false);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [targets, setTargets] = useState<VerlaufTarget[]>(initialTargets);
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

  // Resolve/seed the selection once the tree is known: keep every deep-linked
  // measurement that exists, else land on the first measuring one.
  useEffect(() => {
    if (!groups) return;
    setTargets((prev) => {
      const kept = prev.filter((t) => findItem(groups, t) != null);
      if (kept.length > 0) return kept.length === prev.length ? prev : kept;
      const first = firstTarget(groups);
      return first ? [first] : [];
    });
  }, [groups]);

  // Keep the URL reflecting (measurements, range, anchor) - shareable/bookmarkable
  // via replaceState (no history spam, no reload).
  const at = isoDate(anchor);
  useEffect(() => {
    if (targets.length === 0) return;
    window.history.replaceState(null, '', verlaufHash(site.id, targets, range, at));
  }, [site.id, targets, range, at]);

  // A V2 cockpit jump changes the hash while this section stays mounted; re-read
  // the targets so the explorer follows the deep link.
  useEffect(() => {
    const onHash = () => {
      const params = parseVerlaufParams(window.location.hash);
      if (!groups || params.targets.length === 0) return;
      const known = params.targets.filter((t) => findItem(groups, t) != null);
      if (known.length > 0) setTargets(known);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [groups]);

  // Fetch the history of every SELECTED entity (v2), or the site history (v1).
  // Several channels of one entity share one response, so a comparison inside a
  // component costs no extra request.
  const entityIds = useMemo(() => {
    const seen: string[] = [];
    for (const t of targets) if (!seen.includes(t.entityId)) seen.push(t.entityId);
    return seen;
  }, [targets]);
  const entityKey = entityIds.join('|');

  const [entHist, setEntHist] = useState<Record<string, EntityHistory>>({});
  const [siteHist, setSiteHist] = useState<History | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataErr, setDataErr] = useState<string | null>(null);

  useEffect(() => {
    if (!groups || entityIds.length === 0) return;
    let active = true;
    setLoading(true);
    setDataErr(null);
    const p = isV1
      ? api.history(site.id, range, at).then((h) => {
          if (!active) return;
          setSiteHist(h);
          setEntHist({});
        })
      : Promise.all(
          entityIds.map((id) =>
            api.entityHistory(site.id, id, range, at).then((h) => [id, h] as const),
          ),
        ).then((pairs) => {
          if (!active) return;
          setEntHist(Object.fromEntries(pairs));
          setSiteHist(null);
        });
    p.catch((e) => active && setDataErr(e instanceof ApiError ? e.message : 'Fehler')).finally(
      () => active && setLoading(false),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, isV1, site.id, entityKey, range, at]);

  const items = useMemo(() => (groups ? findItems(groups, targets) : []), [groups, targets]);
  const ambiguous = useMemo(
    () => new Set(items.map((it) => it.entityId)).size > 1,
    [items],
  );

  const selections: VerlaufSelection[] | null = useMemo(() => {
    if (!groups || items.length === 0) return null;
    const out: VerlaufSelection[] = [];
    for (const it of items) {
      let series: VerlaufSeries | null = null;
      if (isV1) series = siteHist ? v1SeriesFromHistory(siteHist, it.channel) : null;
      else {
        const h = entHist[it.entityId];
        series = h ? seriesFromEntityHistory(h, it.channel) : null;
      }
      if (!series) return null; // still loading one of them
      out.push({
        key: `${it.entityId}:${it.channel}`,
        label: selectionLabel(groups, it, ambiguous),
        channel: it.channel,
        role: it.role,
        series,
      });
    }
    return out;
  }, [groups, items, ambiguous, isV1, siteHist, entHist]);

  const withData = selections?.filter((s) => !s.series.empty) ?? [];
  const empty = selections != null && withData.length === 0;
  const shown = groups ? filterGroups(groups, search) : [];

  const toggle = (t: VerlaufTarget) => setTargets((prev) => toggleTarget(prev, t));

  if (treeErr) {
    return <ErrorState message={treeErr} onRetry={() => setReloadKey((k) => k + 1)} />;
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
        <>
          <GroupList groups={shown} targets={targets} onToggle={toggle} />
          <p className="vp-verlauf-count">{selectionNote(targets.length)}</p>
        </>
      )}
    </>
  );

  // The head names the single selection, or how many are compared.
  const one = items.length === 1 ? items[0] : null;
  const headTitle = one ? one.label : `${items.length} Messwerte im Vergleich`;
  const headIcon: IconName = one ? (ROLE_ICON[one.role] ?? 'activity') : 'activity';
  const missing = selections?.filter((s) => s.series.empty) ?? [];

  return (
    <div className="vp-verlauf">
      <aside className="vp-verlauf-rail" aria-label="Messwerte">
        {railBody}
      </aside>

      <div className="vp-verlauf-main">
        {/* Phone: a summary button opening the "Messwerte wählen" bottom sheet. */}
        <button
          type="button"
          className="vp-verlauf-pick"
          onClick={() => setSheetOpen(true)}
          aria-haspopup="dialog"
        >
          <span className="vp-vp-label">
            {items.length === 0 ? 'Messwerte wählen' : headTitle}
            {one?.unit ? <span className="vp-vp-unit">{one.unit}</span> : null}
          </span>
          <Icon name="chevron-down" size={18} />
        </button>

        <Card padding="lg" radius="lg">
          <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-3)' }}>
            <IconTile category="dynamic" size={40}>
              <Icon name={headIcon} size={20} />
            </IconTile>
            <h2>{items.length === 0 ? 'Messwert' : headTitle}</h2>
            {one?.unit && <Badge variant="tint">{one.unit}</Badge>}
          </div>
          <ChartSubtitle>
            {items.length > 1
              ? `Bis zu ${MAX_SELECTED} Messwerte im direkten Vergleich; unterschiedliche Einheiten bekommen eine zweite Achse.`
              : 'Der zeitliche Verlauf dieses Messwerts. '}
            {items.length > 1
              ? ''
              : range === 'day'
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
          {!loading && !dataErr && empty && (
            one && one.producer ? (
              // F2a: a producer has no eigene Messreihe — seine PV wird über den
              // Wechselrichter erfasst und steckt in „PV gesamt".
              <EmptyState
                icon="sun"
                category="dynamic"
                title="Wird über den Wechselrichter gemessen"
                description="Diese Werte werden über den Wechselrichter gemessen und stecken in „PV gesamt“. Einen eigenen Verlauf hat dieser Erzeuger nicht — die Gesamt-PV finden Sie im Cockpit und in der Historie."
              />
            ) : (
              <EmptyState
                icon="activity"
                category="dynamic"
                title="Keine Werte in diesem Zeitraum"
                description="Für die gewählten Messwerte liegen im gewählten Zeitraum keine Daten vor. Wählen Sie einen anderen Zeitraum oder Messwert."
              />
            )
          )}
          {!loading && !dataErr && withData.length > 0 && (
            <>
              {/* A comparison partner without values is NAMED, not silently
                  dropped - otherwise a curve would just be missing. */}
              {missing.length > 0 && (
                <p className="vp-note vp-verlauf-missing">
                  {missing.map((s) => `${s.label}: keine Werte in diesem Zeitraum.`).join(' ')}
                </p>
              )}
              <div className="vp-chart-legend" aria-label="Legende">
                {withData.map((s) => (
                  <span key={s.key} className="vp-cl-item">
                    <span
                      className="vp-swatch vp-swatch-line"
                      style={{ '--sw': seriesColor(s.channel, s.role) } as React.CSSProperties}
                      aria-hidden="true"
                    />
                    <span className="vp-cl-label">{s.label}</span>
                    {s.series.unit && <span className="vp-cl-unit">{s.series.unit}</span>}
                  </span>
                ))}
              </div>
              <VerlaufChart selections={withData} range={range} />
              <div className="vp-verlauf-statblocks">
                {withData.map((s) => {
                  const stats = verlaufStats(s.series);
                  return (
                    <div key={s.key} className="vp-verlauf-statblock">
                      {withData.length > 1 && (
                        <p className="vp-verlauf-statname">
                          <span
                            className="vp-swatch vp-swatch-line"
                            style={{ '--sw': seriesColor(s.channel, s.role) } as React.CSSProperties}
                            aria-hidden="true"
                          />
                          {s.label}
                        </p>
                      )}
                      <div className="vp-verlauf-stats" aria-label={`Kennzahlen im Zeitraum: ${s.label}`}>
                        <StatCell
                          label="Minimum"
                          value={fmtNum(stats.min?.value, s.series.unit)}
                          note={stats.min ? atTime(stats.min.t, range) : null}
                        />
                        <StatCell
                          label="Maximum"
                          value={fmtNum(stats.max?.value, s.series.unit)}
                          note={stats.max ? atTime(stats.max.t, range) : null}
                        />
                        <StatCell
                          label="Durchschnitt"
                          value={fmtNum(stats.avg, s.series.unit)}
                          note={null}
                        />
                        <StatCell
                          label="Letzter Wert"
                          value={fmtNum(stats.last, s.series.unit)}
                          note={null}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </Card>
      </div>

      {sheetOpen && (
        <div className="vp-verlauf-sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div
            className="vp-verlauf-sheet"
            role="dialog"
            aria-label="Messwerte wählen"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="vp-vs-head">
              <h3>Messwerte wählen</h3>
              <button
                type="button"
                className="vp-vs-close"
                aria-label="Schließen"
                onClick={() => setSheetOpen(false)}
              >
                <Icon name="x" size={20} />
              </button>
            </div>
            {railBody}
            <button
              type="button"
              className="vp-btn vp-btn-primary vp-verlauf-sheet-done"
              onClick={() => setSheetOpen(false)}
            >
              Fertig
            </button>
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
