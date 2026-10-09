/**
 * Der Sprung „mit offenem Entscheid“ (Konzept Wiedervorlage w1, Entscheid 8): ein Schritt der Wiedervorlage öffnet das
 * Objekt dort, wo die Entscheidung fällt. Kein Abhaken in der Liste, denn jede Entscheidung braucht Person, Tag und
 * Begründung. Die Adresse trägt dafür einen Hash-Parameter nach dem Muster von `?sektion=` (`nav.ts`):
 * `#/portfolio/energiemanagement/dokumente/{id}?entscheid=dokument_ueberpruefung`, bei einer Seite mit mehreren
 * Gegenständen derselben Art dazu `&kennzeichen=MB-1`. `parseRoute` schneidet den Query-Teil ab, die Route bleibt die
 * Seite.
 *
 * Reines Modul ohne React: die Zielseite markiert ihren Entscheid mit `data-entscheid` (und, wo sie mehrere trägt,
 * `data-entscheid-kennzeichen`); `useEntscheidFokus` holt ihn in den Blick und nimmt den Parameter wieder aus der
 * Adresse, damit ein Neuladen nicht noch einmal springt.
 */
import { hashForRoute, type Route } from './nav';
import type { Sprung } from './uemsSprung';

export type { Sprung };

export const ENTSCHEID_PARAMETER = 'entscheid';
export const KENNZEICHEN_PARAMETER = 'kennzeichen';
/** Die Wiedervorlage selbst, gefiltert auf eine Art (der Sprung eines Bündels der Übersicht). */
export const ART_PARAMETER = 'art';

export interface Entscheid {
  /** Die Art der Frist (`wiedervorlage_art`): sie wählt den Entscheid auf der Zielseite. */
  art: string;
  /** Nur, wo eine Seite mehrere Gegenstände derselben Art trägt (die Messbedarfe der Messplanung). */
  kennzeichen: string | null;
}

function parameter(hash: string): URLSearchParams {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('?');
  return new URLSearchParams(rest.join('?'));
}

function mitParametern(route: Route, werte: Record<string, string | null>): Sprung {
  const basis = hashForRoute(route);
  const params = new URLSearchParams();
  for (const [name, wert] of Object.entries(werte)) if (wert) params.set(name, wert);
  const query = params.toString();
  return { route, hash: query ? `${basis}?${query}` : basis };
}

/**
 * Der Sprung auf die Seite eines Objekts mit offenem Entscheid. `filter` sind Parameter der Zielseite selbst (das
 * Register eines Orts: `?ort=G-1`); sie bleiben in der Adresse, wenn der Entscheid sie verlässt.
 */
export function entscheidSprung(
  route: Route,
  art: string,
  kennzeichen: string | null = null,
  filter: Record<string, string> = {},
): Sprung {
  return mitParametern(route, { ...filter, [ENTSCHEID_PARAMETER]: art, [KENNZEICHEN_PARAMETER]: kennzeichen });
}

/** Der Sprung auf eine Seite ohne Entscheid: dieselbe Form, damit eine Liste beide gleich behandelt. */
export function seitenSprung(route: Route): Sprung {
  return { route, hash: hashForRoute(route) };
}

/** Der offene Entscheid aus einer Adresse, oder `null`. */
export function entscheidAus(hash: string): Entscheid | null {
  const p = parameter(hash);
  const art = p.get(ENTSCHEID_PARAMETER)?.trim();
  if (!art) return null;
  return { art, kennzeichen: p.get(KENNZEICHEN_PARAMETER)?.trim() || null };
}

/**
 * Derselbe Sprung zum Ansehen: ohne Entscheid; die Parameter der Zielseite selbst (`?ort=G-1`) bleiben. Die Ablese-Runde
 * eines Orts (`?ablesen=G-1`, Messen m2) ist ein Schreibweg - angesehen wird das Register desselben Orts (`?ort=G-1`).
 */
export function ansehenSprung(s: Sprung): Sprung {
  const [pfad, ...rest] = ohneEntscheid(s.hash).split('?');
  const p = new URLSearchParams(rest.join('?'));
  const runde = p.get('ablesen');
  if (runde) {
    p.delete('ablesen');
    p.set('ort', runde);
  }
  const query = p.toString();
  return { route: s.route, hash: `${pfad}${query ? `?${query}` : ''}` };
}

/** Die Adresse ohne den Entscheid; andere Parameter bleiben. */
export function ohneEntscheid(hash: string): string {
  const [pfad, ...rest] = hash.split('?');
  if (rest.length === 0) return hash;
  const p = new URLSearchParams(rest.join('?'));
  p.delete(ENTSCHEID_PARAMETER);
  p.delete(KENNZEICHEN_PARAMETER);
  const query = p.toString();
  return `${pfad}${query ? `?${query}` : ''}`;
}

/** Die Wiedervorlage, gefiltert auf eine Art (`?art=bezugsbasis_ueberpruefung`). */
export function artFilterSprung(route: Route, art: string): Sprung {
  return mitParametern(route, { [ART_PARAMETER]: art });
}

/** Der Art-Filter aus einer Adresse, oder `null`. */
export function artFilterAus(hash: string): string | null {
  return parameter(hash).get(ART_PARAMETER)?.trim() || null;
}

/**
 * Ein Sprung über die Adresse, wie ein Klick auf einen Link: die Schale folgt dem `hashchange` (mit ihrem
 * Navigations-Wächter), und wie bei jedem Seitenwechsel beginnt die neue Seite oben.
 */
export function springeUeberHash(s: Sprung): void {
  if (window.location.hash === s.hash) return;
  window.location.hash = s.hash;
  window.scrollTo({ top: 0 });
}

/** Was ein Klick auf einen Sprung-Link mitbringt (ohne React-Typen, damit das Modul rein bleibt). */
type LinkKlick = {
  defaultPrevented: boolean;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
};

/**
 * Ein Sprung als echter Link (`href` = die Adresse): mit Zusatztaste oder mittlerer Taste öffnet der Browser ihn wie
 * jeden Link, sonst springt die Schale (oben auf der neuen Seite). Ein Navigations-Wächter der Schale (ungesicherte
 * Eingaben) hält den Klick vorher an.
 */
export function sprungKlick(s: Sprung, springe: (s: Sprung) => void = springeUeberHash) {
  return (e: LinkKlick) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    springe(s);
  };
}
