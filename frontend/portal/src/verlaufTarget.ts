/**
 * Cockpit-Kachel → Absprung-Ziel (design `data/vp-portal-livedata-design/report.md`
 * §1 „Cockpit → explorer jump" + §4 V2).
 *
 * „Eine Kachel ist ein Absprung": ein Tipp navigiert, es gibt kein Modal mehr.
 * Dieses reine Modul entscheidet, WOHIN — entweder auf einen Messwert im
 * Verlauf-Explorer (`{kind:'verlauf', entityId, channel}`) oder auf eine
 * bestehende Seite (`{kind:'sub', sub}`). Es rechnet nichts nach: die Fluss-
 * Kacheln werden über DIESELBE Rollen-Auflösung aufgelöst, die auch die
 * Topologie nutzt (maßgeblich zuerst, sonst die erste ihrer Rolle — der
 * `topology.ts gridNode`/`storageNode`-Präzedenzfall), die Geld-/Modus-Kacheln
 * bilden per Tabelle auf ihre Zielseite ab.
 *
 * Die Abbildung (report §1):
 *   Erzeugung  → `pv_power_kw` der PV-messenden Komponente (Multi-Erzeuger: die
 *                summierende/maßgebliche; die übrigen erreicht die Rail)
 *   Speicher   → `soc_pct`
 *   Haus       → Hauslast `power_kw`
 *   Netz       → Netzzähler `power_kw` (maßgeblich)
 *   Eigenverbrauch/Erlöse → Historie · Bilanz
 *   Handel     → Fahrplan · Lastspitze → Lastspitzen · Automatik → Steuerung ·
 *   Wetter     → Wetter
 */
import type { EarningsRange, SiteTopology, TopologyCapability, TopologyEntity } from './api';
import type { AnlagenSub } from './nav';
import type { VerlaufRange } from './verlauf';
import type { WidgetId } from './cockpitWidgets';

/** Wohin eine Kachel springt: ein Messwert im Explorer, oder eine Seite. */
export type WidgetTarget =
  | { kind: 'verlauf'; entityId: string; channel: string }
  | { kind: 'sub'; sub: AnlagenSub };

/** Der Entitätstyp der Hauslast — die „Haus"-Kachel meint genau ihn. */
const HOUSE_LOAD_TYPE = 'house-load';

/** Die Geld-/Modus-Kacheln bilden fest auf ihre bestehende Zielseite ab. */
const SUB_TARGETS: Partial<Record<WidgetId, AnlagenSub>> = {
  eigenverbrauch: 'historie',
  erloes: 'historie',
  handel: 'fahrplan',
  lastspitze: 'lastspitzen',
  automatik: 'steuerung',
  wetter: 'wetter',
};

/**
 * Der maßgebliche Messwert einer Rolle: die erste passende Capability, die als
 * `primary` markiert ist, sonst die erste passende überhaupt — genau die
 * „maßgeblich, sonst erste"-Regel der Topologie-Ableitung. Null, wenn nichts
 * passt (kein Read-Model, Kanal (noch) nicht vorhanden).
 */
function resolveCap(
  topology: SiteTopology,
  match: (entity: TopologyEntity, cap: TopologyCapability) => boolean,
): { entityId: string; channel: string } | null {
  let first: { entityId: string; channel: string } | null = null;
  for (const e of topology.entities) {
    for (const c of e.capabilities) {
      if (!match(e, c)) continue;
      const t = { entityId: e.id, channel: c.channel };
      if (c.primary) return t;
      if (!first) first = t;
    }
  }
  return first;
}

/** Der Verlauf-Messwert einer Fluss-Kachel, oder null (keine Fluss-Kachel / nicht auflösbar). */
function flowTarget(
  id: WidgetId,
  topology: SiteTopology | null,
): { entityId: string; channel: string } | null {
  if (!topology) return null;
  switch (id) {
    case 'erzeugung':
      return resolveCap(topology, (_e, c) => c.role === 'pv' && c.channel === 'pv_power_kw');
    case 'speicher':
      return resolveCap(topology, (_e, c) => c.role === 'storage' && c.channel === 'soc_pct');
    case 'netz':
      return resolveCap(topology, (_e, c) => c.role === 'grid' && c.channel === 'power_kw');
    case 'haus':
      return resolveCap(topology, (e, c) => e.entityType === HOUSE_LOAD_TYPE && c.channel === 'power_kw');
    default:
      return null;
  }
}

/**
 * Das Absprung-Ziel einer Kachel. Fluss-Kacheln lösen über die Topologie auf;
 * gelingt das nicht (kein Read-Model, Kanal fehlt), führt der ehrliche Fallback
 * auf die Live-Daten-Seite — dort stehen dieselben Messwerte live. Geld-/Modus-
 * Kacheln bilden auf ihre bestehende Seite ab.
 */
export function widgetTarget(id: WidgetId, topology: SiteTopology | null): WidgetTarget {
  const flow = flowTarget(id, topology);
  if (flow) return { kind: 'verlauf', entityId: flow.entityId, channel: flow.channel };
  const sub = SUB_TARGETS[id];
  if (sub) return { kind: 'sub', sub };
  // Eine Fluss-Kachel ohne auflösbaren Messwert: die Live-Daten-Seite zeigt
  // denselben Wert live (nie ein erfundenes Ziel).
  return { kind: 'sub', sub: 'live' };
}

/**
 * Zeitraum-Übernahme aus dem Cockpit-Tab (`EarningsRange`) in den Explorer-
 * Zeitraum (`VerlaufRange`/`HistoryRange`): Heute→Tag, Monat→Monat, Jahr→Jahr,
 * **Gesamt→Jahr** (der Explorer hat keinen All-Zeit-Bereich; der `historyRange
 * ForCockpit`-Präzedenzfall, hier aber „Gesamt" auf Jahr statt auf null).
 */
export function verlaufRangeForCockpit(range: EarningsRange): VerlaufRange {
  switch (range) {
    case 'day':
      return 'day';
    case 'month':
      return 'month';
    case 'year':
      return 'year';
    default:
      return 'year';
  }
}
