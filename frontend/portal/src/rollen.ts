/**
 * Pure, unit-tested derivations for the U2 "Geräte" area (design
 * data/vp-ems-ui-overhaul/report.md §3): the "Rollen & Zuordnung" boxes, the
 * per-card role pills, and the "Vom Gerät gemeldet" adoption suggestions.
 * Components only render what these functions decide - the exhaustive state
 * coverage lives here (the entities.ts / topology.ts pattern).
 *
 * A role assignment is presentation-level and never widens control (guards /
 * arbitration key on capabilities, not roles), which is why the customer may
 * set it (src/api.ts setTopologyRoles). The default state (no override) is the
 * shared DefaultRole mapping - shown as "automatisch zugeordnet", never blank.
 */
import type {
  EntityLocalSetup,
  SiteTopology,
  TopologyEntity,
  TopologyRoleAssignment,
} from './api';
import { isPlatformAdmin } from './auth';
import { channelLabel } from './channels';
import { deviceName } from './entityLabel';
import { defaultRole } from './topology';

/**
 * Portal v3 · M7 — THE single decision for whether the technical/installer
 * layer is shown on the (otherwise customer-facing) Anlagen pages: the entity
 * type badges, raw channels, guard bands, the registry Soll/Ist sync + drift,
 * and the adoption plumbing. Every technical panel gates on THIS helper and
 * nothing else, so the customer view stays free of `Entität`/`Messpunkt`/
 * `Quelle` while a platform-admin sees the same pages with the extra panels
 * added on top (M7 goal: "two views, one product").
 *
 * Owner decision (M7): admin-only for now, no separate installer role. When
 * that role arrives it plugs in HERE — one line, one place — and every panel
 * inherits it without another role check leaking into a page.
 */
export function showTechnicalLayer(): boolean {
  return isPlatformAdmin();
}

export type Role = 'pv' | 'storage' | 'grid' | 'consumer';

/** Canonical role order (matches the topology deriver / the AE0 mockup). */
export const ROLE_ORDER: Role[] = ['pv', 'storage', 'grid', 'consumer'];

/** German role labels (the AE0-mockup headings). */
export const ROLE_LABELS: Record<Role, string> = {
  pv: 'PV-Erzeugung',
  storage: 'Speicher',
  grid: 'Netz',
  consumer: 'Verbraucher',
};

const SOC_CHANNEL = 'soc_pct';

/** One member of a role box: an entity capability assigned to that role. */
export interface RoleMember {
  entityId: string;
  entityLabel: string;
  channel: string;
  unit: string | null;
  primary: boolean;
  value: number | null;
  /** State-of-charge (percent, not kW) - rendered specially. */
  isSoc: boolean;
  /** The channel's plain-German label ("Ladestand", "Batterieleistung", …). */
  channelLabel: string;
  /**
   * True when the SAME device contributes several measurements to this role -
   * then the channel label is what tells the two rows apart (a hybrid inverter
   * feeds Speicher with both `soc_pct` and `battery_power_kw`, which otherwise
   * rendered as two identical "Batteriespeicher (Hybrid-Wechselrichter)" rows).
   * False when the device name alone is unambiguous - the box stays calm.
   */
  needsChannelLabel: boolean;
}

/** One "Rollen & Zuordnung" box (the AE0 right column, one per role). */
export interface RoleBox {
  role: Role;
  label: string;
  members: RoleMember[];
  /** The role's aggregate power (from the derived hub node), or null. */
  sumKw: number | null;
  /** Storage only: the SoC of the maßgebliche/first battery. */
  socPct: number | null;
  direction: 'in' | 'out' | null;
  active: boolean;
}

/** A human label for an entity (label else type label else id). */
function entityLabel(e: TopologyEntity): string {
  return e.label ?? e.typeLabel ?? e.id;
}

/**
 * The role boxes for "Rollen & Zuordnung": one per role that has members, in
 * canonical order, with member chips (per capability), the Σ aggregate + SoC +
 * direction taken from the server-derived hub node (so the numbers agree with
 * the energy-flow diagram exactly).
 */
