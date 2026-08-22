/**
 * The ONE short, generalised display name for a v2 entity.
 *
 * The composed entities the v1->v2 backfill creates carry deliberately verbose
 * stored labels ("Batteriespeicher (Hybrid-Wechselrichter)", "Netzanschluss
 * (Messung über Wechselrichter)"), because the parenthetical says HOW the value
 * is measured. That nuance belongs in a tooltip, not in a 60px flow-diagram
 * circle or a narrow tile header, where it simply truncated to "…".
 *
 * So every compact surface (the AE2 energy-flow nodes, the AE3 verdict tiles)
 * renders `shortEntityLabel(...)` - derived from the entity's ROLE + TYPE, never
 * from the stored text - and keeps the untouched full name as the element's
 * `title`. Deriving it client-side means it works on entities that are ALREADY
 * deployed: no data migration, no api change.
 *
 * Pure + framework-free (unit-tested in entityLabel.test.ts).
 */

import type { Role } from './topology';

/**
 * ONE device-name derivation for BOTH surfaces (the energy-flow composition and
 * the per-source breakdown). Before this there were two: the flow named a device
 * through `shortLabelsForRole` (role words, falling back to the verbose stored
 * label) while the breakdown named the SAME box through `pvSources.sourceLabel`
 * (edge label / brand+model). So one plant read "Fronius WR1" above and "Fronius
 * Anlage" below - and, because the two lists were ordered independently, even
 * crossed (entity WR1 ↔ source "Anlage WR 2").
 *
 * The rule (concept `vp-ui-pv-hist-d8`, "Eine Kiste = ein Name"): the name the
 * CUSTOMER recognises wins. That rule is also what moved the customer's own
 * name to rank 1 (concept `vp-entity-alias-k1`): a name typed in the PORTAL is
 * even closer to the customer than one typed on the box's own `:8484` page, and
 * it is the only one they can change from where they are looking.
 *
 * ⚠ Rank 1 only works because of the Label-Hygiene migration
 * (`V20260812000000`): the composition no longer writes a label at all, so
 * `storedLabel != null` MEANS a human named it. Re-introduce a composed default
 * label anywhere and a Deye PV row starts reading "Batteriespeicher (…)".
 *
 * The ROLE is a subtitle, never mixed into the name. The pre-alias derivation
 * stays reachable as the tooltip (R2 - support must still be able to tell which
 * physical box a customer means; see `technicalDeviceName`).
 *
 * Returns null when nothing nameable was supplied, so each caller keeps its own
 * last resort (`shortEntityLabel` → "Gerät", `sourceLabel` → the role word).
 */
export interface DeviceNameInput {
  /** The name the device carries on the edge (`/sources` label). */
  edgeLabel?: string | null;
  brand?: string | null;
  model?: string | null;
  /** The v2 entity label = the customer's own name (alias) - wins. */
  storedLabel?: string | null;
  /** The server's type label - the last derivable fallback. */
  typeLabel?: string | null;
}

/**
 * Shorten a model code to what a human says out loud:
 * "SUN-30K-SG01HP3-EU" -> "SUN-30K". Only the first two hyphen groups are kept;
 * a model with two or fewer groups is left alone.
 */
export function shortModel(model: string): string {
  const m = model.trim();
  if (!m) return '';
  const groups = m.split('-');
  if (groups.length <= 2) return m;
  return groups.slice(0, 2).join('-');
}

/**
 * Catalog brand tokens whose raw id is not a customer word: the transport
 * suffix / technical id must never surface ("fronius_sunspec" is the Fronius
 * brand read over SunSpec, not a brand of its own). Everything else falls to
 * {@link brandCase}.
 */
const BRAND_DISPLAY: Record<string, string> = {
  fronius_sunspec: 'Fronius',
  generic_modbus: 'Modbus-Gerät',
  kaco: 'KACO',
  'go-e': 'go-e',
};

/** "deye" -> "Deye"; an already-capitalised or mixed-case brand is left alone. */
function brandCase(brand: string): string {
  const b = brand.trim();
  if (!b) return '';
  const known = BRAND_DISPLAY[b.toLowerCase()];
  if (known) return known;
  if (b !== b.toLowerCase()) return b;
  return b.charAt(0).toUpperCase() + b.slice(1);
}

export function deviceName(input: DeviceNameInput): string | null {
  // Rank 1: the customer's own name, VERBATIM. Never stripped - "Dach Süd
  // (neu)" is what they typed, and after the hygiene migration no composed
  // parenthetical can reach this branch.
  const alias = (input.storedLabel ?? '').trim();
  if (alias) return alias;
  return technicalDeviceName(input);
}

