/**
 * Verlauf-Explorer (Historie · „Messwerte") — the pure derivation behind the
 * V1 explorer (design `data/vp-portal-livedata-design/report.md` §4 V1).
 *
 * The explorer lets a customer browse EVERY measurement their plant stores over
 * a selectable range — not just the four cockpit tiles. This module is the pure,
 * unit-tested logic (the `komponenten.ts` / `live.ts` precedent): no React, no
 * network. It only DERIVES — the browser tree, the deep-link params, the chart
 * series + the stats strip — from data the shipped endpoints already return
 * (`siteEntities` + `topology` → the tree; `entityHistory` / `history` → the
 * series). There is no second measurement model: the tree reuses
 * `komponenten.plantModel` and every measurement name goes through
 * `channels.channelLabel`, so a customer never reads a raw channel identifier.
 *
 * Two rules are law here (the „—"-Disziplin): an absent value stays absent
 * (null), never a fabricated 0; and a range with no value renders an honest
 * empty state, never an invented chart.
 */
import type {
  EntityHistory,
  History,
  HistoryBucket,
  HistoryRange,
  SiteEntities,
  SiteEntity,
  SiteTopology,
} from './api';
import { channelLabel, channelUnitHint } from './channels';
import {
  type ComponentHealth,
  type ComponentRole,
  COMPONENT_ROLE_ICONS,
  COMPONENT_ROLE_LABELS,
  plantModel,
} from './komponenten';

/** The explorer's range = the shared Historie range vocabulary. */
export type VerlaufRange = HistoryRange;

/** One selectable measurement: an entity's channel (or a v1 site-level channel). */
export interface VerlaufTarget {
  entityId: string;
  channel: string;
}

/** One measurement row in the rail: everything the chart + label need. */
export interface VerlaufItem {
  entityId: string;
  channel: string;
  /** Plain-German measurement name (never a raw channel identifier). */
  label: string;
  /** Unit shown after values (kW · % · kWh …). */
  unit: string;
  /** Role → chart color + group icon. */
  role: ComponentRole;
  /** The raw channel name — kept only as a support/debug `title` tooltip. */
  raw: string;
}

/** One rail group = one Komponente, its Gerät sub-line and its Messwerte. */
export interface VerlaufGroup {
  entityId: string;
  /** Customer-facing component name. */
  label: string;
  role: ComponentRole;
  icon: string;
  /** "Wechselrichter · verbunden" style attribution, or null when unknown. */
  deviceLine: string | null;
  health: ComponentHealth;
  items: VerlaufItem[];
}

// --- Browser tree ------------------------------------------------------------

/** Unit for one channel: the entity's declared unit, else the channel hint. */
function itemUnit(entity: SiteEntity | undefined, channel: string): string {
  const declared = entity?.capabilities?.measure?.find((m) => m.channel === channel)?.unit;
  if (declared && declared.trim()) return declared.trim();
  return channelUnitHint(channel) ?? '';
}

/** The device sub-line for a component: its feeding devices' names + state. */
function deviceLineFor(
  componentId: string,
  model: ReturnType<typeof plantModel>,
): string | null {
  const feeders = model.devices.filter((d) => d.componentIds.includes(componentId));
  if (feeders.length === 0) return null;
  const names = Array.from(new Set(feeders.map((d) => d.label))).join(' · ');
  // H2: only a real `ok` reads „verbunden" - an unreported device says so.
  const health = feeders.some((d) => d.health === 'stale')
    ? 'meldet gerade keine Daten'
    : feeders.some((d) => d.health === 'never')
      ? 'noch keine Daten'
      : feeders.some((d) => d.health === 'unknown')
        ? 'noch keine Rückmeldung'
        : 'verbunden';
  return `${names} · ${health}`;
}

/**
 * The measurement tree for a migrated (v2) site: one group per Komponente with
 * its Gerät sub-line + health, each carrying its Messwerte with unit. Reuses
 * `plantModel` (no second role/device derivation). A component without a
 * measurable channel is dropped — there is nothing to chart.
 */
export function measurementTree(
  entities: SiteEntities,
  topology: SiteTopology | null,
): VerlaufGroup[] {
  const model = plantModel(entities.entities, topology, entities.localSetup);
  const entityById = new Map(entities.entities.map((e) => [e.id, e] as const));

  const groups: VerlaufGroup[] = [];
  for (const c of model.components) {
    if (c.channels.length === 0) continue;
    const entity = entityById.get(c.id);
    const items: VerlaufItem[] = c.channels.map((ch) => ({
      entityId: c.id,
      channel: ch.raw,
      label: ch.label,
      unit: itemUnit(entity, ch.raw),
      role: c.role,
      raw: ch.raw,
    }));
    groups.push({
      entityId: c.id,
      label: c.label,
      role: c.role,
      icon: COMPONENT_ROLE_ICONS[c.role],
      deviceLine: deviceLineFor(c.id, model),
      health: c.health,
      items,
    });
  }
  return groups;
}

// --- v1 fallback (entity-less site) ------------------------------------------

