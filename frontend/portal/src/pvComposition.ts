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
 * Honesty rules (kept from `pvSources.ts`):
 *  - a device without an own value is NEVER counted as 0. It is listed with a
 *    plain-German reason, so the parts always add up to what they claim;
 *  - a stale device keeps its last value and says so (freshness dot);
 *  - nothing to explain (fewer than two devices) -> null, and the caller shows
 *    no affordance at all.
 *
 * Pure + framework-free (unit-tested in pvComposition.test.ts).
 */
import type { SiteSource, SiteTopology, TopologyEntity } from './api';
import { deviceName } from './entityLabel';
import { reconcileProducerPv } from './pvReconcile';
import type { FlowMember } from './topology';
import { sourceLabel } from './pvSources';

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
  /** Why `kw` is null, in plain German. null whenever `kw` is a real value. */
  note: string | null;
  /** The verbose stored name, kept for the row's tooltip. */
  title: string;
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
function emptyNote(health: PvHealth, measuredViaInverter: boolean): string {
  if (measuredViaInverter) return 'über den Wechselrichter mitgemessen';
  if (health === 'never') return 'wartet auf erste Daten';
  return 'meldet sich gerade nicht';
}

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
): PvComposition | null {
  if (!topology) return null;
  const rawNode = topology.topology.nodes.find((n) => n.role === PV_ROLE);
  if (!rawNode || rawNode.members.length === 0) return null;

  const native = hasNativeValues(rawNode.members);
  // Branch 2 (interim): reuse the merged, unit-tested reconciliation rather
  // than duplicating or fighting it - it fills each producer from /sources and
  // reduces the hybrid by their sum, so the parts keep summing to the plant.
  const resolved = native ? topology : reconcileProducerPv(topology, sources);
  const node = resolved.topology.nodes.find((n) => n.role === PV_ROLE) ?? rawNode;
  const origin: PvValueOrigin = native ? 'entity' : 'sources';

  const entityById = new Map(resolved.entities.map((e) => [e.id, e] as const));
  const list = sources ?? [];
  const byName = new Map(list.map((s) => [sourceLabel(s), s] as const));
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
    // The device's name comes from ONE derivation over the edge's own naming:
    // the matched `/sources` entry, else - for the hybrid - the primary
    // inverter entry, else the stored entity label.
    const matched = byName.get(m.label ?? '') ?? (isHybrid(entity) ? primary : null);
    const label =
      deviceName({
        edgeLabel: matched?.label,
        brand: matched?.brand,
        model: matched?.model,
        storedLabel: m.label ?? entity?.label,
        typeLabel: entity?.typeLabel,
      }) ?? 'Gerät';
    const health = matched?.health ?? healthOf(entity);
    const title = (m.label ?? entity?.label ?? label).trim() || label;
    const row: PvContribution = {
      key: `${m.entity_id}:${i}`,
      label,
      kw: m.value_kw == null ? null : round3(m.value_kw),
      health,
      note: m.value_kw == null ? emptyNote(health, hybridCarriesTheRest) : null,
      title,
    };
    if (row.kw == null) unmeasured.push(row);
    else parts.push(row);
  });

  const deviceCount = parts.length + unmeasured.length;
  if (deviceCount === 0) return null;
  const totalKw =
    parts.length === 0 ? null : round3(parts.reduce((sum, p) => sum + (p.kw as number), 0));
  return { totalKw, parts, unmeasured, deviceCount, origin };
}

/** The part's share of the total (0..1), for the proportional bar. 0 without a total. */
export function shareOf(part: PvContribution, c: PvComposition): number {
  if (part.kw == null || c.totalKw == null || c.totalKw <= 0) return 0;
  return Math.max(0, Math.min(1, part.kw / c.totalKw));
}
