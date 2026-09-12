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
  MessstelleVerlauf,
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
  /**
   * F2a: this measurement belongs to a producer entity, which has no
   * telemetry_v2 of its own (its PV is measured through the hybrid inverter).
   * So an empty range is EXPECTED, and the explorer shows an honest note
   * ("gemessen über den Wechselrichter — siehe PV gesamt") instead of the
   * generic "Keine Werte".
   */
  producer: boolean;
}

/** One rail group = one Komponente, its Gerät sub-line and its Messwerte. */
export interface VerlaufGroup {
  entityId: string;
  /** Customer-facing component name (no parenthetical type suffix). */
  label: string;
  /** The stored, fully-qualified name - support/debug `title` only. */
  rawLabel: string;
  role: ComponentRole;
  icon: string;
  /** "Deye SUN-12K · verbunden" - ONE device name plus its state, or null. */
  deviceLine: string | null;
  health: ComponentHealth;
  /**
   * F2a: this component's values are read THROUGH the hybrid inverter, so it has
   * no series of its own yet ("über den Wechselrichter gemessen"). The rail says
   * so instead of offering measurements that would chart empty, and
   * {@link firstTarget} never lands on one.
   *
   * Data-driven on purpose: it comes from `plantModel`'s `measuredVia`, which is
   * null as soon as the component's own telemetry is present - so when the edge
   * starts publishing PV per entity, this note stops appearing by itself. No
   * rework, no type-based guess.
   */
  measuredVia: string | null;
  items: VerlaufItem[];
}

// --- Rail cleanup (B1-c) -----------------------------------------------------

/** Comparison key: case- and separator-insensitive ("SUN-30K" == "sun30k"). */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The rail shows a plain component name. A composed entity's stored label
 * carries its type in brackets ("Netzanschluss (Messung)", "Batteriespeicher
 * (Hybrid)"), which is what got truncated mid-word in the rail - the bracket is
 * dropped here and the full name survives as the row's `title`.
 */
export function railComponentName(label: string, role: ComponentRole): string {
  const stripped = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
  // Nothing but the bracket (or nothing at all) → the role name, never noise.
  return stripped || COMPONENT_ROLE_LABELS[role];
}

/** A lowercase brand reads as a name once ("deye" -> "Deye"); SMA stays SMA. */
function brandName(brand: string): string {
  const b = brand.trim();
  return b === b.toLowerCase() ? b.charAt(0).toUpperCase() + b.slice(1) : b;
}

/**
 * ONE device name for a component - the fix for the rail's technical dump
 * ("deye · sun-30k-sg01hp3 · Deye · SUN-30K-SG01HP3-EU"). Every feeder is turned
 * into a brand-prefixed display name, then names whose key is CONTAINED in a
 * more human one are dropped (so the id, the brand alone and the model alone all
 * collapse into the one full name). Genuinely different devices survive as
 * "+ N weitere" - never a chain of near-duplicates.
 */
export function oneDeviceName(
  feeders: { label: string; brand: string | null }[],
): { name: string; more: number } | null {
  const named = feeders
    .map((f) => {
      const label = f.label?.trim() ?? '';
      if (!label) return f.brand?.trim() ? brandName(f.brand) : '';
      const brand = f.brand?.trim() ? brandName(f.brand) : '';
      if (brand && !normKey(label).startsWith(normKey(brand))) return `${brand} ${label}`;
      return label;
    })
    .filter((n) => n.length > 0);
  if (named.length === 0) return null;

  // Most human first (uppercase letters read as a product name), then longest.
  const humanness = (s: string) => (s.match(/[A-ZÄÖÜ]/g) ?? []).length;
  const sorted = [...named].sort(
    (a, b) => humanness(b) - humanness(a) || b.length - a.length || a.localeCompare(b),
  );
  const kept: string[] = [];
  for (const n of sorted) {
    if (kept.some((k) => normKey(k).includes(normKey(n)))) continue;
    kept.push(n);
  }
  return { name: kept[0], more: kept.length - 1 };
}

// --- Browser tree ------------------------------------------------------------

/** Unit for one channel: the entity's declared unit, else the channel hint. */
function itemUnit(entity: SiteEntity | undefined, channel: string): string {
  const declared = entity?.capabilities?.measure?.find((m) => m.channel === channel)?.unit;
  if (declared && declared.trim()) return declared.trim();
  return channelUnitHint(channel) ?? '';
}

/**
 * The device sub-line for a component: ONE device name plus its state (B1-c).
 * No device ids, no register families, no thrice-repeated model - see
 * {@link oneDeviceName}.
 */
function deviceLineFor(
  componentId: string,
  model: ReturnType<typeof plantModel>,
): string | null {
  const feeders = model.devices.filter((d) => d.componentIds.includes(componentId));
  if (feeders.length === 0) return null;
  const picked = oneDeviceName(feeders);
  if (!picked) return null;
  // H2: only a real `ok` reads „verbunden" - an unreported device says so.
  const health = feeders.some((d) => d.health === 'stale')
    ? 'meldet gerade keine Daten'
    : feeders.some((d) => d.health === 'never')
      ? 'noch keine Daten'
      : feeders.some((d) => d.health === 'unknown')
        ? 'noch keine Rückmeldung'
        : 'verbunden';
  const name = picked.more > 0 ? `${picked.name} + ${picked.more} weitere` : picked.name;
  return `${name} · ${health}`;
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
    // A hybrid's PV ASPECT is a presentation split of an entity that is already
    // listed with its own channels - charting it would duplicate „PV-Leistung"
    // under a second name and its `entityId#pv` id has no history behind it.
    if (c.aspect !== 'main') continue;
    const entity = entityById.get(c.entityId);
    const producer = entity?.entityType === 'producer';
    const items: VerlaufItem[] = c.channels.map((ch) => ({
      entityId: c.id,
      channel: ch.raw,
      label: ch.label,
      unit: itemUnit(entity, ch.raw),
      role: c.role,
      raw: ch.raw,
      producer,
    }));
    groups.push({
      entityId: c.id,
      label: railComponentName(c.label, c.role),
      rawLabel: c.label,
      role: c.role,
      icon: COMPONENT_ROLE_ICONS[c.role],
      deviceLine: deviceLineFor(c.id, model),
      health: c.health,
      measuredVia: c.measuredVia,
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
    rawLabel: COMPONENT_ROLE_LABELS[c.role],
    role: c.role,
    icon: COMPONENT_ROLE_ICONS[c.role],
    deviceLine: null,
    health: 'ok' as ComponentHealth,
    measuredVia: null,
    items: [
      {
        entityId: V1_ENTITY,
        channel: c.channel,
        label: c.label,
        unit: c.percent ? '%' : 'kW',
        role: c.role,
        raw: c.channel,
        producer: false,
      },
    ],
  }));
}

