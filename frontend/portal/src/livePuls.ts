/**
 * Das Komponenten-Board des Cockpits — die pure Zeilen-Ableitung.
 *
 * Seit dem Umbau der unteren Cockpit-Hälfte (Konzept
 * `data/vp-cockpit-unten-ux-n3`, Variante A „Markt & Tag", PR 2; Captain-Go
 * 05.08.2026 mit Empfehlung D4) hat jede Zeile EINE Grammatik statt vier:
 *
 *   [Punkt] [Icon] Name (+ Bestands-Notiz) · JETZT-Wert + Richtungswort
 *   | HEUTE-Energie | ›
 *
 * Die zwei Zeitbezüge sind damit GETRENNT beschriftet („jetzt" ist die
 * Wert-Zeile, „heute" die eigene Spalte) — vorher beantworteten die vier
 * Unterzeilen vier verschiedene Fragen („3 Erzeuger" = Bestand · „Voll
 * geladen" = Zustand · „122 kWh heute" = Tagessumme · „ins Netz" = Richtung)
 * unter einer Kopfzeile, die „letzte 60 Min" versprach.
 *
 * **Die Sparklines sind ersatzlos entfallen (D4/K3):** 84×30 px, pro Zeile
 * min→max-autoskaliert ohne Nulllinie und Zeitachse, am Telefon per CSS
 * gelöscht — die Aussage war Schein, und der Trend wohnt in der
 * Verlauf-Ebene der Karte (die bleibt). Mit ihnen entfiel das bedingte
 * „letzte 60 Min"-Versprechen (V5) — der Kopfhinweis ist jetzt die eine
 * Konstante {@link BOARD_HINT}.
 *
 * Unverändert gilt: die Zeilen re-derivieren NICHTS — die migrierten (v2)
 * Zeilen reusen `adaptiveLive.deriveTiles` wörtlich (Werte, Zustandswörter,
 * Deadbands), die v1-Zeilen `live.buildSnapshot` + die `live.ts`-Zustände.
 * Und die „—"-Disziplin: ein fehlender Wert bleibt fehlend (das geteilte
 * `nodata.NO_DATA`), nie eine erfundene 0 — auch in der Heute-Spalte
 * (`liveDetail.withDayTotals` füllt sie nur aus BERICHTETEN Summen).
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { SiteTopology, TelemetryPoint } from './api';
import { deriveTiles } from './adaptiveLive';
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

/** Der Kopfhinweis des Boards — beide Zeitbezüge, eine Interaktion. */
export const BOARD_HINT = 'Jetzt und heute · eine Zeile öffnet den Verlauf';

// --- Row model ---------------------------------------------------------------

/**
 * Eine Zeile der uniformen HEUTE-Spalte. Das Richtungs-WORT trägt die
 * Bedeutung (aria/title); der Pfeil ist nur die visuelle Abkürzung — die
 * Netz-Zeile liest sich „Einspeisung 141 kWh · Bezug 3 kWh".
 */
export interface TodayLine {
  text: string;
  arrow?: 'up' | 'down';
  word?: string;
}

/** One component row of the Komponenten-Board. */
export interface LivePulsRow {
  key: string;
  /** Role → Icon-/Farbwelt (house-load maps to the consumer hue). */
  role: Role;
  icon: IconName;
  /** Short generalised component name. */
  title: string;
  /** The untouched full name for the `title` tooltip (else undefined). */
  fullTitle?: string;
  /** Bestands-Notiz NEBEN dem Namen („3 Erzeuger"); nie ein Zustand. */
  titleNote?: string;
  /** Headline value ("6,4 kW" / "78 %" / "—"). */
  value: string;
  /** Verdict word ("erzeugt", "Lädt", "Einspeisung", …). */
  stateLabel: string;
  stateTone: 'accent' | 'muted';
  arrow?: 'up' | 'down';
  /** Storage SoC for the compact inline bar next to the value (0-100). */
  socPct?: number;
  /** Detail der JETZT-Zeile ("Ladeleistung 3,4 kW"); nie eine Tagessumme. */
  subLine?: string;
  health: ComponentHealth;
  /** Representative measurement — the „Verlauf"-jump target. */
  target: { entityId: string; channel: string } | null;
  /**
   * Die uniforme HEUTE-Spalte (gefüllt von `liveDetail.withDayTotals` aus den
   * BERICHTETEN Tages-Summen); null = „—", nie eine erfundene 0.
   */
  today: TodayLine[] | null;
}

