/**
 * Shared metadata for the adaptive live view (AE2 energy-flow diagram + AE3
 * tiles / status / module strip): role palette, entity-type icons + labels, and
 * the read-only device-control presets. Kept pure + framework-free so the flow
 * layout, the tiles and the status sentence all draw from one source of truth
 * (unit-tested in adaptive.test.ts).
 *
 * The view is driven by the AE1 topology read-model (role-grouped nodes) + the
 * AE7 usage profile (emphasis). This module never renders - it maps
 * roles/entity-types onto the design-system tokens + Icon set.
 */

import type { IconName } from '../designsystem/components/core/Icon';
import type { Role } from './topology';

/** Below this magnitude a power reading counts as "idle" (the live.ts deadband). */
export const DEADBAND_KW = 0.05;

/** Per-role palette (CSS `var()` tokens) + plain-German label + fallback icon. */
export interface RoleMeta {
  label: string;
  /** The role's ink colour (a `--vp-flow-*` token). */
  color: string;
  /** The role's soft fill (a `--vp-flow-*-soft` token). */
  soft: string;
  /** Tile accent class suffix (index.css `.vp-verdict.pv|batt|grid|load`). */
  tileClass: 'pv' | 'batt' | 'grid' | 'load';
  icon: IconName;
}

export const ROLE_META: Record<Role, RoleMeta> = {
  pv: {
    label: 'PV-Erzeugung',
    color: 'var(--vp-flow-pv)',
    soft: 'var(--vp-flow-pv-soft)',
    tileClass: 'pv',
    icon: 'sun',
  },
  storage: {
    label: 'Speicher',
    color: 'var(--vp-flow-batt)',
    soft: 'var(--vp-flow-batt-soft)',
    tileClass: 'batt',
    icon: 'battery',
  },
  consumer: {
    label: 'Verbraucher',
    color: 'var(--vp-flow-load)',
    soft: 'var(--vp-flow-load-soft)',
    tileClass: 'load',
    icon: 'home',
  },
  grid: {
    label: 'Netz',
    color: 'var(--vp-flow-grid)',
    soft: 'var(--vp-flow-grid-soft)',
    tileClass: 'grid',
    icon: 'zap',
  },
};

/**
 * The v2 entity types that are controllable consumers (the E1b type catalog's
 * `controllable` consumer rows). Used to decide where the live view shows the
 * read-only device switches (v1 display-only; actual control is E3b).
 */
const CONTROLLABLE_CONSUMER_TYPES = new Set(['wallbox', 'heating-rod', 'generic-load']);

export function isControllableConsumerType(entityType: string): boolean {
  return CONTROLLABLE_CONSUMER_TYPES.has(entityType);
}

/**
 * The Icon for an entity in a given role. Consumers get a per-type icon
 * (Wallbox vs. Heizstab vs. generic load); the other roles use the role icon.
 */
export function iconFor(entityType: string, role: Role | null): IconName {
  switch (entityType) {
    case 'wallbox':
      return 'battery-charging';
    case 'heating-rod':
      return 'activity';
    case 'grid-meter':
      return 'zap';
    case 'producer':
      return 'sun';
    case 'battery-hybrid':
      return 'battery';
    case 'generic-load':
    case 'house-load':
      return 'home';
    default:
      return role ? ROLE_META[role].icon : 'activity';
  }
}

/**
 * A read-only device-control preset for a controllable consumer type: the
 * option labels shown as (disabled) switches, and which one is the resting
 * default. v1 renders these display-only; E3b wires the actual control.
 */
export interface ControlPreset {
  options: string[];
  /** Index of the option shown as "active" by default. */
  defaultIndex: number;
}

export function controlPreset(entityType: string): ControlPreset | null {
  switch (entityType) {
    case 'wallbox':
      return { options: ['Aus', 'Nur PV', 'Voll'], defaultIndex: 1 };
    case 'heating-rod':
      return { options: ['Auto', 'An', 'Aus'], defaultIndex: 0 };
    case 'generic-load':
      return { options: ['Auto', 'An', 'Aus'], defaultIndex: 0 };
    default:
      return null;
  }
}

/** Truncate an SVG node label (no CSS ellipsis inside <text>). */
export function truncate(label: string, max = 11): string {
  const t = label.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
