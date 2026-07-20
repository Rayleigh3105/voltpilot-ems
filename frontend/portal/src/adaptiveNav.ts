/**
 * U1 derived per-Anlage tab ordering (design vp-ems-ui-overhaul §5.2, epic UO
 * #512). The AE7-consumer pattern (mirrors adaptiveLive.ts): one PURE function
 * turns the site's usage profile (+ the tenant frame) into the ORDERED tab set
 * of the per-Anlage tab bar (§5.1).
 *
 * Invariants (the captain's demands, pinned by adaptiveNav.test.ts):
 * - Every AnlagenSub route stays reachable on EVERY face - the profile only
 *   changes order + promotion, never which routes exist, so deep links and
 *   bookmarks NEVER break (some subs move into the `Mehr ▾` overflow, still one
 *   click away).
 * - The two structures Geräte (`entitaeten`) and Steuerung (`steuerung`) are in
 *   the VISIBLE set on every face - "always findable".
 * - A null/unknown profile yields a sensible calm default order (v1-safe), so a
 *   site with no derived profile renders a stable tab bar.
 *
 * The `frame` (Betriebsart) is part of the §5.2 signature and accepted for
 * completeness; it decides the SHELL (U0), not the per-Anlage tab order, so it
 * does not currently reorder tabs - passing null is always safe.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { Betriebsart } from './api';
import type { AnlagenSub } from './nav';
import { isUsageProfile, type UsageProfile } from './usageProfile';

/** One tab of the per-Anlage tab bar. `sub === null` is the cockpit (Übersicht). */
export interface AnlagenTab {
  /** null = the Anlagen-Seite cockpit; else the AnlagenSub route it opens. */
  sub: AnlagenSub | null;
  label: string;
  icon: IconName;
  /** true = hosted inside the "Mehr ▾" overflow, not rendered as a visible tab. */
  overflow: boolean;
}

/** Stable key per tab (the cockpit gets its own key alongside the AnlagenSubs). */
type TabKey = AnlagenSub | 'uebersicht';

/** The full inventory, in a stable canonical order (drives the overflow order). */
const ALL_KEYS: TabKey[] = [
  'uebersicht',
  'live',
  'fahrplan',
  'historie',
  'wetter',
  'technik',
  'entitaeten',
  'simulation',
  'steuerung',
];

/** Canonical label + design-system icon per tab. */
const META: Record<TabKey, { label: string; icon: IconName }> = {
  uebersicht: { label: 'Übersicht', icon: 'dashboard' },
  live: { label: 'Live', icon: 'activity' },
  fahrplan: { label: 'Fahrplan', icon: 'calendar' },
  historie: { label: 'Historie & Erlöse', icon: 'history' },
  wetter: { label: 'Wetter', icon: 'sun' },
  technik: { label: 'Einstellungen', icon: 'settings' },
  entitaeten: { label: 'Geräte', icon: 'cpu' },
  simulation: { label: 'Ersparnis-Simulation', icon: 'euro' },
  steuerung: { label: 'Steuerung', icon: 'zap' },
};

/** A visible tab in a face order; `label` overrides META for a face promotion. */
interface FaceTab {
  key: TabKey;
  label?: string;
}

/**
 * The VISIBLE tab order per face (§5.2). Everything not listed here falls into
 * the `Mehr ▾` overflow in the canonical ALL_KEYS order. Übersicht leads every
 * face; Geräte + Steuerung are in every list (the always-findable invariant).
 */
const FACES: Record<UsageProfile | 'default', FaceTab[]> = {
  // private → Übersicht · Geräte · Steuerung · Live · Historie · Mehr(Wetter, Einstellungen…)
  private: [
    { key: 'uebersicht' },
    { key: 'entitaeten' },
    { key: 'steuerung' },
    { key: 'live' },
    { key: 'historie', label: 'Historie' },
  ],
  // peak → Übersicht · Steuerung · Live · Geräte · Historie · Mehr. The
  // Lastspitzenkappung proof lives in Steuerung's "Was läuft" level (U3 merge;
  // §4.6: a peak face lands on the Strategien mode). U4 adds a dedicated
  // Lastspitzen lead artifact.
  peak: [
    { key: 'uebersicht' },
    { key: 'steuerung' },
    { key: 'live' },
    { key: 'entitaeten' },
    { key: 'historie', label: 'Historie' },
  ],
  // arbitrage → Übersicht · Erlöse · Fahrplan · Steuerung · Geräte · Mehr
  arbitrage: [
    { key: 'uebersicht' },
    { key: 'historie', label: 'Erlöse' },
    { key: 'fahrplan' },
    { key: 'steuerung' },
    { key: 'entitaeten' },
  ],
  // default (no/unknown profile) → the §5.1 canonical calm order (v1-safe).
  default: [
    { key: 'uebersicht' },
    { key: 'live' },
    { key: 'steuerung' },
    { key: 'entitaeten' },
    { key: 'historie' },
    { key: 'technik' },
  ],
};

function keyToSub(key: TabKey): AnlagenSub | null {
  return key === 'uebersicht' ? null : key;
}

/**
 * The ordered tab set for one Anlage's tab bar: the face's visible tabs first
 * (in face order), then every remaining sub as an overflow tab (canonical
 * order). `profile` accepts the effective usage profile string; anything not a
 * known UsageProfile falls back to the default order.
 */
export function navFor(
  profile: UsageProfile | string | null | undefined,
  // Part of the §5.2 signature; reserved (the frame drives the SHELL in U0, not
  // the per-Anlage tab order). Underscore-prefixed for noUnusedParameters.
  _frame: Betriebsart | null,
): AnlagenTab[] {
  const spec = FACES[isUsageProfile(profile) ? profile : 'default'];
  const visibleKeys = new Set<TabKey>(spec.map((t) => t.key));

  const visible: AnlagenTab[] = spec.map((t) => ({
    sub: keyToSub(t.key),
    label: t.label ?? META[t.key].label,
    icon: META[t.key].icon,
    overflow: false,
  }));

  const overflow: AnlagenTab[] = ALL_KEYS.filter((k) => !visibleKeys.has(k)).map((k) => ({
    sub: keyToSub(k),
    label: META[k].label,
    icon: META[k].icon,
    overflow: true,
  }));

  return [...visible, ...overflow];
}