// --- v2 (topology-driven) rows -----------------------------------------------

/** The representative channel a role's row jumps to. */
const ROLE_CHANNEL: Record<Role, string> = {
  pv: 'pv_power_kw',
  storage: 'soc_pct',
  grid: 'power_kw',
  consumer: 'power_kw',
};

/**
 * Worst-wins health over member entities. H2: the ranking carries the honest
 * `unknown` (no feedback at all) BETWEEN „liefert" and „noch keine Daten" —
 * see `komponenten.toComponentHealth`, the ONE mapping.
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
 * inverter measures PV *and* Speicher; the „Erzeuger" row must not jump to
 * the Ladestand. Falls back to every capability when the backend assigned no
 * role to any of them.
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

function worstMemberHealth(topo: SiteTopology, members: FlowMember[]): ComponentHealth {
  let worst: ComponentHealth = 'ok';
  for (const m of members) {
    const h = toComponentHealth(topo.entities.find((e) => e.id === m.entity_id)?.health);
    if (HEALTH_RANK[h] > HEALTH_RANK[worst]) worst = h;
  }
  return worst;
}

/**
 * Die Komponenten-Zeilen einer migrierten (v2) Anlage. REUSE von
 * `deriveTiles(topology)` für jeden Wert + jedes Zustandswort (kein
 * re-derivierter Sign/Deadband); hier kommen nur Health, Sprungziel und die
 * Grammatik-Sortierung der Nebentexte dazu:
 *
 * - die PV-Bestands-Notiz („3 Erzeuger") wandert als {@link LivePulsRow.titleNote}
 *   NEBEN den Namen (sie beschreibt die Komponente, nicht den Moment);
 * - die Netz-Richtungs-Unterzeile („aus dem Netz"/„ins Netz") entfällt — das
 *   Zustandswort („Netzbezug"/„Einspeisung") sagt es bereits, die Dopplung
 *   war Teil der alten Grammatik-Mischung;
 * - Detail-Unterzeilen der JETZT-Zeile („Ladeleistung 3,4 kW") bleiben.
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
      titleNote: tile.role === 'pv' ? tile.subLine : undefined,
      value: tile.value,
      stateLabel: tile.stateLabel,
      stateTone: tile.stateTone,
      arrow: tile.arrow,
      socPct: tile.socPct,
      subLine: tile.role === 'pv' || tile.role === 'grid' ? undefined : tile.subLine,
      health: worstMemberHealth(topo, members),
      target,
      today: null,
    };
  });
}

// --- v1 fallback rows (entity-less site) -------------------------------------

/** The v1 site-level channel a row deep-links to (the verlauf.ts tree). */
type V1Channel = 'pv' | 'haus' | 'netz' | 'soc';

function v1Row(
  channel: V1Channel,
  role: Role,
  icon: IconName,
  title: string,
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
    today: null,
  };
}

/**
 * The v1 fallback rows for an entity-less site: the four site-level
 * measurements (PV / Haus / Netz / Speicher) drawn from `buildSnapshot` and
 * the `live.ts` state derivations — the same wording the v1 status hero used,
 * so nothing is re-derived. Each row deep-links into the v1 explorer tree
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
  return v1Row('pv', 'pv', 'sun', 'Solar', numOrNoData(snap.pvKw, 'kW'), label, tone, {
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
  return v1Row('haus', 'consumer', 'home', 'Haus', numOrNoData(snap.loadKw, 'kW'), label, tone, {
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
  return v1Row('netz', 'grid', 'zap', 'Netz', numOrNoData(abs, 'kW'), label, tone, {
    arrow,
    measured: snap.gridKw != null,
  });
}