// --- Berechnete Werte (Gesamtwert, AP-10): ein eigener Ast --------------------

/**
 * Das Präfix der synthetischen `entityId` eines berechneten Werts. Es trägt
 * KEINEN Doppelpunkt, damit der Deep-Link `m={entityId}:{channel}` weiter sauber
 * am ersten Doppelpunkt trennt (die Messstellen-Id ist eine UUID ohne `:`).
 */
export const BERECHNET_PREFIX = 'berechnet-';

/** Der EINE Kanalname eines berechneten Werts (er hat genau eine Größe). */
export const BERECHNET_CHANNEL = 'wert';

export function istBerechnet(entityId: string): boolean {
  return entityId.startsWith(BERECHNET_PREFIX);
}

/** Die Messstellen-Id aus einer synthetischen `entityId` eines berechneten Werts. */
export function berechneteMessstelleId(entityId: string): string {
  return entityId.slice(BERECHNET_PREFIX.length);
}

/** Ein berechneter Wert, so wie der Verlauf-Ast ihn braucht (aus der Messstelle). */
export interface BerechneterMesswert {
  id: string;
  name: string;
  einheit: string;
  role: ComponentRole;
}

/**
 * Der Ast „Berechnete Werte" für den Verlauf-Explorer — ein eigener Ast neben
 * den gemessenen Komponenten, damit ein Gesamtwert wie ein nativer Messwert
 * wählbar ist. Ohne einen einzigen berechneten Wert gibt es keinen Ast (null).
 */
export function berechneteGruppe(werte: BerechneterMesswert[]): VerlaufGroup | null {
  if (werte.length === 0) return null;
  return {
    entityId: 'berechnet',
    label: 'Berechnete Werte',
    rawLabel: 'Berechnete Werte',
    role: 'pv',
    icon: 'sliders',
    deviceLine: null,
    health: 'ok' as ComponentHealth,
    measuredVia: null,
    items: werte.map((w) => ({
      entityId: BERECHNET_PREFIX + w.id,
      channel: BERECHNET_CHANNEL,
      label: w.name,
      unit: w.einheit,
      role: w.role,
      raw: w.name,
      producer: false,
    })),
  };
}

/**
 * Die Chart-Reihe eines berechneten Werts aus seinem Server-Verlauf
 * (`GET …/verlauf`): je 15-min-Punkt die Summe, oder `null` (unvollständig — nie
 * eine erfundene 0). Kein Schwankungsband (der Wert ist eine Summe, kein
 * Mittel).
 */
