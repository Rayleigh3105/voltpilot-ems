/**
 * F3 (display-only interim) + F4 (one naming scheme) — reconcile the energy-flow
 * PV circles with the per-source breakdown (`/sources`), on a migrated
 * multi-inverter plant.
 *
 * The bug it fixes (diagnosis `vp-hist-diag-m4`, Symptom 2): the cloud writer
 * (MIG-B1 `ComposedEntityFanout`) mirrors the edge's COMPOSITE site PV
 * (`primary + Σ producers`) onto the battery-hybrid entity's `pv_power_kw`. So
 * the hybrid flow circle carries the WHOLE plant's PV (70,3 kW) while each
 * separate Fronius producer entity — which has no telemetry_v2 of its own —
 * shows "–". The three PV circles then contradict the breakdown box (Deye 23,9
 * + Fronius 19,9 + Fronius 26,6), which reads the honest `/sources` split.
 *
 * **Matching is STRICTLY pin-based (`vp-pin-werte-f8`).** Until this fix the
 * producer circles were filled from the `/sources` list BY ORDER, which put the
 * values on the wrong rows the moment the two lists disagreed — the captain's
 * Pilsting proof: the ORPHANED component („Fronius WR1", whose pin points at a
 * source that no longer exists) showed 20,1 kW while the ghost whose pin points
 * at the DELIVERING source showed "–". A component is now filled from exactly
 * the source its `edgeSourceId` pin names, or from nothing at all. Order- and
 * name-matching are gone without replacement.
 *
 * Two honesty rules ride along:
 *  - a component whose pin is PROVEN orphaned (`orphanedPin === true`) never
 *    carries a current value: its own state is „nicht mehr verbunden", so a
 *    value would contradict the row itself;
 *  - a producing source that no component is pinned to is NOT silently merged
 *    into a neighbouring row — it is returned by {@link unassignedProducerSources}
 *    so the caller can name it (with its edge label) instead.
 *
 * The proper fix is edge-side (F3a): the edge publishes each inverter's OWN
 * `pv_power_kw` per entity. Until then this is a **display-only** reconciliation.
 * NO data migration, no backend change.
 *
 * TODO(F3a): remove this once the edge publishes per-entity PV — the topology
 * member values would then already be truthful.
 *
 * Pure + framework-free (unit-tested in pvReconcile.test.ts).
 */
import type { SiteSource, SiteTopology, TopologyEntity } from './api';
import type { FlowMember } from './topology';
import { sourceLabel } from './pvSources';

const PV_ROLE = 'pv';

/**
 * The pin facts of one v2 entity — structurally a subset of `SiteEntity`, so a
 * caller just passes the `/entities` list. This is the ONLY link between a
 * component and the edge-reported device that measures it.
 */
