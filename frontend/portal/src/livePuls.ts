/**
 * Live-Daten „Komponenten-Board" — the pure derivation behind the V3 live view
 * (design `data/vp-portal-livedata-design/report.md` §1 „Live-Daten" + §4 V3).
 *
 * The board shows ONE row per component: icon, name, health dot, the live value
 * with its state word, a 60-minute sparkline and a „Verlauf →" jump into the
 * explorer pre-focused on that measurement. This module is the pure,
 * unit-tested logic (the `live.ts` / `adaptiveLive.ts` precedent): no React, no
 * network. It DERIVES only.
 *
 * It does NOT re-derive signs or deadbands — the migrated (v2) rows REUSE the
 * `adaptiveLive.deriveTiles` values/state words verbatim and only enrich each
 * with its health, its representative measurement (for the jump + sparkline) and
 * its full Messwert list (the phone-expand). The v1 fallback rows REUSE the
 * `live.buildSnapshot` snapshot + the `live.ts` state derivations.
 *
 * Two rules are law (the „—"-Disziplin): an absent value stays absent (the tile
 * renders the shared `nodata.NO_DATA`), never a fabricated 0; and a sparkline
 * with too few points is simply omitted — and since the audit (V5) the BOARD
 * only promises „letzte 60 Min" when at least one row really has one
 * ({@link hasAnySpark} / {@link boardHint}).
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { EntityHistory, SiteTopology, TelemetryPoint } from './api';
import { deriveTiles } from './adaptiveLive';
import { channelLabel, channelUnitHint } from './channels';
import { toComponentHealth, type ComponentHealth } from './komponenten';
import { numOrNoData } from './nodata';
import {
  batteryState,
  buildSnapshot,
  gridState,
  loadState,
  pvState,
  type LiveSnapshot,
} from './live';
import type { FlowMember, Role } from './topology';
import { V1_ENTITY } from './verlauf';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// --- Row model ---------------------------------------------------------------

/** One measured value behind a row (the phone-expand list; its own jump). */
export interface LivePulsChannel {
  entityId: string;
  channel: string;
  /** Plain-German measurement name (never a raw channel identifier). */
  label: string;
  /** Unit shown after values (kW · % · °C …). */
  unit: string;
}

/** One component row of the Komponenten-Board. */
export interface LivePulsRow {
  key: string;
  /** Role → the sparkline colour (house-load maps to the consumer hue). */
  role: Role;
  icon: IconName;
  /** Short generalised component name. */
  title: string;
  /** The untouched full name for the `title` tooltip (else undefined). */
  fullTitle?: string;
  /** Headline value ("6,4 kW" / "78 %" / "—"). */
  value: string;
  /** Verdict word ("erzeugt", "Lädt", "Einspeisung", …). */
  stateLabel: string;
  stateTone: 'accent' | 'muted';
  arrow?: 'up' | 'down';
  /** Storage SoC for the fill bar (0-100). */
  socPct?: number;
  /** Optional detail sub-line ("2 Erzeuger", "Ladeleistung 3,4 kW"). */
  subLine?: string;
  health: ComponentHealth;
  /** Representative measurement — the sparkline + „Verlauf →" target. */
  target: { entityId: string; channel: string } | null;
  /** Every Messwert behind this row (phone-expand, each its own jump). */
  channels: LivePulsChannel[];
}

// --- v2 (topology-driven) rows -----------------------------------------------

/** The representative channel a role's row plots + jumps to. */
const ROLE_CHANNEL: Record<Role, string> = {
  pv: 'pv_power_kw',
  storage: 'soc_pct',
  grid: 'power_kw',
  consumer: 'power_kw',
};

/**
 * Worst-wins health over member entities. H2: the ranking now carries the
 * honest `unknown` (no feedback at all) BETWEEN „liefert" and „noch keine
 * Daten" — see `komponenten.toComponentHealth`, the ONE mapping.
 */
const HEALTH_RANK: Record<ComponentHealth, number> = {
  ok: 0,
  unknown: 1,
  never: 2,
  stale: 3,
};

function capsOf(topo: SiteTopology, entityId: string) {
  return topo.entities.find((e) => e.id === entityId)?.capabilities ?? [];
}

/**
 * The capabilities of an entity that belong to THIS row's role (V6). A hybrid
 * inverter measures PV *and* Speicher; the „Erzeuger" row must not list the
 * Ladestand. Falls back to every capability when the backend assigned no role
 * to any of them - an empty expansion would be worse than a wide one.
 */
