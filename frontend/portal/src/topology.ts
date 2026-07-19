/**
 * Shared derivation of the Anlagen-Topologie-Read-Model (AE1, contract
 * docs/contracts/v2/topology-read-model.md): the ONE pure function that turns
 * {resolved capabilities + live values} into the role-grouped hub topology the
 * adaptive energy-flow diagram (AE2) renders. This TS twin MUST stay
 * byte-identical to the Go copy (edge-app/core/internal/topology) on the shared
 * vectors (docs/contracts/v2/topology-vectors.json - the jcs-vectors
 * precedent), so the portal and the edge draw the identical picture. The portal
 * feeds this the cloud read-model's already-resolved entities + live values.
 */

/** Below this magnitude a spoke counts as idle (the live.ts 0.05 kW deadband). */
export const DEADBAND_KW = 0.05;

export const SCHEMA_VERSION = '1.0';

export type Role = 'pv' | 'storage' | 'consumer' | 'grid';

/** Canonical node emission order. */
const CANONICAL_ROLE_ORDER: Role[] = ['pv', 'storage', 'consumer', 'grid'];

/** The one channel treated as a SoC input (never a flow member). */
const SOC_CHANNEL = 'soc_pct';

export interface CapabilityInput {
  channel: string;
  /** Resolved role; '' = unassigned/informational (skipped). */
  role: string;
  primary: boolean;
  /** Latest live value; null = unknown (never a fabricated 0). */
  value: number | null;
}

export interface EntityInput {
  id: string;
  type: string;
  label: string;
  category: string;
  health: string;
  capabilities: CapabilityInput[];
}

export interface Input {
  entities: EntityInput[];
}

export interface FlowMember {
  entity_id: string;
  label: string;
  primary: boolean;
  value_kw?: number;
}

export interface FlowNode {
  role: Role;
  value_kw?: number;
  soc_pct?: number;
  flow_active: boolean;
  direction?: 'in' | 'out';
  members: FlowMember[];
}

export interface Topology {
  schema_version: string;
  nodes: FlowNode[];
}

/**
 * Default role for a measure channel + entity category (overridable in the
 * cloud; the edge/pilot run on defaults). category is
 * storage|producer|meter|consumer; the edge's "measure-only" aliases "meter".
 */