/**
 * A synthetic entityId for a v1 site-level measurement. It carries no colon so
 * it round-trips through the `m={entityId}:{channel}` deep-link cleanly.
 */
export const V1_ENTITY = 'anlage';

/** One v1 site-level measurement, drawn from the `History` buckets. */
interface V1ChannelDesc {
  /** Pseudo channel id used in the deep-link target. */
  channel: string;
  label: string;
  role: ComponentRole;
  /** true = a percentage (Ladestand), so it is not kW/kWh. */
  percent: boolean;
  /** Value from one History bucket (energy kWh, or % for soc). */
  from: (b: HistoryBucket) => number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The v1 site-level measurements — PV / Haus / Netz / Ladestand — each with a
 * full day..year story from the `History` buckets (`api.history`, the same
 * source the Bilanz tab reads). Netzgrenze is deliberately omitted: the History
 * buckets carry no per-bucket §14a value, so it would be a day-only stub.
 */
export const V1_CHANNELS: V1ChannelDesc[] = [
  { channel: 'pv', label: channelLabel('pv_power_kw'), role: 'pv', percent: false, from: (b) => num(b.pvKwh) },
  { channel: 'haus', label: channelLabel('load_kw'), role: 'house', percent: false, from: (b) => num(b.loadKwh) },
  {
    channel: 'netz',
    label: 'Netz (Bezug − Einspeisung)',
    role: 'grid',
    percent: false,
    from: (b) => {
      const imp = num(b.gridImportKwh);
      const exp = num(b.gridExportKwh);
      if (imp == null && exp == null) return null;
      return (imp ?? 0) - (exp ?? 0);
    },
  },
  { channel: 'soc', label: channelLabel('soc_pct'), role: 'storage', percent: true, from: (b) => num(b.socLastPct) },
];

/** The v1 site-level tree: one calm group per role (no device link). */
export function v1FallbackTree(): VerlaufGroup[] {
  return V1_CHANNELS.map((c) => ({
    entityId: V1_ENTITY,
    label: COMPONENT_ROLE_LABELS[c.role],
    role: c.role,
    icon: COMPONENT_ROLE_ICONS[c.role],
    deviceLine: null,
    health: 'ok' as ComponentHealth,
    items: [
      {
        entityId: V1_ENTITY,
        channel: c.channel,
        label: c.label,
        unit: c.percent ? '%' : 'kW',
        role: c.role,
        raw: c.channel,
      },
    ],
  }));
}

// --- Tree helpers ------------------------------------------------------------

/** Every measurement across all groups, in rail order. */
export function flattenItems(groups: VerlaufGroup[]): VerlaufItem[] {
  return groups.flatMap((g) => g.items);
}

/** Resolve a deep-link target to its item, else null. */
export function findItem(groups: VerlaufGroup[], target: VerlaufTarget | null): VerlaufItem | null {
  if (!target) return null;
  for (const g of groups) {
    for (const it of g.items) {
      if (it.entityId === target.entityId && it.channel === target.channel) return it;
    }
  }
  return null;
}

/** The landing measurement when none is selected: the first available. */
export function firstTarget(groups: VerlaufGroup[]): VerlaufTarget | null {
  const it = flattenItems(groups)[0];
  return it ? { entityId: it.entityId, channel: it.channel } : null;
}

// --- Deep-link params --------------------------------------------------------

const RANGE_WORDS: Record<VerlaufRange, string> = {
  day: 'tag',
  week: 'woche',
  month: 'monat',
  year: 'jahr',
};

const WORD_RANGES: Record<string, VerlaufRange> = {
  tag: 'day',
  woche: 'week',
  monat: 'month',
  jahr: 'year',
};

/** The German range word ↔ HistoryRange (unknown → 'day'). */
export function rangeWord(range: VerlaufRange): string {
  return RANGE_WORDS[range] ?? 'tag';
}
export function wordRange(word: string | null): VerlaufRange {
  return (word && WORD_RANGES[word]) || 'day';
}

/** The parsed explorer state carried in the hash query. */
export interface VerlaufParams {
  target: VerlaufTarget | null;
  range: VerlaufRange;
  /** Anchor date as YYYY-MM-DD, or null for "today". */
  at: string | null;
}

/** Extract the query part from a full hash or a bare query string. */
function queryOf(hashOrQuery: string): string {
  const q = hashOrQuery.indexOf('?');
  return q >= 0 ? hashOrQuery.slice(q + 1) : '';
}

/**
 * Parse `m={entityId}:{channel}`, `z={tag|woche|monat|jahr}`, `at={ISO}` from a
 * hash (or bare query). Unknown/absent params fall back to safe defaults —
 * `parseRoute` already strips `?…`, so the explorer parses this itself.
 */
export function parseVerlaufParams(hashOrQuery: string): VerlaufParams {
  const params = new URLSearchParams(queryOf(hashOrQuery));
  const m = params.get('m');
  let target: VerlaufTarget | null = null;
  if (m) {
    const idx = m.indexOf(':');
    if (idx > 0 && idx < m.length - 1) {
      target = { entityId: m.slice(0, idx), channel: m.slice(idx + 1) };
    }
  }
  const at = params.get('at');
  return {
    target,
    range: wordRange(params.get('z')),
    at: at && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : null,
  };
}

/**
 * Build the explorer deep-link. `hashForRoute` stays untouched (it drops the
 * query); this is the ONE builder for the `?m&z&at` link (reused by the V2
 * cockpit jump).
 */
export function verlaufHash(
  siteId: string,
  target: VerlaufTarget,
  range: VerlaufRange,
  at?: string | null,
): string {
  const parts = [`m=${target.entityId}:${target.channel}`, `z=${rangeWord(range)}`];
  if (at) parts.push(`at=${at}`);
  return `#/anlage/${siteId}/historie?${parts.join('&')}`;
}

// --- Chart series + stats ----------------------------------------------------

/** One point on the chart: aggregate + band bounds + sample count. */
export interface VerlaufPoint {
  /** Bucket start (ISO). */
  t: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  n: number;
}

/** A render-ready series (raw numbers; the chart formats + colors). */
export interface VerlaufSeries {
  points: VerlaufPoint[];
  unit: string;
  /** true → avg line + min/max band; false → plain line or bars. */
  hasBand: boolean;
  /** true → the day range (raw line), else an aggregated range. */
  isDay: boolean;
  /** true → draw bars (v1 energy over week+), else a line. */
  bars: boolean;
  bucketMinutes: number;
  /** No non-null value anywhere → the honest empty state. */
  empty: boolean;
}

/**
 * The series for one v2 entity channel. The entity rollups store the avg of the
 * channel value, so the unit is stable (kW / %) across ranges: day = raw line,
 * week/month/year = avg line + min/max band.
 */
export function seriesFromEntityHistory(history: EntityHistory, channel: string): VerlaufSeries {
  const buckets = history.channels[channel] ?? [];
  const isDay = history.range === 'day';
  const points: VerlaufPoint[] = buckets.map((b) => ({
    t: b.start,
    avg: num(b.avg),
    min: num(b.min),
    max: num(b.max),
    n: b.n,
  }));
  return {
    points,
    unit: channelUnitHint(channel) ?? '',
    hasBand: !isDay,
    isDay,
    bars: false,
    bucketMinutes: history.bucketMinutes,
    empty: !points.some((p) => p.avg != null),
  };
}

/**
 * The series for a v1 site-level measurement, drawn from the `History` buckets:
 * day = average power in kW (energy × 60 / bucketMinutes, a line), week/month/
 * year = energy in kWh (bars), Ladestand = percent (a line). Mirrors the
 * retired widgetHistory mapping (no new backend). No per-channel band exists
 * here, so `hasBand` is always false.
 */
export function v1SeriesFromHistory(history: History, channel: string): VerlaufSeries {
  const desc = V1_CHANNELS.find((c) => c.channel === channel);
  const isDay = history.range === 'day';
  if (!desc) {
    return { points: [], unit: '', hasBand: false, isDay, bars: false, bucketMinutes: history.bucketMinutes, empty: true };
  }
  const conv = (v: number | null): number | null => {
    if (v == null) return null;
    if (desc.percent) return v;
    // kWh per bucket → average kW over the bucket, on the day range only.
    return isDay ? (v * 60) / history.bucketMinutes : v;
  };
  const points: VerlaufPoint[] = history.buckets.map((b) => ({
    t: b.start,
    avg: conv(desc.from(b)),
    min: null,
    max: null,
    n: 1,
  }));
  return {
    points,
    unit: desc.percent ? '%' : isDay ? 'kW' : 'kWh',
    hasBand: false,
    isDay,
    bars: !isDay && !desc.percent,
    bucketMinutes: history.bucketMinutes,
    empty: !points.some((p) => p.avg != null),
  };
}

/** One extreme with its timestamp. */
export interface VerlaufExtreme {
  value: number;
  t: string;
}

/** The stats strip under the chart, computed client-side from the buckets. */
export interface VerlaufStats {
  /** Smallest observed value (band min when present, else the point value). */
  min: VerlaufExtreme | null;
  max: VerlaufExtreme | null;
  /** Sample-weighted mean of the bucket averages. */
  avg: number | null;
  /** Newest non-null value. */
  last: number | null;
}

/** Min/Max (with time), Ø, Letzter — from the loaded series. Pure. */
export function verlaufStats(series: VerlaufSeries): VerlaufStats {
  let min: VerlaufExtreme | null = null;
  let max: VerlaufExtreme | null = null;
  let sum = 0;
  let weight = 0;
  let last: number | null = null;

  for (const p of series.points) {
    const lo = p.min ?? p.avg;
    const hi = p.max ?? p.avg;
    if (lo != null && (min == null || lo < min.value)) min = { value: lo, t: p.t };
    if (hi != null && (max == null || hi > max.value)) max = { value: hi, t: p.t };
    if (p.avg != null) {
      const w = p.n > 0 ? p.n : 1;
      sum += p.avg * w;
      weight += w;
      last = p.avg;
    }
  }
  return { min, max, avg: weight > 0 ? sum / weight : null, last };
}
