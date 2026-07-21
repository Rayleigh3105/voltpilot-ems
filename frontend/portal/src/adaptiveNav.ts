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
 * - An UN-MIGRATED (v1) site gets that SAME calm default order regardless of
 *   its derived profile (pre-deploy audit MEDIUM-3): the api's profile deriver
 *   never returns null, so a plain eigenverbrauch v1 site derived `private` and
 *   led its tab bar with the (empty) "Geräte" page while Fahrplan/Einstellungen
 *   dropped into `Mehr ▾`. The per-face orders (§5.2) apply once a site
 *   actually has v2 entities; before that the everyday v1 subs stay up front.
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
  'lastspitzen',
  'live',
  'fahrplan',
  'historie',
  'wetter',
  'technik',
  'entitaeten',
  'steuerung',
];

/** Canonical label + design-system icon per tab. */
const META: Record<TabKey, { label: string; icon: IconName }> = {
  uebersicht: { label: 'Übersicht', icon: 'dashboard' },
  lastspitzen: { label: 'Lastspitzen', icon: 'trending-up' },
  live: { label: 'Live', icon: 'activity' },
  fahrplan: { label: 'Fahrplan', icon: 'calendar' },
  historie: { label: 'Historie & Erlöse', icon: 'history' },
  wetter: { label: 'Wetter', icon: 'sun' },
  technik: { label: 'Einstellungen', icon: 'settings' },
  entitaeten: { label: 'Geräte', icon: 'cpu' },
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
  // peak → Übersicht · Lastspitzen · Live · Steuerung · Geräte · Historie · Mehr
  // (§6 Face 2). U4 promotes the dedicated `Lastspitzen` subpage right after the
  // cockpit (PS-4 proof + period-history chart + peak-target Fahrplan overlay);
  // the Lastspitzenkappung "Was läuft" proof still lives inside Steuerung too.
  peak: [
    { key: 'uebersicht' },
    { key: 'lastspitzen' },
    { key: 'live' },
    { key: 'steuerung' },
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
  // default (no/unknown profile, or an un-migrated v1 site) → the §5.1
  // canonical calm order (v1-safe): the cockpit leads, then the everyday v1
  // subs (Live · Fahrplan · Historie) that a v1 customer used before the
  // overhaul, then the always-findable Steuerung + Geräte, then Einstellungen.
  // Nothing a v1 customer relies on sits in `Mehr ▾`.
  default: [
    { key: 'uebersicht' },
    { key: 'live' },
    { key: 'fahrplan' },
    { key: 'historie' },
    { key: 'steuerung' },
    { key: 'entitaeten' },
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
 *
 * `migrated` (default true, so existing call sites keep their behavior) is the
 * "this site actually has v2 entities" signal - pass false for a v1/un-migrated
 * site and the calm default order wins over the derived face (MEDIUM-3).
 */
export function navFor(
  profile: UsageProfile | string | null | undefined,
  // Part of the §5.2 signature; reserved (the frame drives the SHELL in U0, not
  // the per-Anlage tab order). Underscore-prefixed for noUnusedParameters.
  _frame: Betriebsart | null,
  migrated = true,
): AnlagenTab[] {
  const spec = FACES[migrated && isUsageProfile(profile) ? profile : 'default'];
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