function roleCapsOf(topo: SiteTopology, entityId: string, role: Role) {
  const caps = capsOf(topo, entityId);
  const own = caps.filter((c) => c.role === role);
  return own.length > 0 ? own : caps;
}

/** Prefer the role's representative channel, but only among THIS role's caps. */
function resolveChannel(
  topo: SiteTopology,
  entityId: string,
  role: Role,
  preferred: string,
): string {
  const caps = roleCapsOf(topo, entityId, role);
  if (caps.some((c) => c.channel === preferred)) return preferred;
  return caps[0]?.channel ?? preferred;
}

/** Every Messwert of the row's role, deduped, in a stable order. */
function collectChannels(
  topo: SiteTopology,
  members: FlowMember[],
  role: Role,
): LivePulsChannel[] {
  const seen = new Set<string>();
  const out: LivePulsChannel[] = [];
  for (const m of members) {
    for (const cap of roleCapsOf(topo, m.entity_id, role)) {
      const key = `${m.entity_id}:${cap.channel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        entityId: m.entity_id,
        channel: cap.channel,
        label: channelLabel(cap.channel),
        unit: (cap.unit && cap.unit.trim()) || channelUnitHint(cap.channel) || '',
      });
    }
  }
  return out;
}

function worstMemberHealth(topo: SiteTopology, members: FlowMember[]): ComponentHealth {
  let worst: ComponentHealth = 'ok';
  for (const m of members) {
    const h = toComponentHealth(topo.entities.find((e) => e.id === m.entity_id)?.health);
    if (HEALTH_RANK[h] > HEALTH_RANK[worst]) worst = h;
  }
  return worst;
}

/**
 * The Komponenten-Board rows for a migrated (v2) site. It REUSES
 * `deriveTiles(topology)` for every value + state word (no re-derived sign or
 * deadband) and only resolves each tile's backing component(s) to add the
 * health dot, the „Verlauf →" / sparkline target and the Messwert list. A
 * multi-producer PV role collapses to one row exactly like the tile does (the
 * parts stay reachable in the explorer rail).
 */
export function componentRows(topo: SiteTopology): LivePulsRow[] {
  const tiles = deriveTiles(topo);
  const consumerNode = topo.topology.nodes.find((n) => n.role === 'consumer');
  let consumerIdx = 0;

  return tiles.map((tile) => {
    let members: FlowMember[];
    let preferred: string;
    if (tile.role === 'consumer') {
      // deriveTiles emits one tile per consumer member, in member order.
      const m = consumerNode?.members[consumerIdx++];
      members = m ? [m] : [];
      preferred = ROLE_CHANNEL.consumer;
    } else {
      const n = topo.topology.nodes.find((nn) => nn.role === tile.role);
      members = n?.members ?? [];
      preferred = ROLE_CHANNEL[tile.role];
    }
    const rep = members.find((m) => m.primary) ?? members[0];
    const target = rep
      ? {
          entityId: rep.entity_id,
          channel: resolveChannel(topo, rep.entity_id, tile.role, preferred),
        }
      : null;
    return {
      key: tile.key,
      role: tile.role,
      icon: tile.icon,
      title: tile.title,
      fullTitle: tile.fullTitle,
      value: tile.value,
      stateLabel: tile.stateLabel,
      stateTone: tile.stateTone,
      arrow: tile.arrow,
      socPct: tile.socPct,
      subLine: tile.subLine,
      health: worstMemberHealth(topo, members),
      target,
      channels: collectChannels(topo, members, tile.role),
    };
  });
}

// --- v1 fallback rows (entity-less site) -------------------------------------

/** The v1 site-level channel a row plots + deep-links to (the verlauf.ts tree). */
type V1Channel = 'pv' | 'haus' | 'netz' | 'soc';

function v1Row(
  channel: V1Channel,
  role: Role,
  icon: IconName,
  title: string,
  rawChannel: string,
  unit: string,
  value: string,
  stateLabel: string,
  stateTone: 'accent' | 'muted',
  extra?: { arrow?: 'up' | 'down'; socPct?: number; measured?: boolean },
): LivePulsRow {
  return {
    key: `v1-${channel}`,
    role,
    icon,
    title,
    value,
    stateLabel,
    stateTone,
    arrow: extra?.arrow,
    socPct: extra?.socPct,
    // H2 discipline on the v1 board too: a site-level row whose measurement is
    // absent must not show a green „liefert Daten" dot.
    health: extra?.measured === false ? 'unknown' : 'ok',
    target: { entityId: V1_ENTITY, channel },
    channels: [{ entityId: V1_ENTITY, channel, label: channelLabel(rawChannel), unit }],
  };
}

/**
 * The v1 fallback rows for an entity-less site: the four site-level measurements
 * (PV / Haus / Netz / Speicher) drawn from `buildSnapshot` and the `live.ts`
 * state derivations — the same wording the v1 status hero used, so nothing is
 * re-derived. Each row deep-links into the v1 explorer tree
 * (`{V1_ENTITY, pv|haus|netz|soc}`).
 */
export function v1FallbackRows(points: TelemetryPoint[]): LivePulsRow[] {
  const snap = buildSnapshot(points);
  return [
    pvRow(snap),
    storageRow(snap),
    hausRow(snap),
    netzRow(snap),
  ];
}

function pvRow(snap: LiveSnapshot): LivePulsRow {
  const s = pvState(snap.pvKw);
  const [label, tone]: [string, 'accent' | 'muted'] =
    s === 'erzeugt' ? ['erzeugt', 'accent'] : s === 'keine' ? ['keine Erzeugung', 'muted'] : ['noch keine Daten', 'muted'];
  return v1Row('pv', 'pv', 'sun', 'Solar', 'pv_power_kw', 'kW', numOrNoData(snap.pvKw, 'kW'), label, tone, {
    measured: snap.pvKw != null,
  });
}

function storageRow(snap: LiveSnapshot): LivePulsRow {
  const s = batteryState(snap.socPct, snap.battKw);
  let label = 'Bereit';
  let tone: 'accent' | 'muted' = 'muted';
  let arrow: 'up' | 'down' | undefined;
  let subLine: string | undefined;
  if (s === 'laedt') {
    label = 'Lädt';
    tone = 'accent';
    arrow = 'up';
    if (snap.battKw != null) subLine = `Ladeleistung ${numOrNoData(snap.battKw, 'kW')}`;
  } else if (s === 'entlaedt') {
    label = 'Entlädt';
    tone = 'accent';
    arrow = 'down';
    if (snap.battKw != null) subLine = `Abgabe ${numOrNoData(Math.abs(snap.battKw), 'kW')}`;
  } else if (s === 'voll') {
    label = 'Voll geladen';
  } else if (s === 'keine') {
    // V1 twin of `adaptiveLive.storageTile`: a missing SoC reading is „noch
    // keine Daten", never the claim that the plant has no battery.
    label = 'noch keine Daten';
  }
  const socPct = snap.socPct == null ? undefined : Math.max(0, Math.min(100, snap.socPct));
  const row = v1Row(
    'soc',
    'storage',
    'battery',
    'Batterie',
    'soc_pct',
    '%',
    numOrNoData(snap.socPct, '%', 0),
    label,
    tone,
    { arrow, socPct, measured: snap.socPct != null },
  );
  row.subLine = subLine;
  return row;
}

function hausRow(snap: LiveSnapshot): LivePulsRow {
  const s = loadState(snap.loadKw);
  const [label, tone]: [string, 'accent' | 'muted'] =
    s === 'bedarf' ? ['aktueller Bedarf', 'accent'] : s === 'keiner' ? ['kein Verbrauch', 'muted'] : ['noch keine Daten', 'muted'];
  return v1Row('haus', 'consumer', 'home', 'Haus', 'load_kw', 'kW', numOrNoData(snap.loadKw, 'kW'), label, tone, {
    measured: snap.loadKw != null,
  });
}

function netzRow(snap: LiveSnapshot): LivePulsRow {
  const s = gridState(snap.gridKw);
  const abs = snap.gridKw == null ? null : Math.abs(snap.gridKw);
  let label = 'noch keine Daten';
  let tone: 'accent' | 'muted' = 'muted';
  let arrow: 'up' | 'down' | undefined;
  if (s === 'bezug') {
    label = 'Netzbezug';
    tone = 'accent';
    arrow = 'up';
  } else if (s === 'einspeisung') {
    label = 'Einspeisung';
    tone = 'accent';
    arrow = 'down';
  } else if (s === 'ausgeglichen') {
    label = 'ausgeglichen';
  }
  return v1Row('netz', 'grid', 'zap', 'Netz', 'power_kw', 'kW', numOrNoData(abs, 'kW'), label, tone, {
    arrow,
    measured: snap.gridKw != null,
  });
}

// --- Sparklines --------------------------------------------------------------

/** A render-ready 60-minute sparkline (the chart draws + colours it). */
export interface Spark {
  /** Bucket/sample values in time order (null = a gap, kept honest). */
  values: (number | null)[];
  min: number;
  max: number;
}

/** The trailing 60-minute window; too few points → null (no sparkline). */
function buildSpark(pairs: { t: number; v: number | null }[], nowMs: number): Spark | null {
  const cutoff = nowMs - 60 * 60 * 1000;
  const recent = pairs.filter((p) => p.t >= cutoff && p.t <= nowMs).sort((a, b) => a.t - b.t);
  const values = recent.map((p) => p.v);
  const finite = values.filter((v): v is number => v != null);
  if (finite.length < 2) return null;
  return { values, min: Math.min(...finite), max: Math.max(...finite) };
}

/**
 * The last-60-minute sparkline of one entity channel, plucked from a
 * `range='day'` entity history (its rollup/raw buckets carry `{start, avg}`).
 */
export function sparkFromEntityHistory(
  history: EntityHistory,
  channel: string,
  now: Date,
): Spark | null {
  const buckets = history.channels[channel] ?? [];
  return buildSpark(
    buckets.map((b) => ({ t: new Date(b.start).getTime(), v: num(b.avg) })),
    now.getTime(),
  );
}

/** The last-60-minute sparkline of a v1 telemetry channel (the loaded window). */
export function sparkFromPoints(
  points: TelemetryPoint[],
  pick: (p: TelemetryPoint) => number | null,
  now: Date,
): Spark | null {
  return buildSpark(
    points.map((p) => ({ t: new Date(p.ts).getTime(), v: num(pick(p)) })),
    now.getTime(),
  );
}

/** The telemetry accessor for a v1 board row's sparkline. */
export function v1Pick(channel: string): (p: TelemetryPoint) => number | null {
  switch (channel) {
    case 'pv':
      return (p) => p.pvPowerKw;
    case 'haus':
      return (p) => p.loadKw;
    case 'netz':
      return (p) => p.powerKw;
    case 'soc':
      return (p) => p.socPct;
    default:
      return () => null;
  }
}

/** Build the sparks map (key = row.key) for the v1 rows from the loaded window. */
export function v1Sparks(
  rows: LivePulsRow[],
  points: TelemetryPoint[],
  now: Date,
): Map<string, Spark | null> {
  const out = new Map<string, Spark | null>();
  for (const r of rows) {
    const ch = r.target?.channel;
    out.set(r.key, ch ? sparkFromPoints(points, v1Pick(ch), now) : null);
  }
  return out;
}

/**
 * V5 (Audit) — **das Versprechen nur machen, wenn es eingelöst wird.** Der
 * Kopf des Boards sagte immer „letzte 60 Min" und jede Zeile reservierte einen
 * Sparkline-Platz, auch wenn KEINE Zeile eine Linie hat (schweigendes Gerät;
 * die Quelle ist die Tages-Rollup-Reihe, die kurz nach Berliner Mitternacht
 * naturgemäß fast leer ist). Vier dauerhaft leere Kästchen unter einem
 * Versprechen sind unehrlich — also entscheidet das hier.
 */
export function hasAnySpark(sparks: Map<string, Spark | null>): boolean {
  for (const s of sparks.values()) if (s) return true;
  return false;
}

/**
 * Der Kopfhinweis des Boards: mit Sparklines der volle Satz, ohne sie nur der
 * Absprung-Hinweis — nie eine „letzte 60 Min"-Zusage ohne Linie.
 */
export function boardHint(hasSpark: boolean): { spark: string | null; jump: string } {
  return { spark: hasSpark ? 'letzte 60 Min' : null, jump: 'tippen für den Verlauf' };
}

/** Build the sparks map (key = row.key) for the v2 rows from per-entity history. */
export function entitySparks(
  rows: LivePulsRow[],
  histories: Map<string, EntityHistory>,
  now: Date,
): Map<string, Spark | null> {
  const out = new Map<string, Spark | null>();
  for (const r of rows) {
    const t = r.target;
    const hist = t ? histories.get(t.entityId) : undefined;
    out.set(r.key, hist && t ? sparkFromEntityHistory(hist, t.channel, now) : null);
  }
  return out;
}
