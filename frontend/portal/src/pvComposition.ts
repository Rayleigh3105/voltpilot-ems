/**
 * What the ONE aggregated „PV-Erzeugung"-Knoten is made of.
 *
 * The energy flow shows a single PV node carrying the site total (owner
 * decision A1, concept `vp-ui-pv-hist-d8`: "wenn man auf PV-Erzeugung klickt,
 * dass es dann Details gibt aus was sich die Erzeugung zusammensetzt"). This
 * module derives BOTH halves from ONE place, so they can never disagree again:
 * the node's total AND the per-inverter rows behind the click. The total is
 * literally the sum of the shown parts - by construction, not by coincidence.
 *
 * Two value sources, in preference order:
 *  1. `entity` - every PV member carries its OWN measured value. This is the
 *     truth once the edge publishes PV per entity.
 *  2. `sources` - the interim reconstruction from the live `/sources` heartbeat
 *     (PR #239 `pvReconcile`): the cloud writer mirrors the edge's COMPOSITE
 *     site PV onto the battery-hybrid entity, so the hybrid alone carries the
 *     whole plant while the separate producers have no series at all.
 *
 * TODO(edge-fanout): once the edge publishes `pv_power_kw` per entity, branch 2
 * and `pvReconcile.ts` are deleted without replacement - branch 1 already
 * handles that world, so this is a deletion, not a rewrite.
 *
 * Honesty rules (kept from `pvSources.ts`, extended by `vp-pin-werte-f8`):
 *  - a device without an own value is NEVER counted as 0. It is listed with a
 *    plain-German reason, so the parts always add up to what they claim;
 *  - a stale device keeps its last value and says so (freshness dot);
 *  - source -> component is matched STRICTLY by the `edgeSourceId` pin. No
 *    order matching, no name matching — those put values on the wrong rows;
 *  - a component whose pin is PROVEN orphaned shows NO current value (its own
 *    state is „nicht mehr verbunden");
 *  - a delivering source no component is pinned to appears as its OWN row (with
 *    its edge label) instead of silently sliding onto the next component. The
 *    role total therefore stays the sum of the SOURCES — physical truth;
 *  - nothing to explain (fewer than two devices) -> null, and the caller shows
 *    no affordance at all.
 *
 * Pure + framework-free (unit-tested in pvComposition.test.ts).
 */
import type { SiteSource, SiteTopology, TopologyEntity } from './api';
import { newestTs } from './datenAlter';
import { deviceName, technicalDeviceName } from './entityLabel';
import {
  reconcileProducerPv,
  orphanedEntityIds,
  producingSourcesById,
  unassignedProducerSources,
  type EntityPin,
} from './pvReconcile';
import type { FlowMember } from './topology';
import { isMeasuredZero, noGenerationNote, sourceLabel } from './pvSources';

const PV_ROLE = 'pv';

/** Where the per-device values came from (see the module docstring). */
export type PvValueOrigin = 'entity' | 'sources';

export type PvHealth = SiteSource['health'];

/** One device contributing to the aggregated PV node. */
export interface PvContribution {
  key: string;
  /** The ONE customer-facing name (`entityLabel.deviceName`). */
  label: string;
  /** Its share in kW, or null when it has no own value (never a fake 0). */
  kw: number | null;
  health: PvHealth;
  /**
   * Why `kw` is null, in plain German — or, on a row that DOES carry a value,
   * why it needs an aside (a delivering device that is not yet assigned to a
   * component: {@link UNASSIGNED_NOTE}).
   */
  note: string | null;
  /**
   * The PRE-ALIAS name, kept as the row's tooltip (R2): whatever the row would
   * be called without the customer's own name - the edge name, else
   * brand + model. So a support call about "Dach Süd" can still be traced to
   * the physical box.
   */
  title: string;
  /**
   * The component this row belongs to, or null on a `src:` row (a delivering
   * source no component is pinned to). The rename pencil hangs off this: a row
   * without a component has no name to give yet - the existing "zuordnen" flow
   * comes first (concept `vp-entity-alias-k1` §5).
   */
  entityId: string | null;
  deviceId: string | null;
  /** The customer's OWN name for this row, or null when they gave none. */
  alias: string | null;
}

