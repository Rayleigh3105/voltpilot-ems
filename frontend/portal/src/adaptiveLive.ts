/**
 * AE3 adaptive tiles + status sentence: turns the AE1 topology read-model
 * (role-grouped nodes + entities) into the entity/role-driven verdict tiles and
 * the ONE plain-German status sentence of the adaptive live view. The roles
 * PV / Speicher / Netz become one aggregate tile each; every controllable
 * consumer (Wallbox, Heizstab, …) becomes its OWN tile with a read-only
 * device-switch affordance (v1 display-only; actual control is E3b). Pure +
 * framework-free (unit-tested in adaptiveLive.test.ts); the components only
 * render it.
 *
 * Signs never reach the customer - the grid/battery labels flip and the
 * sentence speaks direction words, mirroring the v1 live.ts discipline.
 */

import type { IconName } from '../designsystem/components/core/Icon';
import type { SiteTopology, TopologyEntity } from './api';
import {
  controlPreset,
  DEADBAND_KW,
  iconFor,
  isControllableConsumerType,
  ROLE_META,
  type ControlPreset,
} from './adaptive';
import { fmtNum } from './format';
import type { FlowNode, Role } from './topology';

export interface AdaptiveTile {
  key: string;
  role: Role;
  /** index.css `.vp-verdict` accent class. */
  tileClass: 'pv' | 'batt' | 'grid' | 'load';
  icon: IconName;
  title: string;
  /** Headline value ("6,4 kW" / "78 %" / "–"). */
  value: string;
  /** Verdict word/phrase ("erzeugt", "lädt", "Einspeisung", …). */
  stateLabel: string;
  stateTone: 'accent' | 'muted';
  arrow?: 'up' | 'down';
  /** Storage SoC for the fill bar (0-100). */
  socPct?: number;
  /** Optional detail sub-line ("Ladeleistung 3,4 kW", "2 Erzeuger"). */
  subLine?: string;
  /** Read-only device switches for a controllable consumer (v1 display-only). */
  control?: ControlPreset;
}

function node(topo: SiteTopology, role: Role): FlowNode | undefined {
  return topo.topology.nodes.find((n) => n.role === role);
}

/** Signed battery power from the storage node (charge +, discharge -). */
function signedBattery(n: FlowNode): number | null {
  if (n.value_kw == null || !n.flow_active) return 0;
  return n.direction === 'out' ? n.value_kw : n.direction === 'in' ? -n.value_kw : 0;
}

function pvTile(n: FlowNode): AdaptiveTile {
  const active = n.flow_active && n.value_kw != null && n.value_kw > DEADBAND_KW;
  const memberCount = n.members.length;
  const title = memberCount === 1 ? n.members[0].label || 'PV-Anlage' : 'PV-Erzeugung';
  return {
    key: 'role-pv',
    role: 'pv',
    tileClass: 'pv',
    icon: 'sun',
    title,
    value: n.value_kw == null ? '–' : fmtNum(n.value_kw, 'kW', 1),
    stateLabel: n.value_kw == null ? 'noch keine Daten' : active ? 'erzeugt' : 'keine Erzeugung',
    stateTone: active ? 'accent' : 'muted',
    subLine: memberCount > 1 ? `${memberCount} Erzeuger` : undefined,
  };
}

function storageTile(n: FlowNode): AdaptiveTile {
  const soc = n.soc_pct ?? null;
  const batt = signedBattery(n);
  const title = n.members.length === 1 ? n.members[0].label || 'Speicher' : 'Speicher';
  let stateLabel = 'Bereit';
  let stateTone: 'accent' | 'muted' = 'muted';
  let arrow: 'up' | 'down' | undefined;
  let subLine: string | undefined;
  if (soc == null) {
    stateLabel = 'keine Batterie';
  } else if (batt != null && batt > DEADBAND_KW) {
    stateLabel = 'Lädt';
    stateTone = 'accent';
    arrow = 'up';
    subLine = `Ladeleistung ${fmtNum(batt, 'kW', 1)}`;
  } else if (batt != null && batt < -DEADBAND_KW) {
    stateLabel = 'Entlädt';
    stateTone = 'accent';
    arrow = 'down';
    subLine = `Abgabe ${fmtNum(Math.abs(batt), 'kW', 1)}`;
  } else if (soc >= 99) {
    stateLabel = 'Voll geladen';
  }
  return {
    key: 'role-storage',
    role: 'storage',
    tileClass: 'batt',
    icon: 'battery',
    title,
    value: soc == null ? '–' : fmtNum(soc, '%', 0),
    stateLabel,
    stateTone,
    arrow,
    socPct: soc == null ? undefined : Math.max(0, Math.min(100, soc)),
    subLine,
  };
}