export function defaultRole(category: string, channel: string): string {
  switch (channel) {
    case 'pv_power_kw':
      return 'pv';
    case 'battery_power_kw':
    case SOC_CHANNEL:
      return 'storage';
    case 'power_kw':
      switch (category) {
        case 'storage':
          return 'storage';
        case 'producer':
          return 'pv';
        case 'consumer':
          return 'consumer';
        case 'meter':
        case 'measure-only':
          return 'grid';
      }
  }
  return '';
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

interface RoleCap {
  entity: EntityInput;
  cap: CapabilityInput;
}

function member(rc: RoleCap): FlowMember {
  // Key order matches the Go FlowMember struct (entity_id, label, primary,
  // value_kw) so JSON.stringify is byte-identical across the two twins.
  const m: FlowMember = { entity_id: rc.entity.id, label: rc.entity.label, primary: rc.cap.primary };
  if (rc.cap.value != null) m.value_kw = round3(rc.cap.value);
  return m;
}

/**
 * Assemble a FlowNode inserting keys in the canonical order (role, value_kw,
 * soc_pct, flow_active, direction, members) that Go's json.Marshal emits, so
 * JSON.stringify(node) is byte-identical to the Go twin.
 */
function makeNode(
  role: Role,
  valueKw: number | undefined,
  socPct: number | undefined,
  flowActive: boolean,
  direction: 'in' | 'out' | undefined,
  members: FlowMember[],
): FlowNode {
  const n = { role } as FlowNode;
  if (valueKw !== undefined) n.value_kw = valueKw;
  if (socPct !== undefined) n.soc_pct = socPct;
  n.flow_active = flowActive;
  if (direction) n.direction = direction;
  n.members = members;
  return n;
}

/** pv / consumer: value = |Σ flow members|, direction fixed by role. */
function sumNode(role: Role, caps: RoleCap[]): FlowNode {
  const members: FlowMember[] = [];
  let sum = 0;
  let hasValue = false;
  for (const rc of caps) {
    if (rc.cap.channel === SOC_CHANNEL) continue;
    members.push(member(rc));
    if (rc.cap.value != null) {
      sum += rc.cap.value;
      hasValue = true;
    }
  }
  if (!hasValue) return makeNode(role, undefined, undefined, false, undefined, members);
  const mag = round3(Math.abs(sum));
  const active = mag > DEADBAND_KW;
  const dir = active ? (role === 'consumer' ? 'out' : 'in') : undefined;
  return makeNode(role, mag, undefined, active, dir, members);
}

/** storage: Σ measured battery power + SoC from the primary (else first). */
function storageNode(role: Role, caps: RoleCap[]): FlowNode {
  const members: FlowMember[] = [];
  let sum = 0;
  let hasValue = false;
  let soc: number | undefined;
  let socPrimary = false;
  for (const rc of caps) {
    if (rc.cap.channel === SOC_CHANNEL) {
      if (rc.cap.value == null) continue;
      if (soc === undefined || (rc.cap.primary && !socPrimary)) {
        soc = round3(rc.cap.value);
        socPrimary = rc.cap.primary;
      }
      continue;
    }
    members.push(member(rc));
    if (rc.cap.value != null) {
      sum += rc.cap.value;
      hasValue = true;
    }
  }
  if (!hasValue) return makeNode(role, undefined, soc, false, undefined, members);
  const mag = round3(Math.abs(sum));
  const active = mag > DEADBAND_KW;
  // charge (+) -> hub->battery (out), discharge (-) -> battery->hub (in).
  const dir = active ? (sum > 0 ? 'out' : 'in') : undefined;
  return makeNode(role, mag, soc, active, dir, members);
}

/** grid: the maßgebliche (primary, else first) member's SIGNED value, never a sum. */
function gridNode(role: Role, caps: RoleCap[]): FlowNode {
  const members: FlowMember[] = [];
  let primaryIdx = -1;
  caps.forEach((rc, i) => {
    members.push(member(rc));
    if (primaryIdx === -1 && rc.cap.primary) primaryIdx = i;
  });
  if (primaryIdx === -1 && caps.length > 0) primaryIdx = 0;
  if (primaryIdx === -1) return makeNode(role, undefined, undefined, false, undefined, members);
  const v = caps[primaryIdx].cap.value;
  if (v == null) return makeNode(role, undefined, undefined, false, undefined, members);
  const mag = round3(Math.abs(v));
  const active = mag > DEADBAND_KW;
  // import (Bezug, +) -> in, export (-) -> out.
  const dir = active ? (v > 0 ? 'in' : 'out') : undefined;
  return makeNode(role, mag, undefined, active, dir, members);
}

/**
 * Derive the hub topology. Pure + deterministic: roles in canonical order,
 * members in input order, kW rounded to 3 decimals, absent values never
 * coerced to 0. See topology-read-model.md.
 */
export function derive(input: Input): Topology {
  const buckets = new Map<string, RoleCap[]>();
  for (const entity of input.entities) {
    for (const cap of entity.capabilities) {
      if (cap.role === '') continue;
      const list = buckets.get(cap.role);
      if (list) list.push({ entity, cap });
      else buckets.set(cap.role, [{ entity, cap }]);
    }
  }
  const nodes: FlowNode[] = [];
  for (const role of CANONICAL_ROLE_ORDER) {
    const caps = buckets.get(role);
    if (!caps) continue;
    if (role === 'grid') nodes.push(gridNode(role, caps));
    else if (role === 'storage') nodes.push(storageNode(role, caps));
    else nodes.push(sumNode(role, caps));
  }
  return { schema_version: SCHEMA_VERSION, nodes };
}