export interface PvComposition {
  /** Exactly the sum of `parts` (kW); null when not a single part has a value. */
  totalKw: number | null;
  /** The devices with an own value - `Σ parts.kw === totalKw`. */
  parts: PvContribution[];
  /** Devices without an own value: named with a reason, never a bare "–". */
  unmeasured: PvContribution[];
  /** parts + unmeasured. 1 = nothing to explain. */
  deviceCount: number;
  origin: PvValueOrigin;
  /**
   * Der jüngste Messzeitpunkt der beitragenden Messstellen — die Bezugszeit für
   * den Daten-Alter-Ausweis „Stand: HH:MM" (`datenAlter.ts`). `null`, wenn kein
   * Zeitstempel vorliegt (dann wird keiner erfunden). Die Frische-Punkte der
   * Zeilen färben sich aus `health`, dem zuletzt GEMELDETEN Zustand — der steht
   * grün auf einem stundenalten Datensatz weiter, das Alter kann also nur aus
   * dem Zeitstempel kommen.
   */
  asOf: string | null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function isHybrid(e: TopologyEntity | undefined): boolean {
  return e != null && (e.entityType === 'battery-hybrid' || e.category === 'storage');
}

function healthOf(e: TopologyEntity | undefined): PvHealth {
  switch (e?.health) {
    case 'ok':
      return 'ok';
    case 'stale':
      return 'stale';
    default:
      return 'never';
  }
}

/**
 * The honest empty state - the concept's replacement for the bare "–" circles.
 * A producer whose output is already inside the hybrid's number is NOT broken,
 * and saying so is the whole point.
 */
function emptyNote(health: PvHealth, measuredViaInverter: boolean, orphaned: boolean): string {
  if (orphaned) return 'nicht mehr mit einem gemeldeten Gerät verbunden';
  if (measuredViaInverter) return 'über den Wechselrichter mitgemessen';
  if (health === 'never') return 'wartet auf erste Daten';
  return 'meldet sich gerade nicht';
}

/** The note on a delivering device no component is pinned to. */
export const UNASSIGNED_NOTE = 'noch keiner Komponente zugeordnet';

/**
 * Does every PV member carry its own measured value? Then the topology is
 * already truthful per device and no reconstruction is needed.
 */
function hasNativeValues(members: FlowMember[]): boolean {
  return members.length > 0 && members.every((m) => m.value_kw != null);
}

/**
 * The composition of the site's PV role, or null when it explains nothing
 * (no topology, no PV node, no contributing device).
 *
 * A single-inverter site returns a one-part composition: the caller uses the
 * total but shows no expand affordance (`deviceCount === 1`).
 */
export function pvComposition(
  topology: SiteTopology | null | undefined,
  sources: SiteSource[] | null | undefined,
  pins?: EntityPin[] | null,
): PvComposition | null {
  if (!topology) return null;
  const rawNode = topology.topology.nodes.find((n) => n.role === PV_ROLE);
  if (!rawNode || rawNode.members.length === 0) return null;

  const native = hasNativeValues(rawNode.members);
  // Branch 2 (interim): reuse the merged, unit-tested reconciliation rather
  // than duplicating or fighting it - it fills each producer from the source
  // its PIN names and reduces the hybrid by that sum, so the parts keep summing
  // to the plant.
  const resolved = reconcileProducerPv(topology, native ? null : sources, pins);
  const node = resolved.topology.nodes.find((n) => n.role === PV_ROLE) ?? rawNode;
  const origin: PvValueOrigin = native ? 'entity' : 'sources';

  const entityById = new Map(resolved.entities.map((e) => [e.id, e] as const));
  const list = sources ?? [];
  const sourceById = producingSourcesById(list);
  const orphans = orphanedEntityIds(pins);
  const pinBySource = new Map<string, string>();
  for (const p of pins ?? []) {
    if (p.orphanedPin !== true && p.edgeSourceId != null) pinBySource.set(p.id, p.edgeSourceId);
  }
  const primary = list.find((s) => s.kind === 'primary') ?? null;

  const parts: PvContribution[] = [];
  const unmeasured: PvContribution[] = [];
  // Only meaningful in the reconstructed branch: the hybrid then carries what
  // an unfilled producer would have contributed.
  const hybridCarriesTheRest =
    origin === 'sources' &&
    node.members.some((m) => isHybrid(entityById.get(m.entity_id)) && m.value_kw != null);

  node.members.forEach((m, i) => {
    const entity = entityById.get(m.entity_id);
    const orphaned = orphans.has(m.entity_id);
    const pinnedSourceId = pinBySource.get(m.entity_id) ?? null;
    // The device's name comes from ONE derivation over the edge's own naming:
    // the PINNED `/sources` entry, else - for the hybrid - the primary inverter
    // entry, else the stored entity label. NEVER a name/order lookup.
    const matched = sourceById.get(pinnedSourceId ?? '') ?? (isHybrid(entity) ? primary : null);
    // ⚠ The alias is read from the ENTITY and from the UNRECONCILED member -
    // never from `m.label`. The interim reconstruction rewrites a filled
    // member's label to the SOURCE's edge name (`pvReconcile`:
    // `label: sourceLabel(src)`), so reading it here would quietly replace the
    // customer's own name with the device's, and the rename dialog would
    // prefill with a name they never typed. `rawNode` is the pre-reconcile
    // node; reconcile replaces members in place, so the index still matches.
    const nameInput = {
      edgeLabel: matched?.label,
      brand: matched?.brand,
      model: matched?.model,
      storedLabel: entity?.label ?? rawNode.members[i]?.label,
      typeLabel: entity?.typeLabel,
    };
    const label = deviceName(nameInput) ?? 'Gerät';
    const health = orphaned ? 'never' : (matched?.health ?? healthOf(entity));
    // R2: the tooltip is what the row WOULD be called without the alias, so the
    // physical identity stays reachable. Falls back to the shown name when
    // there is nothing else to say (an alias on a device that reports nothing).
    const title = technicalDeviceName(nameInput) ?? label;
    const row: PvContribution = {
      key: `${m.entity_id}:${i}`,
      label,
      kw: m.value_kw == null ? null : round3(m.value_kw),
      health,
      note: m.value_kw == null ? emptyNote(health, hybridCarriesTheRest && !orphaned, orphaned) : null,
      title,
      entityId: m.entity_id,
      deviceId: pinnedSourceId ?? matched?.sourceId ?? null,
      alias: (nameInput.storedLabel ?? '').trim() || null,
    };
    if (row.kw == null) unmeasured.push(row);
    else parts.push(row);
  });

  // A delivering source no component is pinned to gets its OWN row instead of
  // being merged into a neighbour. Its production still sits inside the
  // hybrid's composite number, so that row is reduced by the same amount —
  // Σ shown rows stays the sum of the SOURCES (physical truth), by construction.
  const unassigned = origin === 'sources' ? unassignedProducerSources(list, pins) : [];
  if (unassigned.length > 0) {
    let rest = unassigned.reduce((s, u) => s + (u.pvKw as number), 0);
    for (const p of parts) {
      if (rest <= 0) break;
      const isHybridPart = node.members.some(
        (m, i) => `${m.entity_id}:${i}` === p.key && isHybrid(entityById.get(m.entity_id)),
      );
      if (!isHybridPart || p.kw == null) continue;
      const take = Math.min(p.kw, rest);
      p.kw = round3(p.kw - take);
      rest -= take;
    }
    for (const u of unassigned) {
      parts.push({
        key: `src:${u.sourceId}`,
        label: deviceName({ edgeLabel: u.label, brand: u.brand, model: u.model }) ?? sourceLabel(u),
        kw: round3(u.pvKw as number),
        health: u.health,
        note: UNASSIGNED_NOTE,
        title: sourceLabel(u),
        // No component yet ⇒ nothing to name. Assign it first.
        entityId: null,
        deviceId: null,
        alias: null,
      });
    }
  }

  const deviceCount = parts.length + unmeasured.length;
  if (deviceCount === 0) return null;
  const totalKw =
    parts.length === 0 ? null : round3(parts.reduce((sum, p) => sum + (p.kw as number), 0));
  // Eine GEMESSENE Null neben produzierenden Geschwistern wird eingeordnet
  // statt als selbstbewusster „0,0 kW" stehen gelassen (Herzogau 17.08.2026);
  // nachts, wenn alle 0 melden, gibt es keine Kennzeichnung. Dieselbe geteilte
  // Regel wie in der v1-Aufteilung - eine Lage, ein Satz. Eine Zeile, die
  // schon einen eigenen Grund trägt (z. B. „noch nicht zugeordnet"), behält
  // ihn: er sagt mehr als die Null.
  const anyGenerating = parts.some((p) => p.kw != null && !isMeasuredZero(p.kw));
  if (anyGenerating) {
    for (const p of parts) {
      if (p.note == null) p.note = noGenerationNote(p.kw, true);
    }
  }
  return {
    totalKw,
    parts,
    unmeasured,
    deviceCount,
    origin,
    asOf: newestTs(list.map((s) => s.readAt ?? s.reportedAt ?? null)),
  };
}

/** The part's share of the total (0..1), for the proportional bar. 0 without a total. */
export function shareOf(part: PvContribution, c: PvComposition): number {
  if (part.kw == null || c.totalKw == null || c.totalKw <= 0) return 0;
  return Math.max(0, Math.min(1, part.kw / c.totalKw));
}
