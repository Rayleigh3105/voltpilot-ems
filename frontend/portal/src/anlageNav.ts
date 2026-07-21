/**
 * M1 (Projektion #529): the Anlage-scoped SHELL navigation — the sidebar trio
 * `Übersicht · Steuerung · Geräte` that replaces the U1 per-Anlage tab bar
 * (report `data/vp-anlagen-face-k9/report.md` §2.1/§2.2, F1 decided: the tab
 * bar is retired).
 *
 * Pure + deterministic (the `betriebsart.ts`/`surface.ts` precedent) — no
 * React, no network. The three moves it encodes:
 *
 * 1. **The trio is fixed, not derived.** U1's `adaptiveNav.ts` FACES ordering
 *    (profile → tab order) is DELETED: the projection orders CONTENT, not
 *    navigation. Übersicht leads; Steuerung and Geräte are always present.
 *    Only Steuerung's BADGE is derived — the number of active modes from the
 *    M0 read-model (`activeModes(site).length`), never re-derived here.
 * 2. **No global "Markt & Wissen" group** (captain, `feedback.md` round 1):
 *    Marktpreise + Prognosequalität are the market mode's deep views and are
 *    rendered as a mode-tagged sidebar group that appears and disappears with
 *    the mode — driven by `deepViews(...)` from M0.
 * 3. **Nothing is stranded.** Until the block drill-ins land (M3), every deep
 *    view stays reachable through `DEEP_VIEW_ITEMS` (the interim "Mehr ▾"
 *    menu on the Anlage head) on top of the cockpit's existing links. The
 *    routes themselves never changed, so bookmarks keep working regardless.
 */
import type { IconName } from '../designsystem/components/core/Icon';
import type { AnlagenSub, PageId } from './nav';
import type { DeepViewId } from './surface';

/** One of the three Anlage-scoped shell areas. */
export type AnlageAreaKey = 'uebersicht' | 'steuerung' | 'geraete';

/** A sidebar (and phone bottom-bar) entry of the Anlage trio. */
export interface AnlageArea {
  key: AnlageAreaKey;
  /** The route sub this area opens; null = the Anlagen-Seite cockpit. */
  sub: AnlagenSub | null;
  label: string;
  icon: IconName;
  /** Trailing count badge; null = none (Steuerung only, and only when > 0). */
  badge: number | null;
}

/**
 * The Anlage trio (report §2.1). Steuerung is THE key area and carries the
 * active-mode count; a count of 0/null renders WITHOUT a badge (never a
 * discouraging "0").
 */
export function anlageTrio(activeModeCount: number | null | undefined): AnlageArea[] {
  const badge =
    typeof activeModeCount === 'number' && Number.isFinite(activeModeCount) && activeModeCount > 0
      ? Math.trunc(activeModeCount)
      : null;
  return [
    { key: 'uebersicht', sub: null, label: 'Übersicht', icon: 'dashboard', badge: null },
    { key: 'steuerung', sub: 'steuerung', label: 'Steuerung', icon: 'zap', badge },
    { key: 'geraete', sub: 'entitaeten', label: 'Geräte', icon: 'cpu', badge: null },
  ];
}

/**
 * Which trio entry a route sub belongs to. A deep view (live/fahrplan/…) is
 * NOT one of the three areas — it returns null, so no trio entry is falsely
 * highlighted while a deep view is open.
 */
export function activeAreaKey(sub: AnlagenSub | null): AnlageAreaKey | null {
  if (sub == null) return 'uebersicht';
  if (sub === 'steuerung') return 'steuerung';
  if (sub === 'entitaeten') return 'geraete';
  return null;
}

/** One entry of the interim "Mehr ▾" deep-view menu. */
export interface DeepViewItem {
  sub: AnlagenSub;
  label: string;
  icon: IconName;
}

/**
 * The interim access affordance (M1 → superseded by the M3 block drill-ins):
 * EVERY Anlage deep view that is not one of the trio areas, so no view is
 * orphaned while the cockpit blocks that will own them do not exist yet.
 * Deliberately exhaustive — a new `AnlagenSub` must land here (or in the
 * trio), which `anlageNav.test.ts` enforces.
 */
export const DEEP_VIEW_ITEMS: DeepViewItem[] = [
  { sub: 'live', label: 'Live-Daten', icon: 'activity' },
  { sub: 'fahrplan', label: 'Fahrplan', icon: 'calendar' },
  { sub: 'historie', label: 'Historie & Erlöse', icon: 'history' },
  { sub: 'lastspitzen', label: 'Lastspitzen', icon: 'trending-up' },
  { sub: 'wetter', label: 'Wetter', icon: 'sun' },
  { sub: 'technik', label: 'Einstellungen', icon: 'settings' },
];

/** A mode-tagged sidebar group (report §2.1: "Aus Modus: Marktvermarktung"). */
export interface ModeNavGroup {
  title: string;
  pages: PageId[];
}

/**
 * The mode-scoped knowledge group. Marktpreise + Prognosequalität belong to
 * `module(marktvermarktung)` and appear ONLY while that mode is active — a
 * Privat-EMS or Gewerbe site never sees them anywhere (captain, Rev. 2).
 * Driven by the M0 deep-view set, so the derivation is not duplicated.
 */
export function modeNavGroup(deepViews: DeepViewId[] | null | undefined): ModeNavGroup | null {
  const views = deepViews ?? [];
  const pages: PageId[] = [];
  if (views.includes('marktpreise')) pages.push('marktpreise');
  if (views.includes('prognosequalitaet')) pages.push('prognose');
  if (pages.length === 0) return null;
  return { title: 'Aus Modus: Marktvermarktung', pages };
}

/**
 * The Anlage a route addresses: the requested site, else the single Anlage of
 * a one-Anlage customer, else null (the fleet list). Shared by `AnlagenPage`
 * (which renders it) and `App.tsx` (which builds the shell nav for it) so the
 * two can never disagree about which Anlage the shell is scoped to.
 */
export function resolveAnlage<T extends { id: string }>(
  sites: T[],
  siteId: string | null,
): T | null {
  const requested = siteId ? sites.find((s) => s.id === siteId) ?? null : null;
  if (requested) return requested;
  return sites.length === 1 ? sites[0] : null;
}
