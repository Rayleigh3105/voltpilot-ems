/**
 * AE3 adaptive tiles + the ONE live-freshness truth: turns the AE1 topology
 * read-model (role-grouped nodes + entities) into the entity/role-driven
 * verdict rows of the Komponenten-Board (`livePuls.componentRows` reuses
 * `deriveTiles` verbatim) and the three-state `liveState`. The roles
 * PV / Speicher / Netz become one aggregate tile each; every controllable
 * consumer (Wallbox, Heizstab, …) becomes its OWN tile with a read-only
 * device-switch affordance (v1 display-only; actual control is E3b). Pure +
 * framework-free (unit-tested in adaptiveLive.test.ts); the components only
 * render it.
 *
 * Signs never reach the customer - the grid/battery labels flip and the rows
 * speak direction words, mirroring the v1 live.ts discipline. (The former
 * per-page adaptive status sentence retired with the Cockpit+Live merge — the
 * page head's `composeSiteSentence` + the `liveDetail.liveChip` carry it.)
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
import { shortEntityLabel, shortLabelsForRole } from './entityLabel';
import { fmtNum } from './format';
import { NO_DATA, numOrNoData } from './nodata';
import { ladestandVon } from './ladestandVon';
import { herkunftUeberEntitaeten } from './socHerkunft';
import type { FlowNode, Role } from './topology';

export interface AdaptiveTile {
  key: string;
  role: Role;
  /** index.css `.vp-verdict` accent class. */
  tileClass: 'pv' | 'batt' | 'grid' | 'load';
  icon: IconName;
  title: string;
  /**
   * The untouched full entity name for the tile's `title` tooltip - the header
   * shows the SHORT generalised word (entityLabel.ts), so the "(Messung über
   * Wechselrichter)" nuance stays discoverable without truncating the layout.
   * undefined when there is no name beyond the generic one.
   */
  fullTitle?: string;
  /** Headline value ("6,4 kW" / "78 %" / "—"). */
  value: string;
  /** Verdict word/phrase ("erzeugt", "lädt", "Einspeisung", …). */
  stateLabel: string;
  stateTone: 'accent' | 'muted';
  arrow?: 'up' | 'down';
  /** Storage SoC for the fill bar (0-100). */
  socPct?: number;
  /** Optional detail sub-line ("Ladeleistung 3,4 kW", "2 Erzeuger"). */
  subLine?: string;
  /**
   * WOHER der Ladestand kommt ("gemessen" / "berechnet: Kennlinie"), P5b/P5d.
   *
   * ⚠ Nur der Speicher hat sie, und nur wenn die Batterie den Herkunfts-Kanal
   * WIRKLICH meldet. Absent = unbekannt - eine Kachel, die dort „gemessen"
   * schriebe, hätte sich das ausgedacht: fast jede über einen Katalog-Treiber
   * gelesene Batterie meldet den Kanal nie.
   */
  herkunft?: string;
  /**
   * „Ladestand von: <Batterie>" (P6 Speiser-Bindung).
   *
   * ⚠ Nur gesetzt, wenn der Ladestand NICHT von dem Gerät kommt, dessen
   * Kilowatt diese Kachel führt - also genau dann, wenn er sonst dem falschen
   * Gerät zugeschrieben würde. Ein Hybrid, der seinen eigenen Ladestand meldet,
   * bekommt die Zeile nicht: „Ladestand von: Deye" an einer Kachel, die schon
   * „Deye" heißt, ist keine Auskunft.
   */
  socQuelle?: string;
  /**
   * Was das BMS gerade zulässt („max. 22 A laden · Entladen gesperrt"), P6.
   * Absent, wenn keine Batterie eine Grenze meldet - fast alle über einen
   * Katalog-Treiber gelesenen tun das nie.
   */
  grenzen?: string;
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

function pvTile(n: FlowNode, byId: Map<string, TopologyEntity>): AdaptiveTile {
  const active = n.flow_active && n.value_kw != null && n.value_kw > DEADBAND_KW;
  const memberCount = n.members.length;
  const title = memberCount === 1 ? roleMemberLabel(n, 'pv', byId) : 'PV-Erzeugung';
  return {
    key: 'role-pv',
    role: 'pv',
    tileClass: 'pv',
    icon: 'sun',
    title,
    fullTitle: memberCount === 1 ? fullMemberName(n) : undefined,
    value: numOrNoData(n.value_kw, 'kW', 1),
    stateLabel: n.value_kw == null ? 'noch keine Daten' : active ? 'erzeugt' : 'keine Erzeugung',
    stateTone: active ? 'accent' : 'muted',
    subLine: memberCount > 1 ? `${memberCount} Erzeuger` : undefined,
  };
}