/**
 * The name WITHOUT the customer's alias - the pre-alias derivation: the edge
 * name, else brand + short model, else the type word. This is R2 made
 * mechanical: every alias surface keeps it as the row's `title`, so a support
 * call about "Dach Süd" can still be traced back to the physical box.
 */
export function technicalDeviceName(input: DeviceNameInput): string | null {
  const edge = (input.edgeLabel ?? '').trim();
  if (edge) return edge;
  const brand = brandCase((input.brand ?? '').trim());
  const model = shortModel((input.model ?? '').trim());
  const brandModel = [brand, model].filter(Boolean).join(' ');
  if (brandModel) return brandModel;
  const typeLabel = stripParenthetical((input.typeLabel ?? '').trim());
  if (typeLabel) return typeLabel;
  return null;
}

/** Per-type short names for the types a role alone cannot tell apart. */
const TYPE_SHORT: Record<string, string> = {
  'battery-hybrid': 'Batteriespeicher',
  producer: 'Erzeuger',
  'grid-meter': 'Netz',
  'house-load': 'Hausverbrauch',
  wallbox: 'Wallbox',
  'heating-rod': 'Heizstab',
  'generic-load': 'Verbraucher',
  // D3 customer dictionary (M7): "Messgerät", never the internal "Messpunkt".
  'modbus-generic': 'Messgerät',
};

/** Per-role short names - the primary key, so a hybrid reads per ASPECT. */
const ROLE_SHORT: Record<Role, string> = {
  pv: 'Erzeuger',
  storage: 'Batteriespeicher',
  grid: 'Netz',
  consumer: 'Verbraucher',
};

/**
 * Drop a trailing "(…)" qualifier from a stored label. Used only in the
 * fallback chain (unknown role AND unknown type), never to invent a name.
 */
export function stripParenthetical(label: string): string {
  return label.replace(/\s*\([^()]*\)\s*$/, '').trim();
}

export interface ShortLabelInput {
  /** The v2 entity type ("battery-hybrid", "wallbox", …). */
  entityType?: string | null;
  /**
   * The role this circle/tile represents. A hybrid inverter contributes to PV
   * *and* Speicher, so the role decides which aspect is being named.
   */
  role?: Role | null;
  /** The stored (verbose) label - the last-resort fallback only. */
  label?: string | null;
  /** The server's type label - the fallback before the role word. */
  typeLabel?: string | null;
}

/**
 * The short, generalised label. Resolution order:
 *  1. role (per ASPECT: the pv side of a hybrid is "Erzeuger", the storage side
 *     "Batteriespeicher") - except a consumer, where the TYPE is the meaningful
 *     word ("Wallbox" / "Heizstab" / "Hausverbrauch");
 *  2. the entity type;
 *  3. the stored label without its "(…)" qualifier, or the server's type label;
 *  4. "Gerät" - never an empty node.
 */
export function shortEntityLabel(input: ShortLabelInput): string {
  const type = (input.entityType ?? '').trim();
  const role = input.role ?? null;

  // A consumer's TYPE carries the meaning; every other role's word does.
  if (role === 'consumer' && TYPE_SHORT[type]) return TYPE_SHORT[type];
  if (role && ROLE_SHORT[role]) return ROLE_SHORT[role];
  if (TYPE_SHORT[type]) return TYPE_SHORT[type];

  const stored = stripParenthetical((input.label ?? '').trim());
  if (stored) return stored;
  const typeLabel = stripParenthetical((input.typeLabel ?? '').trim());
  if (typeLabel) return typeLabel;
  return 'Gerät';
}

/**
 * Short labels for the members of ONE role. Several entities in a role would
 * all collapse to the same word (two PV inverters -> "Erzeuger", "Erzeuger"),
 * so a member whose own stored name is distinct and compact keeps it - the
 * shortening must never make two different devices read alike.
 */
export function shortLabelsForRole(
  members: Array<{ label?: string | null; entityType?: string | null; typeLabel?: string | null }>,
  role: Role | null,
  maxOwnName = 18,
): string[] {
  const short = members.map((m) => shortEntityLabel({ ...m, role }));
  const collides = short.some((s, i) => short.indexOf(s) !== i);
  if (!collides) return short;
  return members.map((m, i) => {
    const own = stripParenthetical((m.label ?? '').trim());
    return own && own.length <= maxOwnName ? own : short[i];
  });
}
