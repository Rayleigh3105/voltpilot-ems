/**
 * Ein Abruf je Seite + ein kleiner Cache über (Anlage, Zeitraum, Anker) —
 * Maßnahme **P2** des Historie-Konzepts (`data/vp-historie-konzept-t4` §5.3).
 *
 * Vorher lebte `useHistory` ZWEIMAL (einmal je Gesicht), ohne Cache: jeder
 * Wechsel montierte die andere Fläche und holte **dieselbe** `/history`-Antwort
 * erneut — bei `range=month` gemessene ~1 s Skelett pro Wechsel. Beide Welten
 * lesen jetzt durch denselben Hook, und der Cache macht den Welt-Wechsel sowie
 * die Rückkehr in eine bereits besuchte Periode zu **0 Abrufen**.
 *
 * Bewusst klein gehalten:
 * - **Modul-global**, damit er einen Routen-/Komponentenwechsel überlebt (genau
 *   dafür ist er da).
 * - **Zeitlich begrenzt** (`HISTORY_TTL_MS`): die Historie ist Vergangenheit,
 *   aber die LAUFENDE Periode wächst noch — nach einer Minute wird neu geholt.
 * - **Größenbegrenzt** (`HISTORY_CACHE_MAX`): Blättern darf keinen unbegrenzten
 *   Speicher aufbauen; der älteste Eintrag fliegt raus (Einfüge-Reihenfolge).
 *
 * Rein + unit-getestet (kein React) — der Hook daneben (`useHistoryPeriod.ts`)
 * ist die dünne Anbindung.
 */
import type { History, HistoryRange } from './api';

/** Lebensdauer eines Eintrags. Kurz genug für die laufende Periode. */
export const HISTORY_TTL_MS = 60_000;

/** Wie viele Perioden gleichzeitig vorgehalten werden. */
export const HISTORY_CACHE_MAX = 24;

interface Entry {
  at: number;
  value: History;
}

const cache = new Map<string, Entry>();

/** Der Schlüssel einer Periode — Anlage, Zeitraum, Anker. */
export function historyCacheKey(siteId: string, range: HistoryRange, at: string): string {
  return `${siteId}|${range}|${at}`;
}

/** Der Eintrag, falls vorhanden UND frisch; sonst null (nie ein alter Wert). */
export function readHistoryCache(key: string, now: number = Date.now()): History | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > HISTORY_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

/** Eintragen (und den ältesten verdrängen, wenn die Obergrenze erreicht ist). */
export function writeHistoryCache(key: string, value: History, now: number = Date.now()): void {
  // Neu einsortieren, damit die Einfüge-Reihenfolge die Verdrängung steuert.
  cache.delete(key);
  cache.set(key, { at: now, value });
  while (cache.size > HISTORY_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Alles vergessen (Tests, Mandantenwechsel). */
export function clearHistoryCache(): void {
  cache.clear();
}

/** Nur für Tests/Diagnose: wie viele Perioden liegen gerade vor. */
export function historyCacheSize(): number {
  return cache.size;
}
