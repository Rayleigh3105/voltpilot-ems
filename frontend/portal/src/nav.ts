/**
 * Page registry + tiny hash router for the unified dashboard shell.
 * Keycloak's redirect response lands in the query string (auth.ts sets
 * responseMode 'query'), so the hash stays free for navigation and survives
 * the login round-trip.
 */

export type PageId =
  | 'uebersicht'
  | 'standorte'
  | 'geraete'
  | 'marktpreise'
  | 'wetter'
  | 'fahrplan'
  | 'historie'
  | 'mandanten'
  | 'benutzer';

export interface PageDef {
  id: PageId;
  label: string;
  icon: string;
  /** Only visible/reachable for Portal-Admins (the "Plattform" nav group). */
  adminOnly?: boolean;
}

export const MAIN_PAGES: PageDef[] = [
  { id: 'uebersicht', label: 'Übersicht', icon: '◧' },
  { id: 'standorte', label: 'Standorte', icon: '⌂' },
  { id: 'geraete', label: 'Geräte', icon: '⚡' },
  { id: 'marktpreise', label: 'Marktpreise', icon: '€' },
  { id: 'wetter', label: 'Wetter', icon: '☀' },
  { id: 'fahrplan', label: 'Fahrplan', icon: '⛁' },
  { id: 'historie', label: 'Historie', icon: '◷' },
];

export const PLATFORM_PAGES: PageDef[] = [
  { id: 'mandanten', label: 'Mandanten', icon: '◩', adminOnly: true },
  { id: 'benutzer', label: 'Benutzer', icon: '☺', adminOnly: true },
];

const ALL_IDS = new Set<string>([...MAIN_PAGES, ...PLATFORM_PAGES].map((p) => p.id));

export function pageLabel(id: PageId): string {
  return [...MAIN_PAGES, ...PLATFORM_PAGES].find((p) => p.id === id)?.label ?? id;
}

export function pageFromHash(): PageId {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return (ALL_IDS.has(raw) ? raw : 'uebersicht') as PageId;
}

export function hashForPage(id: PageId): string {
  return `#/${id}`;
}
