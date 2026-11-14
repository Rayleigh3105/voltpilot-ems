/**
 * Der EINE Historie-Abruf beider Welten (P2/P5 des Konzepts
 * `data/vp-historie-konzept-t4` §5.3) — die dünne React-Anbindung an den reinen
 * `historyCache.ts`.
 *
 * Zwei Verhalten, die die Seite ruhig machen:
 * - **Cache-Treffer rendern sofort** und lösen KEINEN Abruf aus: der
 *   Welt-Wechsel und die Rückkehr in eine besuchte Periode kosten null Abrufe.
 * - **Blättern leert nicht** (P5, stale-while-revalidate): beim Wechsel auf eine
 *   noch unbekannte Periode bleibt die zuletzt gezeigte Periode sichtbar und
 *   wird nur gedimmt (`stale: true`), statt gegen ein Skelett getauscht zu
 *   werden. Nur der ERSTE Aufbau zeigt ein Skelett (`history === null`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type History, type HistoryRange } from './api';
import { abrechnungApi } from './abrechnungApi';
import { historyCacheKey, readHistoryCache, writeHistoryCache } from './historyCache';
import { vergleichsAnkerFor, type VergleichsModus } from './historieVergleich';
import { isoDate } from './periodNav';

export interface HistoryPeriod {
  /** Die Antwort der ANGEZEIGTEN Periode — beim Blättern zunächst die alte. */
  history: History | null;
  /** Ein Abruf läuft. */
  loading: boolean;
  /** Das Gezeigte gehört noch zur vorherigen Periode (gedimmt darstellen). */
  stale: boolean;
  err: string | null;
  retry: () => void;
}

export function useHistoryPeriod(
  siteId: string,
  range: HistoryRange,
  at: string,
  /**
   * Aus, solange der Abruf sich nicht lohnt. Der Vorperioden-Vergleich (F3)
   * schaltet sich damit erst zu, wenn die ANGEZEIGTE Periode überhaupt Zahlen
   * trägt — eine leere Anlage bezahlt so keinen zweiten Abruf für ein Δ, das
   * es ohnehin nicht geben kann.
   */
  enabled = true,
): HistoryPeriod {
  return useHistoryAbruf(historyCacheKey(siteId, range, at), () => api.history(siteId, range, at), enabled);
}

/**
 * Der FREIE Zeitraum (Abrechnung prüfen, R1/R4): `…/history?from=&to=` mit denselben zwei Verhalten — Treffer
 * sofort, Blättern leert nicht. Ohne Zeitraum (`null`) ruht der Abruf.
 */
export function useHistoryZeitraum(siteId: string, zeitraum: { von: string; bis: string } | null): HistoryPeriod {
  const von = zeitraum?.von ?? '';
  const bis = zeitraum?.bis ?? '';
  return useHistoryAbruf(
    `${siteId}|zeitraum|${von}|${bis}`,
    () => abrechnungApi.historyZeitraum(siteId, von, bis),
    zeitraum != null,
  );
}

function useHistoryAbruf(key: string, abruf: () => Promise<History>, enabled: boolean): HistoryPeriod {
  // Der Abruf gehört zum Schlüssel: eine neue Funktion je Render darf keinen neuen Abruf auslösen.
  const abrufRef = useRef(abruf);
  abrufRef.current = abruf;
  // Ein Treffer ist schon beim ersten Render da — kein Skelett-Blitzer.
  const [state, setState] = useState<{ key: string; value: History } | null>(() => {
    const hit = readHistoryCache(key);
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
    const cached = bypass ? null : readHistoryCache(key);
    if (cached) {
      setState({ key, value: cached });
      setLoading(false);
      setErr(null);
      return;
    }
    let active = true;
    setLoading(true);
    setErr(null);
    abrufRef
      .current()
      .then((h) => {
        writeHistoryCache(key, h);
        // Eine spät eintreffende Antwort darf eine inzwischen gewählte andere
        // Periode nie überschreiben.
        if (active && keyRef.current === key) setState({ key, value: h });
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
  }, [key, reloadKey, enabled]);

  const retry = useCallback(() => {
    bypassRef.current = keyRef.current;
    setReloadKey((k) => k + 1);
  }, []);

  return {
    history: state?.value ?? null,
    loading,
    stale: state != null && state.key !== key,
    err,
    retry,
  };
}

/**
 * Die VORPERIODE für das Δ (F3) — derselbe Endpunkt, derselbe Cache, nur ein
 * verschobener Anker.
 *
 * Zwei Sparsamkeiten und eine Ehrlichkeit stecken darin:
 * - **Erst wenn sich der Vergleich lohnt** (`aktiv`): eine Anlage ohne Zahlen
 *   im gezeigten Zeitraum bezahlt keinen zweiten Abruf für ein Δ, das es
 *   ohnehin nicht geben kann.
 * - **Über den Cache**: zurückblättern in eine schon besuchte Periode kostet
 *   nichts, und die eben verglichene Periode ist beim nächsten ‹-Klick sofort
 *   da.
 * - **Nie ein FALSCHER Vergleich**: solange die Antwort noch zur vorherigen
 *   Auswahl gehört (`stale`), liefert der Haken `null` — lieber kein Δ als
 *   eines gegen den falschen Monat.
 */
export function useVergleichsPeriode(
  siteId: string,
  range: HistoryRange,
  anchor: Date,
  aktiv: boolean,
  /**
   * F8: gegen WELCHE Periode verglichen wird. Der Standard ist die Vorperiode
   * (das Verhalten vor F8, zeichengleich); „Vorjahr" verschiebt nur den Anker —
   * derselbe Endpunkt, derselbe Cache. Δ-Zeile und Überlagerung lesen damit
   * dieselbe Antwort und können sich nicht widersprechen.
   */
  modus: VergleichsModus = 'vorperiode',
): History | null {
  const at = isoDate(vergleichsAnkerFor(anchor, range, modus));
  const { history, stale } = useHistoryPeriod(siteId, range, at, aktiv);
  return aktiv && !stale ? history : null;
}
