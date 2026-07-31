/**
 * Der EINE Geld-Abruf der Erlöse-Welt (`GET /sites/{id}/earnings`, P3 des
 * Historie-Konzepts) — kleiner Cache + dünne React-Anbindung, gebaut wie
 * `historyCache.ts`/`useHistoryPeriod.ts` und bewusst DANEBEN statt darin:
 * die Historie-Antwort und die Erlöse-Antwort sind zwei Endpunkte, und ein
 * gemeinsamer Cache müsste sie am Schlüssel auseinanderhalten, ohne dass eine
 * Fläche davon etwas hätte.
 *
 * Dieselben zwei Verhalten machen die Seite ruhig:
 * - **Cache-Treffer rendern sofort** und lösen KEINEN Abruf aus (Zurückblättern
 *   in eine besuchte Periode und der Δ-Abruf der Vorperiode kosten dann nichts).
 * - **Blättern leert nicht** (P5): die zuletzt gezeigte Periode bleibt sichtbar
 *   und wird nur gedimmt (`stale`), bis die neue da ist.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type SiteEarnings, type SiteEarningsRange } from './api';
import { vergleichsAnkerFor, type VergleichsModus } from './historieVergleich';
import { isoDate } from './periodNav';
import type { HistoryRange } from './api';

/** Lebensdauer eines Eintrags — kurz genug für die LAUFENDE Periode. */
export const EARNINGS_TTL_MS = 60_000;

/** Wie viele Perioden gleichzeitig vorgehalten werden. */
export const EARNINGS_CACHE_MAX = 24;

interface Entry {
  at: number;
  value: SiteEarnings;
}

const cache = new Map<string, Entry>();

/** Der Schlüssel einer Periode — Anlage, Zeitraum, Anker. */
export function earningsCacheKey(
  siteId: string,
  range: SiteEarningsRange,
  at: string,
): string {
  return `${siteId}|${range}|${at}`;
}

/** Der Eintrag, falls vorhanden UND frisch; sonst null (nie ein alter Wert). */
export function readEarningsCache(key: string, now: number = Date.now()): SiteEarnings | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > EARNINGS_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

/** Eintragen (und den ältesten verdrängen, wenn die Obergrenze erreicht ist). */
export function writeEarningsCache(
  key: string,
  value: SiteEarnings,
  now: number = Date.now(),
): void {
  cache.delete(key);
  cache.set(key, { at: now, value });
  while (cache.size > EARNINGS_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Alles vergessen (Tests, Mandantenwechsel). */
export function clearEarningsCache(): void {
  cache.clear();
}

/** Nur für Tests/Diagnose: wie viele Perioden liegen gerade vor. */
export function earningsCacheSize(): number {
  return cache.size;
}

export interface SiteEarningsPeriod {
  /** Die Antwort der ANGEZEIGTEN Periode — beim Blättern zunächst die alte. */
  money: SiteEarnings | null;
  loading: boolean;
  /** Das Gezeigte gehört noch zur vorherigen Periode (gedimmt darstellen). */
  stale: boolean;
  err: string | null;
  retry: () => void;
}

export function useSiteEarnings(
  siteId: string,
  range: SiteEarningsRange,
  at: string,
  enabled = true,
): SiteEarningsPeriod {
  const key = earningsCacheKey(siteId, range, at);
  const [state, setState] = useState<{ key: string; value: SiteEarnings } | null>(() => {
    const hit = readEarningsCache(key);
    return hit ? { key, value: hit } : null;
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Welcher Schlüssel den Cache EINMAL übergehen soll (der Wiederholen-Knopf).
  const bypassRef = useRef<string | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!enabled) return;
    const bypass = bypassRef.current === key;
    bypassRef.current = null;
    const cached = bypass ? null : readEarningsCache(key);
    if (cached) {
      setState({ key, value: cached });
      setLoading(false);
      setErr(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    api
      .siteEarnings(siteId, range, at)
      .then((m) => {
        writeEarningsCache(key, m);
        // Eine spät eintreffende Antwort darf eine inzwischen gewählte andere
        // Periode nie überschreiben.
        if (active && keyRef.current === key) setState({ key, value: m });
      })
      .catch((e) => {
        if (active && keyRef.current === key) {
          setErr(e instanceof ApiError ? e.message : 'Fehler');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [siteId, range, at, key, reloadKey, enabled]);

  const retry = useCallback(() => {
    bypassRef.current = keyRef.current;
    setReloadKey((k) => k + 1);
  }, []);

  return {
    money: state?.value ?? null,
    loading,
    stale: state != null && state.key !== key,
    err,
    retry,
  };
}

/**
 * Die VORPERIODE für das Δ (F3) — derselbe Endpunkt, derselbe Cache, nur ein
 * verschobener Anker. Er startet erst, wenn der gezeigte Zeitraum überhaupt
 * Zahlen trägt, und liefert `null`, solange die Antwort noch zur vorherigen
 * Auswahl gehört: lieber kein Δ als eines gegen den falschen Monat.
 */
export function useVergleichsErloese(
  siteId: string,
  range: HistoryRange,
  anchor: Date,
  aktiv: boolean,
  /** F8: gegen welche Periode — Standard ist die Vorperiode (wie vor F8). */
  modus: VergleichsModus = 'vorperiode',
): SiteEarnings | null {
  const at = isoDate(vergleichsAnkerFor(anchor, range, modus));
  const { money, stale } = useSiteEarnings(siteId, range, at, aktiv);
  return aktiv && !stale ? money : null;
}