export function seriesFromMessstelleVerlauf(
  verlauf: MessstelleVerlauf,
  range: HistoryRange,
): VerlaufSeries {
  const isDay = range === 'day';
  const points: VerlaufPoint[] = verlauf.punkte.map((p) => ({
    t: p.zeit,
    avg: num(p.wert),
    min: null,
    max: null,
    n: 1,
  }));
  return {
    points,
    unit: verlauf.einheit ?? '',
    hasBand: false,
    isDay,
    bars: false,
    bucketMinutes: 15,
    empty: !points.some((p) => p.avg != null),
  };
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

/**
 * The landing measurement when none is selected. Deliberately skips a component
 * whose values are read through the inverter (`measuredVia`): landing on one
 * would greet the customer with an honest-but-empty chart.
 */
export function firstTarget(groups: VerlaufGroup[]): VerlaufTarget | null {
  const measuring = groups.filter((g) => g.measuredVia == null);
  const it = flattenItems(measuring.length ? measuring : groups)[0];
  return it ? { entityId: it.entityId, channel: it.channel } : null;
}

// --- Multi-select (B1-c): up to 3 measurements on one chart -------------------

/** The owner's ceiling: three curves stay readable, four do not. */
export const MAX_SELECTED = 3;

/** Same measurement? */
export function sameTarget(a: VerlaufTarget, b: VerlaufTarget): boolean {
  return a.entityId === b.entityId && a.channel === b.channel;
}

export function isSelected(targets: VerlaufTarget[], t: VerlaufTarget): boolean {
  return targets.some((x) => sameTarget(x, t));
}

/**
 * Checkbox semantics instead of a radio button: add a measurement while there is
 * room (max {@link MAX_SELECTED}), remove it when it is already selected - but
 * never empty the selection, because an empty chart is not a state a click
 * should be able to reach (the `toggleSerie` rule of the default view).
 */
export function toggleTarget(
  targets: VerlaufTarget[],
  t: VerlaufTarget,
  max: number = MAX_SELECTED,
): VerlaufTarget[] {
  if (isSelected(targets, t)) {
    if (targets.length <= 1) return targets;
    return targets.filter((x) => !sameTarget(x, t));
  }
  if (targets.length >= max) return targets;
  return [...targets, t];
}

/** "2 von 3 ausgewählt · max. 3" - the rail's honest footer. */
export function selectionNote(count: number, max: number = MAX_SELECTED): string {
  return `${count} von ${max} ausgewählt · max. ${max}`;
}

/** Resolve a list of deep-link targets to their items, dropping unknown ones. */
export function findItems(groups: VerlaufGroup[], targets: VerlaufTarget[]): VerlaufItem[] {
  return targets
    .map((t) => findItem(groups, t))
    .filter((it): it is VerlaufItem => it != null);
}

/**
 * Mixed units (kW next to %) need a second axis - one axis would squash the
 * kW curve into the floor of a 0..100 scale. The FIRST unit owns the primary
 * axis, the first differing one the secondary; a third distinct unit is not
 * possible with the measurements we expose (kW / % / kWh).
 */
export function secondAxisUnit(units: string[]): string | null {
  const distinct = units.filter((u, i) => u && units.indexOf(u) === i);
  return distinct.length > 1 ? distinct[1] : null;
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
  /** Every named measurement, in link order (max {@link MAX_SELECTED}). */
  targets: VerlaufTarget[];
  /** The first named measurement - "did this link name one at all?". */
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
 * Parse `m={entityId}:{channel}` (repeatable, up to {@link MAX_SELECTED}),
 * `z={tag|woche|monat|jahr}`, `at={ISO}` from a hash (or bare query).
 * Unknown/absent params fall back to safe defaults — `parseRoute` already strips
 * `?…`, so the explorer parses this itself. A single-`m` link (every existing
 * bookmark and cockpit jump) parses exactly as before.
 */
export function parseVerlaufParams(hashOrQuery: string): VerlaufParams {
  const params = new URLSearchParams(queryOf(hashOrQuery));
  const targets: VerlaufTarget[] = [];
  for (const m of params.getAll('m')) {
    const idx = m.indexOf(':');
    if (idx <= 0 || idx >= m.length - 1) continue;
    const t = { entityId: m.slice(0, idx), channel: m.slice(idx + 1) };
    if (isSelected(targets, t)) continue;
    if (targets.length >= MAX_SELECTED) break;
    targets.push(t);
  }
  const at = params.get('at');
  return {
    targets,
    target: targets[0] ?? null,
    range: wordRange(params.get('z')),
    at: at && /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : null,
  };
}

/**
 * Build the explorer deep-link. `hashForRoute` stays untouched (it drops the
 * query); this is the ONE builder for the `?m&z&at` link (reused by the V2
 * cockpit jump). Several measurements become several `m` params, so a comparison
 * is shareable too.
 *
 * Ziel ist seit der Zwei-Welten-Struktur die **Messwerte-Welt** — der Explorer
 * ist ihr aufklappbarer Abschnitt. Ältere `…/historie?m=…`-Lesezeichen bleiben
 * gültig: `nav.ts` leitet sie MIT ihren Parametern hierher weiter.
 */
export function verlaufHash(
  siteId: string,
  target: VerlaufTarget | VerlaufTarget[],
  range: VerlaufRange,
  at?: string | null,
): string {
  const list = Array.isArray(target) ? target : [target];
  const parts = list
    .slice(0, MAX_SELECTED)
    .map((t) => `m=${t.entityId}:${t.channel}`)
    .concat(`z=${rangeWord(range)}`);
  if (at) parts.push(`at=${at}`);
  return `#/anlage/${siteId}/messwerte?${parts.join('&')}`;
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