export function roleBoxes(topology: SiteTopology): RoleBox[] {
  const nodeByRole = new Map<string, SiteTopology['topology']['nodes'][number]>();
  for (const node of topology.topology.nodes) {
    nodeByRole.set(node.role, node);
  }
  const boxes: RoleBox[] = [];
  for (const role of ROLE_ORDER) {
    const members: RoleMember[] = [];
    for (const e of topology.entities) {
      for (const cap of e.capabilities) {
        if (cap.role !== role) continue;
        members.push({
          entityId: e.id,
          entityLabel: entityLabel(e),
          channel: cap.channel,
          unit: cap.unit,
          primary: cap.primary,
          value: cap.value,
          isSoc: cap.channel === SOC_CHANNEL,
          channelLabel: channelLabel(cap.channel),
          // Resolved below, once the whole box is known.
          needsChannelLabel: false,
        });
      }
    }
    if (members.length === 0) continue;
    // A device that appears more than once in this role needs its channel
    // label to stay distinguishable (G5); a single-row device does not.
    const perEntity = new Map<string, number>();
    for (const m of members) perEntity.set(m.entityId, (perEntity.get(m.entityId) ?? 0) + 1);
    for (const m of members) m.needsChannelLabel = (perEntity.get(m.entityId) ?? 0) > 1;
    const node = nodeByRole.get(role);
    boxes.push({
      role,
      label: ROLE_LABELS[role],
      members,
      sumKw: node?.value_kw ?? null,
      socPct: node?.soc_pct ?? null,
      direction: node?.direction ?? null,
      active: node?.flow_active ?? false,
    });
  }
  return boxes;
}

/** One role pill on an entity card ("Ihre Geräte"). */
export interface RolePill {
  role: Role;
  label: string;
  primary: boolean;
}

/**
 * The distinct roles an entity's capabilities resolve to, for its card's role
 * pills. A hybrid inverter shows several (PV + Speicher); primary = maßgeblich.
 */
export function rolePillsFor(entityId: string, topology: SiteTopology): RolePill[] {
  const entity = topology.entities.find((e) => e.id === entityId);
  if (!entity) return [];
  const seen = new Map<Role, boolean>();
  for (const cap of entity.capabilities) {
    if (cap.role == null || !ROLE_ORDER.includes(cap.role as Role)) continue;
    const role = cap.role as Role;
    seen.set(role, (seen.get(role) ?? false) || cap.primary);
  }
  return ROLE_ORDER.filter((r) => seen.has(r)).map((role) => ({
    role,
    label: ROLE_LABELS[role],
    primary: seen.get(role) ?? false,
  }));
}

/** A capability that could be assigned INTO a role (not already in it). */
export interface AssignableCapability {
  entityId: string;
  entityLabel: string;
  channel: string;
  /** The channel's plain-German label (never the raw identifier in copy). */
  channelLabel: string;
  currentRole: Role | null;
}

/**
 * The capabilities NOT already assigned to {@code role} - the "＋ zuordnen"
 * picker for that box. SoC is excluded (it always belongs to Speicher).
 */
export function assignableCapabilities(
  topology: SiteTopology,
  role: Role,
): AssignableCapability[] {
  const out: AssignableCapability[] = [];
  for (const e of topology.entities) {
    for (const cap of e.capabilities) {
      if (cap.channel === SOC_CHANNEL) continue;
      if (cap.role === role) continue;
      out.push({
        entityId: e.id,
        entityLabel: entityLabel(e),
        channel: cap.channel,
        channelLabel: channelLabel(cap.channel),
        currentRole:
          cap.role != null && ROLE_ORDER.includes(cap.role as Role) ? (cap.role as Role) : null,
      });
    }
  }
  return out;
}

/**
 * True when every capability resolves to its DefaultRole mapping - i.e. no
 * manual override is in effect, so the section shows "automatisch zugeordnet".
 * (A primary-only change is intentionally not counted here; the caption is
 * about role assignment.)
 */
export function isAutoAssigned(topology: SiteTopology): boolean {
  for (const e of topology.entities) {
    for (const cap of e.capabilities) {
      const resolved = cap.role ?? '';
      if (resolved !== defaultRole(e.entityType, e.category, cap.channel, e.connection ?? '')) {
        return false;
      }
    }
  }
  return true;
}

