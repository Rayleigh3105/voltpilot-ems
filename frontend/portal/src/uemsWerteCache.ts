/**
 * Ein kleiner Cache über (Messstelle, Raster, Von, Bis) für den VERGLEICH (UEMS AP-13 IP-5) — nach dem Muster
 * `historyCache.ts`, aber mit **stale-while-revalidate**: der Umschalter `aus · Vorperiode · Vorjahr` und die weiteren
 * Reihen fragen dieselben Perioden immer wieder (hin, zurück, wieder hin). Ein leeres Skelett bei jedem Klick wäre die
 * teuerste Art, dieselbe Antwort zu zeigen.
 *
 * Der Unterschied zum Historie-Cache: ein ALTER Eintrag wird nicht weggeworfen, sondern sofort gezeigt UND im
 * Hintergrund erneuert (`stale`). Die Fläche bleibt stehen; wenn die neue Antwort da ist, wechselt die Zahl. Damit das
 * nie eine veraltete Zahl als aktuelle ausgibt, gilt: {@link WERTE_TTL_MS} ist kurz, und wer eine Zahl SPRICHT, liest
 * sie aus der Antwort — dieser Cache liefert nur Antworten, nie Sätze.
 *
 * REIN: kein React, kein Netz.
 */
import type { MessstelleWerte } from './api';

/** Lebensdauer eines frischen Eintrags — kurz genug für die laufende Periode. */
export const WERTE_TTL_MS = 60_000;

/** Wie viele Antworten gleichzeitig vorgehalten werden (drei Reihen × vier Zeiträume × hin und her). */
export const WERTE_CACHE_MAX = 32;

interface Eintrag {
  at: number;
  value: MessstelleWerte;
}

const cache = new Map<string, Eintrag>();

/** Der Schlüssel einer Antwort: die Messstelle, das Raster und die Grenzen — genau die Anfrage. */
export const werteCacheKey = (kennzeichen: string, raster: string, von: string, bis: string): string =>
  `${kennzeichen}|${raster}|${von}|${bis}`;

export interface CacheTreffer {
  value: MessstelleWerte;
  /** `true` = älter als die Lebensdauer: zeigen, aber im Hintergrund erneuern. */
  stale: boolean;
}

/** Der Eintrag, falls vorhanden — mit dem Vermerk, ob er erneuert werden muss. `null` = nichts da. */
export const readWerteCache = (key: string, now: number = Date.now()): CacheTreffer | null => {
  const hit = cache.get(key);
  if (!hit) return null;
  return { value: hit.value, stale: now - hit.at > WERTE_TTL_MS };
};

/** Eintragen; der älteste Eintrag fliegt raus (Einfüge-Reihenfolge). */
export const writeWerteCache = (key: string, value: MessstelleWerte, now: number = Date.now()): void => {
  cache.delete(key);
  cache.set(key, { at: now, value });
  while (cache.size > WERTE_CACHE_MAX) {
    const aeltester = cache.keys().next();
    if (aeltester.done) break;
    cache.delete(aeltester.value);
  }
};

/** Alles vergessen — für Tests und für einen Mandantenwechsel. */
export const clearWerteCache = (): void => cache.clear();