function gridTile(n: FlowNode): AdaptiveTile {
  const active = n.flow_active && n.value_kw != null && n.value_kw > DEADBAND_KW;
  let stateLabel = 'noch keine Daten';
  let stateTone: 'accent' | 'muted' = 'muted';
  let arrow: 'up' | 'down' | undefined;
  let subLine: string | undefined;
  if (n.value_kw != null) {
    if (active && n.direction === 'in') {
      stateLabel = 'Netzbezug';
      stateTone = 'accent';
      arrow = 'up';
      subLine = 'aus dem Netz';
    } else if (active && n.direction === 'out') {
      stateLabel = 'Einspeisung';
      stateTone = 'accent';
      arrow = 'down';
      subLine = 'ins Netz';
    } else {
      stateLabel = 'ausgeglichen';
    }
  }
  return {
    key: 'role-grid',
    role: 'grid',
    tileClass: 'grid',
    icon: 'zap',
    title: 'Netz',
    value: n.value_kw == null ? '–' : fmtNum(n.value_kw, 'kW', 1),
    stateLabel,
    stateTone,
    arrow,
    subLine,
  };
}

/** One tile per consumer entity (each with its own value + read-only switches). */
function consumerTiles(n: FlowNode, byId: Map<string, TopologyEntity>): AdaptiveTile[] {
  return n.members.map((m, i) => {
    const entity = byId.get(m.entity_id);
    const type = entity?.entityType ?? '';
    const active = m.value_kw != null && Math.abs(m.value_kw) > DEADBAND_KW;
    const controllable = isControllableConsumerType(type);
    let stateLabel: string;
    let stateTone: 'accent' | 'muted';
    if (m.value_kw == null) {
      stateLabel = 'noch keine Daten';
      stateTone = 'muted';
    } else if (active) {
      stateLabel = type === 'wallbox' ? 'lädt' : 'aktiv';
      stateTone = 'accent';
    } else {
      stateLabel = 'aus';
      stateTone = 'muted';
    }
    return {
      key: `consumer-${m.entity_id}-${i}`,
      role: 'consumer' as Role,
      tileClass: 'load' as const,
      icon: iconFor(type, 'consumer'),
      title: m.label || entity?.typeLabel || 'Verbraucher',
      value: m.value_kw == null ? '–' : fmtNum(Math.abs(m.value_kw), 'kW', 1),
      stateLabel,
      stateTone,
      control: controllable ? controlPreset(type) ?? undefined : undefined,
    };
  });
}

/**
 * The verdict tiles for the adaptive live view, in the mockup's role order:
 * PV, Speicher, then each Verbraucher, then Netz. An absent role is simply
 * skipped (a PV-less or battery-less site shows fewer tiles - never a fake 0).
 */
export function deriveTiles(topo: SiteTopology): AdaptiveTile[] {
  const byId = new Map(topo.entities.map((e) => [e.id, e]));
  const tiles: AdaptiveTile[] = [];
  const pv = node(topo, 'pv');
  if (pv) tiles.push(pvTile(pv));
  const storage = node(topo, 'storage');
  if (storage) tiles.push(storageTile(storage));
  const consumer = node(topo, 'consumer');
  if (consumer) tiles.push(...consumerTiles(consumer, byId));
  const grid = node(topo, 'grid');
  if (grid) tiles.push(gridTile(grid));
  return tiles;
}

/** Whether the topology carries any renderable entity (else: fall back to v1). */
export function hasTopology(topo: SiteTopology | null | undefined): boolean {
  return topo != null && topo.entities.length > 0 && topo.topology.nodes.length > 0;
}

// --- Status sentence ---------------------------------------------------------

export interface StatusSentence {
  text: string;
  /** false = stale/offline: renders honest-grey. */
  live: boolean;
}

/**
 * The ONE freshness truth of the live view. Two independent sources feed this
 * surface and they used to speak past each other (G3): the ANLAGE's telemetry
 * (the "Stand vor X" chip + the Verlauf chart) and the per-ENTITY health of the
 * v2 registry. A migrated site whose entities have never reported while v1
 * telemetry flows normally is neither "live per entity" nor "offline" - it is
 * an Anlage that reports while its device-level breakdown does not yet.
 *
 * - `live`      at least one entity delivers current data.
 * - `site-only` the Anlage reports current telemetry, the entities do not.
 * - `stale`     nothing current from either source.
 */
export type LiveState = 'live' | 'site-only' | 'stale';