/** The PUT payload that assigns one capability to a role. */
export function assignToRole(
  entityId: string,
  channel: string,
  role: Role,
): TopologyRoleAssignment[] {
  return [{ entityId, channel, role, primary: false }];
}

/** The PUT payload that makes one capability the maßgebliche member of its role. */
export function setPrimaryAssignment(
  entityId: string,
  channel: string,
  role: Role,
): TopologyRoleAssignment[] {
  return [{ entityId, channel, role, primary: true }];
}

/**
 * The PUT payload that resets EVERY capability to its default role (blank role
 * clears the override; clearing a non-existent one is a harmless no-op) - the
 * "Automatisch zuordnen" button.
 */
export function resetAssignments(topology: SiteTopology): TopologyRoleAssignment[] {
  const out: TopologyRoleAssignment[] = [];
  for (const e of topology.entities) {
    for (const cap of e.capabilities) {
      out.push({ entityId: e.id, channel: cap.channel, role: '', primary: false });
    }
  }
  return out;
}

// ---- "Vom Gerät gemeldet" adoption bridge (§3.3) ---------------------------

/** German label for a reported source role. */
export function sourceRoleLabel(role: string | null): string {
  switch (role) {
    case 'pv-generation':
      return 'Erzeuger (PV)';
    case 'grid-meter':
      return 'Netz-Zähler';
    case 'consumer':
      return 'Verbraucher';
    default:
      return 'Energiequelle';
  }
}

/** EV-charger brands that map a consumer source to a wallbox entity. */
const WALLBOX_BRANDS = ['go-e', 'goe', 'keba', 'alfen', 'wallbe', 'easee', 'abl', 'mennekes'];

/**
 * Suggest the catalog entity type for an adopted source (type from role+brand,
 * report §3.3). null = no confident suggestion (the admin picks in the drawer).
 */
export function suggestEntityType(role: string | null, brand: string | null): string | null {
  switch (role) {
    case 'pv-generation':
      return 'producer';
    case 'grid-meter':
      return 'grid-meter';
    case 'consumer': {
      const b = (brand ?? '').toLowerCase();
      return WALLBOX_BRANDS.some((w) => b.includes(w)) ? 'wallbox' : 'generic-load';
    }
    default:
      return null;
  }
}

/**
 * A one-line summary of a reported source: the ONE `entityLabel.deviceName`
 * chain (operator name > brand + short model), never a raw-token join - the
 * old "brand · label" concatenation put catalog ids like `fronius_sunspec`
 * in front of the customer (scout vp-vier-erzeuger-p9).
 */
export function sourceSummary(source: EntityLocalSetup): string {
  return (
    deviceName({ edgeLabel: source.label, brand: source.brand, model: source.model }) ?? source.id
  );
}

/** One adoptable source in "Vom Gerät gemeldet". */
export interface AdoptableSource {
  id: string;
  role: string | null;
  brand: string | null;
  model: string | null;
  label: string | null;
  roleLabel: string;
  summary: string;
  suggestedType: string | null;
}

/**
 * Edge-reported SOURCES with no matching entity yet (kind='source', not yet
 * adopted) - the "Vom Gerät gemeldet" list. The primary inverter (kind
 * 'inverter') is not adoptable here (it comes from the battery editor +
 * bootstrap) - see {@link inverterSetup}.
 */
export function adoptableSources(localSetup: EntityLocalSetup[]): AdoptableSource[] {
  return localSetup
    .filter((l) => l.kind === 'source' && l.adoptedEntityId == null)
    .map((l) => ({
      id: l.id,
      role: l.role,
      brand: l.brand,
      model: l.model ?? null,
      label: l.label,
      roleLabel: sourceRoleLabel(l.role),
      summary: sourceSummary(l),
      suggestedType: suggestEntityType(l.role, l.brand),
    }));
}

/** Edge-reported sources ALREADY adopted into an entity (rendered "übernommen"). */
export function adoptedSources(localSetup: EntityLocalSetup[]): EntityLocalSetup[] {
  return localSetup.filter((l) => l.kind === 'source' && l.adoptedEntityId != null);
}

/** The reported inverter(s) - shown as info, never adoptable here. */
export function inverterSetup(localSetup: EntityLocalSetup[]): EntityLocalSetup[] {
  return localSetup.filter((l) => l.kind === 'inverter');
}
