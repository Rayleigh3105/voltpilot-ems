/**
 * Die Abrufe der zwei Portfolio-Welten (PR G) — die dünne React-Anbindung, die
 * sich dieselben Disziplinen wie die Anlagen-Welten auferlegt:
 *
 * - **Cache-Treffer rendern sofort und kosten null Abrufe.** Die Messwerte-Welt
 *   liest je Anlage `GET /sites/{id}/history` durch DENSELBEN `historyCache.ts`
 *   wie die Anlagen-Welt — wer aus dem Portfolio in eine Anlage springt, zahlt
 *   für dieselbe Periode also kein zweites Mal. Das Geld liest den
 *   mandantenweiten `GET /earnings` durch einen eigenen, gleich gebauten Cache.
 * - **Blättern leert nicht** (P5): die zuletzt geladene Periode bleibt stehen
 *   und wird nur gedimmt, bis die neue da ist.
 * - **Ein Fehler ist keine Datenlage.** Scheitert der Abruf EINER Anlage, steht
 *   sie mit „konnte nicht geladen werden" in der Tabelle und fließt in keine
 *   Summe; erst wenn ALLE scheitern, ist die Seite in einem Fehlerzustand.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Earnings, type EarningsRange, type HistoryRange } from './api';
import { historyCacheKey, readHistoryCache, writeHistoryCache } from './historyCache';
import { vergleichsAnker } from './historieVergleich';
import { isoDate } from './periodNav';
import { earningsRangeFor, type PortfolioHistoryInput } from './portfolioHistorie';

/** Eine Anlage, so wie das Portfolio sie kennt (Name kommt aus der Schale). */
export interface PortfolioSite {
  id: string;
  name: string;
}

export interface PortfolioPeriode<T> {
  /** Die Daten der ANGEZEIGTEN Periode — beim Blättern zunächst die alten. */
  daten: T | null;
  loading: boolean;
  /** Das Gezeigte gehört noch zur vorherigen Periode (gedimmt darstellen). */
  stale: boolean;
  /** Gesetzt, wenn NICHTS geladen werden konnte. */
  err: string | null;
  retry: () => void;
}

function fehlerText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Fehler';
}

// ---------------------------------------------------------------------------
// Welt A · Messwerte (ein Abruf je Anlage, durch den Historie-Cache)
// ---------------------------------------------------------------------------

/**
 * Lädt die Historie ALLER Anlagen für einen Zeitraum. Die Anlagen werden
 * parallel geholt; jede trägt ihr eigenes Ergebnis (Antwort ODER Fehler), damit
 * eine kaputte Anlage die anderen nicht mit sich reißt.
 */