export interface EntityPin {
  id: string;
  /** The edge source this entity was adopted from, else null (composed). */
  edgeSourceId?: string | null;
  /** true = the pinned source vanished from the device's report. */
  orphanedPin?: boolean | null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function isProducer(e: TopologyEntity): boolean {
  return e.entityType === 'producer' || e.category === 'producer';
}

function isHybrid(e: TopologyEntity): boolean {
  return e.entityType === 'battery-hybrid' || e.category === 'storage';
}

/** An ADDITIONAL measurement point that is actually delivering PV right now. */
function isProducingSource(s: SiteSource): boolean {
  return (
    s.kind !== 'primary' &&
    s.role !== 'grid-meter' &&
    s.role !== 'consumer' &&
    s.pvKw != null &&
    s.health !== 'never'
  );
}

/** The delivering additional PV sources, keyed by their edge source id. */
export function producingSourcesById(
  sources: SiteSource[] | null | undefined,
): Map<string, SiteSource> {
  const idx = new Map<string, SiteSource>();
  for (const s of sources ?? []) if (isProducingSource(s)) idx.set(s.sourceId, s);
  return idx;
}

/** entity id -> the edge source it is pinned to (orphaned pins excluded). */
function livePinByEntity(pins: EntityPin[] | null | undefined): Map<string, string> {
  const idx = new Map<string, string>();
  for (const p of pins ?? []) {
    if (p.orphanedPin === true) continue;
    if (p.edgeSourceId != null) idx.set(p.id, p.edgeSourceId);
  }
  return idx;
}

/** The entity ids whose pin is PROVEN orphaned — they never show a value. */
export function orphanedEntityIds(pins: EntityPin[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const p of pins ?? []) if (p.orphanedPin === true) out.add(p.id);
  return out;
}

/**
 * The delivering PV sources NO component is pinned to. They are real production
 * that must never slide onto a neighbouring row — the caller names them with
 * their own edge label instead (`pvComposition` lists them as „noch keinem
 * Gerät zugeordnet").
 */
export function unassignedProducerSources(
  sources: SiteSource[] | null | undefined,
  pins: EntityPin[] | null | undefined,
): SiteSource[] {
  const pinned = new Set(livePinByEntity(pins).values());
  return [...producingSourcesById(sources).values()].filter((s) => !pinned.has(s.sourceId));
}

/**
 * Return the topology with each producer circle filled from the source its
 * component's `edgeSourceId` pin names (value + label) and the hybrid circle
 * reduced by the sum of what was moved out of it — so the circles still add up
 * to the same composite total.
 *
 * A no-op (returns the input unchanged) whenever there is nothing to fix: no
 * sources, no PV node, no pinned producer with a MISSING value (the edge already
 * splits per entity), no orphaned member carrying a value.
 *
 * The `pins` come from `GET /sites/{id}/entities` (`SiteEntity.edgeSourceId` /
 * `orphanedPin`). Without them NOTHING is assigned — that is deliberate: a
 * guess by position is exactly the defect this module was rewritten to remove.
 */
export function reconcileProducerPv(
  topology: SiteTopology,
  sources: SiteSource[] | null | undefined,
  pins: EntityPin[] | null | undefined,
): SiteTopology {
  const pvNode = topology.topology.nodes.find((n) => n.role === PV_ROLE);
  if (!pvNode) return topology;

  const entityById = new Map(topology.entities.map((e) => [e.id, e] as const));
  const orphans = orphanedEntityIds(pins);
  const pinByEntity = livePinByEntity(pins);
  const sourceById = producingSourcesById(sources);

  const members: FlowMember[] = pvNode.members.map((m) => ({ ...m }));
  let changed = false;
  let assignedSum = 0;

  members.forEach((m, idx) => {
    // Honesty rule: a proven orphan's state is „nicht mehr verbunden" — a
    // current value would contradict its own row (the captain's 20,1 kW).
    if (orphans.has(m.entity_id)) {
      if (m.value_kw != null) {
        const { value_kw: _drop, ...rest } = m;
        members[idx] = rest;
        changed = true;
      }
      return;
    }
    if (m.value_kw != null) return; // the edge already split this one per entity
    const e = entityById.get(m.entity_id);
    if (!e || !isProducer(e)) return;
    const src = sourceById.get(pinByEntity.get(m.entity_id) ?? '');
    if (!src) return; // no pin, or its source is not delivering → stays "–"
    members[idx] = { ...m, value_kw: round3(src.pvKw as number), label: sourceLabel(src) };
    assignedSum += src.pvKw as number;
    changed = true;
  });

  if (!changed) return topology;

  // Reduce the hybrid by exactly what was broken out of it, so the circles keep
  // summing to the composite the edge reported.
  if (assignedSum > 0) {
    const hybridIdx = members.findIndex((m) => {
      const e = entityById.get(m.entity_id);
      return e != null && isHybrid(e);
    });
    if (hybridIdx >= 0 && members[hybridIdx].value_kw != null) {
      members[hybridIdx] = {
        ...members[hybridIdx],
        value_kw: Math.max(0, round3((members[hybridIdx].value_kw as number) - assignedSum)),
      };
    }
  }

  const nodes = topology.topology.nodes.map((n) => (n === pvNode ? { ...n, members } : n));
  return { ...topology, topology: { ...topology.topology, nodes } };
}
