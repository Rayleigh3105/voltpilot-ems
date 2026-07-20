/**
 * Page registry + tiny hash router for the unified dashboard shell.
 * Keycloak's redirect response lands in the query string (auth.ts sets
 * responseMode 'query'), so the hash stays free for navigation and survives
 * the login round-trip.
 *
 * IA (captain decision 2026-07-07, "Anlagen-Seite"): the customer nav is
 * Übersicht / Meine Anlage(n) / Marktpreise / Prognosequalität. ONE site =
 * ONE Anlage; everything that used to be its own menu item (Standorte,
 * Geräte, Live-Daten, Fahrplan, Wetter, Historie) lives ON the Anlagen-Seite
 * (`#/anlage/{siteId}`) or as one of its subpages
 * (`#/anlage/{siteId}/live|fahrplan|historie|wetter`). The old hashes keep
 * working as redirects so bookmarks never break.
 */
import type { IconName } from '../designsystem/components/core/Icon';

export type PageId =
  | 'uebersicht'
  | 'anlagen'
  | 'marktpreise'
  | 'prognose'
  | 'mandanten'
  | 'benutzer'
  | 'geraete-registry'
  | 'optimizer'
  | 'ersparnis-rechner'
  | 'flows';

/** Subpages of one Anlage (the deep views behind the Anlagen-Seite). */
export type AnlagenSub =
  | 'live'
  | 'fahrplan'
  | 'historie'
  | 'wetter'
  | 'technik'
  | 'entitaeten'
  | 'simulation'
  | 'steuerung'
  | 'lastspitzen';

const SUBS = new Set<string>([
  'live', 'fahrplan', 'historie', 'wetter', 'technik', 'entitaeten', 'simulation',
  'steuerung', 'lastspitzen',
]);

/**
 * U3: "Optimierung" (read-only module cards) MERGED into "Steuerung" as its
 * Level 1 "Was läuft". The old subpage hash redirects so bookmarks never break
 * (the LEGACY_ROUTES discipline, at the sub level).
 */
const LEGACY_SUBS: Record<string, AnlagenSub> = {
  optimierung: 'steuerung',
};

/**
 * One navigation state. `siteId`/`sub` only carry meaning for page 'anlagen':
 * siteId null = the "Meine Anlage(n)" entry (single-Anlage customers land on
 * their Anlage, fleets on the list); sub non-null = a subpage of that Anlage.
 * A legacy deep link like `#/fahrplan` parses to siteId null + sub 'fahrplan'
 * - the Anlagen page resolves it to the single Anlage or falls back to the
 * list when the customer has several.
 */
export interface Route {
  page: PageId;
  siteId: string | null;
  sub: AnlagenSub | null;
}

export interface PageDef {
  id: PageId;
  label: string;
  /** Icon name in the design-system Icon set (designsystem/components/core/Icon). */
  icon: IconName;
  /** Only visible/reachable for Portal-Admins (the "Plattform" nav group). */
  adminOnly?: boolean;
}

export const MAIN_PAGES: PageDef[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: 'dashboard' },
  { id: 'anlagen', label: 'Meine Anlage', icon: 'sun' },
  { id: 'marktpreise', label: 'Marktpreise', icon: 'euro' },
  { id: 'prognose', label: 'Prognosequalität', icon: 'trending-up' },
];

export const PLATFORM_PAGES: PageDef[] = [
  { id: 'mandanten', label: 'Mandanten', icon: 'building', adminOnly: true },
  { id: 'benutzer', label: 'Benutzer', icon: 'users', adminOnly: true },
  { id: 'geraete-registry', label: 'Geräte-Registry', icon: 'list', adminOnly: true },
  { id: 'optimizer', label: 'Optimizer', icon: 'settings', adminOnly: true },
  { id: 'flows', label: 'Flows', icon: 'zap', adminOnly: true },
  { id: 'ersparnis-rechner', label: 'Ersparnis-Rechner', icon: 'euro', adminOnly: true },
];

/** "Meine Anlage" for 0-1 Anlagen, "Meine Anlagen" from 2 (the fleet list). */
export function anlagenLabel(siteCount: number | null): string {
  return siteCount != null && siteCount > 1 ? 'Meine Anlagen' : 'Meine Anlage';
}

export function pageLabel(id: PageId, siteCount: number | null = null): string {
  if (id === 'anlagen') return anlagenLabel(siteCount);
  return [...MAIN_PAGES, ...PLATFORM_PAGES].find((p) => p.id === id)?.label ?? id;
}

const PAGE_IDS = new Set<string>([...MAIN_PAGES, ...PLATFORM_PAGES].map((p) => p.id));

/**
 * The retired menu items redirect into the Anlage (nothing was deleted -
 * everything moved onto the Anlagen-Seite, captain decision 2). Site-scoped
 * deep views keep their intent as a sub; the entity lists map to the
 * Anlagen entry itself (their content is the Technik section).
 */
const LEGACY_ROUTES: Record<string, AnlagenSub | null> = {
  live: 'live',
  fahrplan: 'fahrplan',
  historie: 'historie',
  wetter: 'wetter',
  // The former Standorte/Geräte content now lives behind the Technik subpage
  // (money-centric v2: Technik moved behind the gear icon).
  standorte: 'technik',
  geraete: 'technik',
};

/**
 * The self-registration route (`#register` / `#/register`): the "Konto
 * erstellen" form lives in the PORTAL (custom form + seamless auto-login), not
 * in Keycloak - this route must render WITHOUT the automatic login redirect,
 * and the Keycloak login page links back to it.
 */
export function isRegisterRoute(): boolean {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return raw === 'register';
}

/** Parse a location hash (e.g. "#/anlage/abc/live") into a Route. Pure. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  const segments = raw.split('/').filter((s) => s.length > 0);
  const head = segments[0] ?? '';

  if (head === 'anlage' && segments[1]) {
    const raw = segments[2];
    const sub = raw
      ? (LEGACY_SUBS[raw] ?? (SUBS.has(raw) ? (raw as AnlagenSub) : null))
      : null;
    return { page: 'anlagen', siteId: segments[1], sub };
  }
  if (head in LEGACY_ROUTES) {
    return { page: 'anlagen', siteId: null, sub: LEGACY_ROUTES[head] };
  }
  if (PAGE_IDS.has(head)) {
    return { page: head as PageId, siteId: null, sub: null };
  }
  return { page: 'uebersicht', siteId: null, sub: null };
}

export function routeFromHash(): Route {
  return parseRoute(window.location.hash);
}

/** The canonical hash of a route (what goes into window.location.hash). */
export function hashForRoute(route: Route): string {
  if (route.page === 'anlagen' && route.siteId) {
    return route.sub
      ? `#/anlage/${route.siteId}/${route.sub}`
      : `#/anlage/${route.siteId}`;
  }
  if (route.page === 'anlagen') return '#/anlagen';
  return `#/${route.page}`;
}

/** Shorthand for a plain top-level page route. */
export function pageRoute(page: PageId): Route {
  return { page, siteId: null, sub: null };
}

/** Route of one Anlage's page (or one of its subpages). */
export function anlageRoute(siteId: string, sub: AnlagenSub | null = null): Route {
  return { page: 'anlagen', siteId, sub };
}
