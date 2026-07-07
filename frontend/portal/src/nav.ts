/**
 * Page registry + tiny hash router for the unified dashboard shell.
 * Keycloak's redirect response lands in the query string (auth.ts sets
 * responseMode 'query'), so the hash stays free for navigation and survives
 * the login round-trip.
 */
import type { IconName } from '../designsystem/components/core/Icon';

export type PageId =
  | 'uebersicht'
  | 'standorte'
  | 'geraete'
  | 'marktpreise'
  | 'wetter'
  | 'fahrplan'
  | 'historie'
  | 'prognose'
  | 'mandanten'
  | 'benutzer'
  | 'geraete-registry';

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
  { id: 'standorte', label: 'Standorte', icon: 'map-pin' },
  { id: 'geraete', label: 'Geräte', icon: 'zap' },
  { id: 'marktpreise', label: 'Marktpreise', icon: 'euro' },
  { id: 'wetter', label: 'Wetter', icon: 'sun' },
  { id: 'fahrplan', label: 'Fahrplan', icon: 'battery-charging' },
  { id: 'historie', label: 'Historie', icon: 'history' },
  { id: 'prognose', label: 'Prognosequalität', icon: 'trending-up' },
];

export const PLATFORM_PAGES: PageDef[] = [
  { id: 'mandanten', label: 'Mandanten', icon: 'building', adminOnly: true },
  { id: 'benutzer', label: 'Benutzer', icon: 'users', adminOnly: true },
  { id: 'geraete-registry', label: 'Geräte-Registry', icon: 'list', adminOnly: true },
];

const ALL_IDS = new Set<string>([...MAIN_PAGES, ...PLATFORM_PAGES].map((p) => p.id));

export function pageLabel(id: PageId): string {
  return [...MAIN_PAGES, ...PLATFORM_PAGES].find((p) => p.id === id)?.label ?? id;
}

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

export function pageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return (ALL_IDS.has(raw) ? raw : 'uebersicht') as PageId;
}

export function hashForPage(id: PageId): string {
  return `#/${id}`;
}