export function liveState(input: {
  /** Any entity's observed health is `ok`. */
  entityFresh: boolean;
  /** The Anlage's v1 telemetry is within the freshness window (null = unknown). */
  siteFresh: boolean | null | undefined;
}): LiveState {
  if (input.entityFresh) return 'live';
  return input.siteFresh === true ? 'site-only' : 'stale';
}

/**
 * The ONE plain-German status sentence, composed from the role nodes: PV lead,
 * storage clause, active-consumer clause(s), grid clause - each honest about
 * absent data and speaking direction words, never signs. Stale data goes
 * honest-grey (mirrors live.ts composeStatusSentence); the `site-only` state
 * says exactly what is and is not there instead of claiming an outage the
 * Verlauf chart right below would contradict.
 */
export function composeAdaptiveSentence(
  topo: SiteTopology,
  state: LiveState | boolean,
): StatusSentence {
  const resolved: LiveState =
    typeof state === 'boolean' ? (state ? 'live' : 'stale') : state;
  if (resolved === 'stale') {
    return {
      live: false,
      text: 'Ihre Anlage meldet gerade keine aktuellen Daten. Angezeigt werden die zuletzt bekannten Werte.',
    };
  }
  if (resolved === 'site-only') {
    return {
      live: true,
      text:
        'Ihre Anlage liefert aktuelle Messwerte - im Verlauf unten sehen Sie sie. ' +
        'Die Aufschlüsselung nach einzelnen Geräten meldet noch nichts.',
    };
  }
  const byId = new Map(topo.entities.map((e) => [e.id, e]));
  const parts: string[] = [];

  const pv = node(topo, 'pv');
  if (pv && pv.value_kw != null) {
    parts.push(
      pv.flow_active && pv.value_kw > DEADBAND_KW
        ? `Ihre Anlage erzeugt gerade ${fmtNum(pv.value_kw, 'kW')}.`
        : 'Ihre Anlage erzeugt gerade keinen Strom.',
    );
  }

  const storage = node(topo, 'storage');
  if (storage && storage.soc_pct != null) {
    const soc = ` (${fmtNum(storage.soc_pct, '%', 0)})`;
    const batt = signedBattery(storage);
    if (batt != null && batt > DEADBAND_KW) parts.push(`Der Speicher lädt${soc}.`);
    else if (batt != null && batt < -DEADBAND_KW) parts.push(`Der Speicher entlädt${soc}.`);
    else if (storage.soc_pct >= 99) parts.push(`Der Speicher ist voll geladen${soc}.`);
    else parts.push(`Der Speicher ruht${soc}.`);
  }

  const consumer = node(topo, 'consumer');
  if (consumer) {
    const active = consumer.members.filter(
      (m) => m.value_kw != null && Math.abs(m.value_kw) > DEADBAND_KW,
    );
    for (const m of active.slice(0, 2)) {
      const type = byId.get(m.entity_id)?.entityType ?? '';
      const verb = type === 'wallbox' ? 'lädt' : 'läuft';
      const label = m.label || byId.get(m.entity_id)?.typeLabel || 'Ein Verbraucher';
      parts.push(`${label} ${verb} mit ${fmtNum(Math.abs(m.value_kw as number), 'kW')}.`);
    }
    if (active.length > 2) parts.push(`${active.length - 2} weitere Verbraucher sind aktiv.`);
  }

  const grid = node(topo, 'grid');
  if (grid && grid.value_kw != null) {
    if (grid.flow_active && grid.direction === 'in') {
      parts.push(`Sie beziehen ${fmtNum(grid.value_kw, 'kW')} aus dem Netz.`);
    } else if (grid.flow_active && grid.direction === 'out') {
      parts.push(`${fmtNum(grid.value_kw, 'kW')} fließen ins Netz.`);
    } else {
      parts.push('Ihr Netzanschluss ist gerade ausgeglichen.');
    }
  }

  if (parts.length === 0) return { live: true, text: 'Ihre Anlage liefert gerade Daten.' };
  return { live: true, text: parts.join(' ') };
}

/** The profile chip label + tone for the topbar (Arbitrage/Peak/Privat). */
export function profileChip(profile: string): { label: string; tone: 'arb' | 'peak' | 'priv' } {
  switch (profile) {
    case 'arbitrage':
      return { label: 'Arbitrage / DV', tone: 'arb' };
    case 'peak':
      return { label: 'Gewerbe · Peak-Shaving', tone: 'peak' };
    case 'private':
    default:
      return { label: 'Privat-Haushalt', tone: 'priv' };
  }
}

// Re-export so components import one module for the role palette.
export { ROLE_META };