function storageTile(n: FlowNode, byId: Map<string, TopologyEntity>): AdaptiveTile {
  const soc = n.soc_pct ?? null;
  /*
    P5d: ein BERECHNETER Ladestand gibt sich zu erkennen - überall, wo er
    auftaucht. Die Herkunft kommt aus dem Kanal `soc_source_code`, nie aus einer
    Vermutung über den Gerätetyp; ohne Kanal bleibt sie ABWESEND statt
    „gemessen" zu behaupten.

    ⚠ P6: gefragt wird die Entität, die den Ladestand WIRKLICH geliefert hat
    (`soc_source`), nicht mehr die Fluss-Mitglieder. Eine gebundene
    Selbstbau-Batterie ist kein Mitglied - ihre Kilowatt bleiben beim
    Wechselrichter -, also fand die alte Suche ihren Herkunfts-Kanal nie und
    ein gerechneter Ladestand kam hier ungekennzeichnet an. Die Mitglieder
    bleiben der Rückfall für jede Batterie, die den Knoten ohne Bindung speist.
  */
  const quelleId = n.soc_source?.entity_id ?? null;
  const herkunft = herkunftUeberEntitaeten(
    quelleId != null
      ? [byId.get(quelleId)?.capabilities]
      : n.members.map((m) => byId.get(m.entity_id)?.capabilities),
  );
  /*
    P6: WESSEN Ladestand das ist. Nur dann eine eigene Zeile, wenn er von einem
    ANDEREN Gerät kommt als die Kilowatt dieser Kachel - sonst wäre er eine
    Wiederholung des Kachel-Namens.
  */
  const quelleFremd = quelleId != null
    && (n.members.length === 0 || n.members.some((m) => m.entity_id !== quelleId));
  const batt = signedBattery(n);
  const title = n.members.length === 1 ? roleMemberLabel(n, 'storage', byId) : 'Speicher';
  let stateLabel = 'Bereit';
  let stateTone: 'accent' | 'muted' = 'muted';
  let arrow: 'up' | 'down' | undefined;
  let subLine: string | undefined;
  if (soc == null) {
    // V1 (Audit): ein Speicher-Knoten EXISTIERT nur, wenn die Anlage eine
    // Batterie hat - ein fehlender Ladestand heißt also „noch keine Daten",
    // niemals „keine Batterie". Der alte Zweig behauptete das Gegenteil auf
    // beiden echten Anlagen (13,8 kWh / 65 kWh), sobald das Gerät schwieg.
    stateLabel = 'noch keine Daten';
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
    fullTitle: n.members.length === 1 ? fullMemberName(n) : undefined,
    value: numOrNoData(soc, '%', 0),
    stateLabel,
    stateTone,
    arrow,
    socPct: soc == null ? undefined : Math.max(0, Math.min(100, soc)),
    subLine,
    // Ohne Ladestand gibt es nichts, dessen Herkunft man nennen könnte.
    herkunft: soc == null || herkunft == null ? undefined : herkunft.kurz,
    socQuelle: soc != null && quelleFremd
      ? (ladestandVon(n.soc_source?.label) ?? undefined)
      : undefined,
    grenzen: grenzenWort(n) ?? undefined,
  };
}

/**
 * Was das BMS gerade zulässt, in EINEM Satzteil (P6).
 *
 * ⚠ Ein abwesendes Feld wird ÜBERGANGEN, nie als „unbegrenzt" oder „erlaubt"
 * gelesen: eine Batterie, die nur ihre Ladegrenze meldet, sagt nichts über das
 * Entladen - und „Entladen erlaubt" hinzuschreiben wäre eine Freigabe, die
 * niemand gegeben hat.
 */
function grenzenWort(n: FlowNode): string | null {
  const l = n.limits;
  if (!l) return null;
  const teile: string[] = [];
  if (l.charge_allowed === false) teile.push('Laden gesperrt');
  else if (l.charge_limit_a != null) teile.push(`max. ${fmtNum(l.charge_limit_a, 'A', 0)} laden`);
  if (l.discharge_allowed === false) teile.push('Entladen gesperrt');
  else if (l.discharge_limit_a != null) {
    teile.push(`max. ${fmtNum(l.discharge_limit_a, 'A', 0)} entladen`);
  }
  return teile.length === 0 ? null : teile.join(' · ');
}

/** The full, untouched stored name of a single-member role node (for `title`). */
function fullMemberName(n: FlowNode): string | undefined {
  const raw = n.members[0]?.label?.trim();
  return raw || undefined;
}

/** The SHORT generalised header word for a single-member role node. */
function roleMemberLabel(
  n: FlowNode,
  role: Role,
  byId: Map<string, TopologyEntity>,
): string {
  const m = n.members[0];
  const entity = m ? byId.get(m.entity_id) : undefined;
  return shortEntityLabel({
    entityType: entity?.entityType,
    role,
    label: m?.label,
    typeLabel: entity?.typeLabel,
  });
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
    fullTitle: fullMemberName(n),
    value: numOrNoData(n.value_kw, 'kW', 1),
    stateLabel,
    stateTone,
    arrow,
    subLine,
  };
}

/** One tile per consumer entity (each with its own value + read-only switches). */
function consumerTiles(n: FlowNode, byId: Map<string, TopologyEntity>): AdaptiveTile[] {
  // Short generalised words ("Wallbox", "Hausverbrauch", …), kept distinct when
  // several consumers of the same type would collapse to one word.
  const consumerNames = shortLabelsForRole(
    n.members.map((m) => {
      const e = byId.get(m.entity_id);
      return { label: m.label, entityType: e?.entityType, typeLabel: e?.typeLabel };
    }),
    'consumer',
  );
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
      title: consumerNames[i],
      fullTitle: m.label?.trim() || undefined,
      value: m.value_kw == null ? NO_DATA : fmtNum(Math.abs(m.value_kw), 'kW', 1),
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
  if (pv) tiles.push(pvTile(pv, byId));
  const storage = node(topo, 'storage');
  if (storage) tiles.push(storageTile(storage, byId));
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

// --- Freshness ---------------------------------------------------------------

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

// Re-export so components import one module for the role palette.
export { ROLE_META };