export function usePortfolioHistorie(
  sites: readonly PortfolioSite[],
  range: HistoryRange,
  at: string,
  enabled = true,
): PortfolioPeriode<PortfolioHistoryInput[]> {
  const ids = sites.map((s) => s.id).join(',');
  const key = `${range}|${at}|${ids}`;
  const [state, setState] = useState<{ key: string; rows: PortfolioHistoryInput[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const bypassRef = useRef<string | null>(null);
  // Die Namen kommen aus der Schale und ändern die Abrufe nicht — deshalb
  // hängt der Effekt an den Ids, nicht am Array.
  const namen = useMemo(
    () => new Map(sites.map((s) => [s.id, s.name] as const)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, sites.map((s) => s.name).join('|')],
  );

  useEffect(() => {
    if (!enabled) return;
    const liste = ids ? ids.split(',') : [];
    if (liste.length === 0) {
      setState({ key, rows: [] });
      setLoading(false);
      setErr(null);
      return;
    }
    const bypass = bypassRef.current === key;
    bypassRef.current = null;

    const cached = bypass
      ? null
      : liste.map((id) => readHistoryCache(historyCacheKey(id, range, at)));
    if (cached && cached.every((h) => h != null)) {
      setState({
        key,
        rows: liste.map((id, i) => ({ siteId: id, name: namen.get(id) ?? id, history: cached[i] })),
      });
      setLoading(false);
      setErr(null);
      return;
    }

    let active = true;
    setLoading(true);
    setErr(null);
    Promise.all(
      liste.map(async (id): Promise<PortfolioHistoryInput> => {
        const cacheKey = historyCacheKey(id, range, at);
        const hit = bypass ? null : readHistoryCache(cacheKey);
        if (hit) return { siteId: id, name: namen.get(id) ?? id, history: hit };
        try {
          const h = await api.history(id, range, at);
          writeHistoryCache(cacheKey, h);
          return { siteId: id, name: namen.get(id) ?? id, history: h };
        } catch {
          // Die Zeile sagt „konnte nicht geladen werden" — der Grund gehört
          // nicht in eine Tabellenzelle. Erst wenn ALLE scheitern, trägt die
          // Seite eine Fehlermeldung.
          return { siteId: id, name: namen.get(id) ?? id, history: null, fehler: true };
        }
      }),
    ).then((rows) => {
      if (!active || keyRef.current !== key) return;
      const alleKaputt = rows.length > 0 && rows.every((r) => r.fehler);
      if (alleKaputt) setErr('Die Anlagen konnten nicht geladen werden');
      setState({ key, rows });
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [enabled, ids, range, at, key, reloadKey, namen]);

  const retry = useCallback(() => {
    bypassRef.current = keyRef.current;
    setReloadKey((k) => k + 1);
  }, []);

  return {
    daten: state?.rows ?? null,
    loading,
    stale: state != null && state.key !== key,
    err,
    retry,
  };
}

/**
 * Die VORPERIODE der Messwerte-Welt für das Δ (F3) — derselbe Endpunkt,
 * derselbe Cache, nur ein verschobener Anker. Er startet erst, wenn der
 * gezeigte Zeitraum überhaupt Zahlen trägt, und liefert `null`, solange die
 * Antwort noch zur vorherigen Auswahl gehört (lieber kein Δ als ein falsches).
 */
export function useVergleichsHistorie(
  sites: readonly PortfolioSite[],
  range: HistoryRange,
  anchor: Date,
  aktiv: boolean,
): PortfolioHistoryInput[] | null {
  const at = isoDate(vergleichsAnker(anchor, range));
  const { daten, stale } = usePortfolioHistorie(sites, range, at, aktiv);
  return aktiv && !stale ? daten : null;
}

// ---------------------------------------------------------------------------
// Welt B · Erlöse (EIN mandantenweiter Abruf, eigener kleiner Cache)
// ---------------------------------------------------------------------------

const EARNINGS_TTL_MS = 60_000;
const EARNINGS_MAX = 12;
const earningsCache = new Map<string, { at: number; value: Earnings }>();

function earningsKey(range: EarningsRange, at: string): string {
  return `${range}|${at}`;
}

function readEarnings(key: string, now = Date.now()): Earnings | null {
  const hit = earningsCache.get(key);
  if (!hit) return null;
  if (now - hit.at > EARNINGS_TTL_MS) {
    earningsCache.delete(key);
    return null;
  }
  return hit.value;
}

function writeEarnings(key: string, value: Earnings, now = Date.now()): void {
  earningsCache.delete(key);
  earningsCache.set(key, { at: now, value });
  while (earningsCache.size > EARNINGS_MAX) {
    const oldest = earningsCache.keys().next();
    if (oldest.done) break;
    earningsCache.delete(oldest.value);
  }
}

/** Alles vergessen (Tests, Mandantenwechsel). */
export function clearPortfolioEarningsCache(): void {
  earningsCache.clear();
}

/**
 * Das gemessene Geld ALLER Anlagen in einem Zeitraum — der mandantenweite
 * `GET /api/v1/earnings`. Genau dafür existiert er (die anlagen-scharfe
 * Variante bleibt der Anlagen-Welt vorbehalten, P3).
 */
export function usePortfolioErloese(
  range: HistoryRange,
  at: string,
  enabled = true,
): PortfolioPeriode<Earnings> {
  const earningsRange = earningsRangeFor(range);
  const key = earningsKey(earningsRange, at);
  const [state, setState] = useState<{ key: string; value: Earnings } | null>(() => {
    const hit = readEarnings(key);
    return hit ? { key, value: hit } : null;
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const bypassRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const bypass = bypassRef.current === key;
    bypassRef.current = null;
    const cached = bypass ? null : readEarnings(key);
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
      .earnings(earningsRange, at)
      .then((e) => {
        writeEarnings(key, e);
        if (active && keyRef.current === key) setState({ key, value: e });
      })
      .catch((e) => {
        if (active && keyRef.current === key) setErr(fehlerText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, earningsRange, at, key, reloadKey]);

  const retry = useCallback(() => {
    bypassRef.current = keyRef.current;
    setReloadKey((k) => k + 1);
  }, []);

  return {
    daten: state?.value ?? null,
    loading,
    stale: state != null && state.key !== key,
    err,
    retry,
  };
}

/** Die Vorperiode der Erlöse-Welt (ein zweiter Abruf desselben Endpunkts). */
export function useVergleichsErloesePortfolio(
  range: HistoryRange,
  anchor: Date,
  aktiv: boolean,
): Earnings | null {
  const at = isoDate(vergleichsAnker(anchor, range));
  const { daten, stale } = usePortfolioErloese(range, at, aktiv);
  return aktiv && !stale ? daten : null;
}
