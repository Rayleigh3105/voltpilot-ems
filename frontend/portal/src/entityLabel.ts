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
