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
 * The proper fix is edge-side (F3a): the edge publishes each inverter's OWN
 * `pv_power_kw` per entity. Until then this is a **display-only** reconciliation:
 * fill each producer circle from `/sources` (value AND label — F4) and reduce
 * the hybrid circle by the producers' sum, so the circles add up to the same
 * composite total and match the breakdown box. NO data migration, no backend
 * change.
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

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function isProducer(e: TopologyEntity): boolean {
  return e.entityType === 'producer' || e.category === 'producer';
}

function isHybrid(e: TopologyEntity): boolean {
  return e.entityType === 'battery-hybrid' || e.category === 'storage';
}

/** The additional (non-primary) PV parts from `/sources`, in report order. */
function producerParts(sources: SiteSource[]): Array<{ kw: number; label: string }> {
  return sources
    .filter(
      (s) =>
        s.kind !== 'primary' &&
        s.role !== 'grid-meter' &&
        s.role !== 'consumer' &&
        s.pvKw != null &&
        s.health !== 'never',
    )
    .map((s) => ({ kw: s.pvKw as number, label: sourceLabel(s) }));
}

/**
 * Return the topology with the PV node's producer circles filled from `/sources`
 * (value + label) and the hybrid circle reduced by their sum, so the flow adds
 * up to the same composite total and matches the breakdown box.
 *
 * A no-op (returns the input unchanged) whenever there is nothing to fix: no
 * sources, no PV node, no producer member with a MISSING value (the edge already
 * splits per entity), or no usable `/sources` producer reading. Members are
 * matched to `/sources` parts by order — the topology read-model does not carry
 * the `edgeSourceId` link, and using the `/sources` label+value as ONE coherent
 * pair per circle keeps every circle honest regardless of that order.
 */
export function reconcileProducerPv(
  topology: SiteTopology,
  sources: SiteSource[] | null | undefined,
): SiteTopology {
  if (!sources || sources.length === 0) return topology;
  const pvNode = topology.topology.nodes.find((n) => n.role === PV_ROLE);
  if (!pvNode) return topology;

  const entityById = new Map(topology.entities.map((e) => [e.id, e] as const));
  const producerIdx: number[] = [];
  pvNode.members.forEach((m, i) => {
    const e = entityById.get(m.entity_id);
    if (e && isProducer(e) && m.value_kw == null) producerIdx.push(i);
  });
  if (producerIdx.length === 0) return topology;

  const parts = producerParts(sources);
  if (parts.length === 0) return topology;

  const members: FlowMember[] = pvNode.members.map((m) => ({ ...m }));
  let assignedSum = 0;
  producerIdx.forEach((idx, k) => {
    const part = parts[k];
    if (!part) return; // fewer /sources parts than producer circles: leave "–".
    members[idx] = { ...members[idx], value_kw: round3(part.kw), label: part.label };
    assignedSum += part.kw;
  });
  if (assignedSum === 0) return topology;

  // Reduce the hybrid so the circles still sum to the composite total.
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

  const nodes = topology.topology.nodes.map((n) =>
    n === pvNode ? { ...n, members } : n,
  );
  return { ...topology, topology: { ...topology.topology, nodes } };
}
