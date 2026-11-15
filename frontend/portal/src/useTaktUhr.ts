import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Die Uhr einer Seite mit Live-Takt (Frische-Chip, „Stand vor X“, Alter der Werte): sie tickt alle `tickMs` - und
 * geht beim Live-Takt MIT den Daten weiter statt eine Antwortzeit vor ihnen (Performance-Runde vp-perf3-portal-takt).
 *
 * Warum: Uhr-Intervall und Daten-Takt starten mit derselben Übergabe und laufen darum phasengleich (5 s und 10 s).
 * Jeder zweite Tick fiel so wenige Millisekunden NACH den Taktbeginn und zeichnete die alten Daten neu, eine
 * Antwortzeit bevor die neuen kamen - ein Viertel der Übergaben einer offenen Anlagen-Seite.
 *
 * - `taktBeginn()` ruft der Takt, bevor er fragt. Solange er unterwegs ist, setzt der Tick aus (höchstens ein Tick:
 *   bleibt die Antwort länger als `tickMs` aus, tickt die Uhr wieder, das Alter wächst also weiter). Stand die Uhr
 *   still (verdeckter Tab, zugeklappter Laptop, bfcache: der Takt läuft dann beim Zurückkommen sofort), stellt
 *   `taktBeginn` sie sofort weiter - der alte Stand zeigt bis zur Antwort sein wahres Alter.
 * - `taktEnde()` ruft der Takt mit der Antwort (auch bei einem Fehler), im SELBEN Rückruf wie das Setzen der Daten:
 *   React übergibt beides zusammen. Der nächste Tick kommt `tickMs` danach.
 */
export function useTaktUhr(tickMs: number): { now: Date; taktBeginn: () => void; taktEnde: () => void } {
  const [now, setNow] = useState(() => new Date());
  const nowRef = useRef(now);
  nowRef.current = now;
  const taktSeit = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const planen = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(function ticken() {
      const seit = taktSeit.current;
      if (seit == null || Date.now() - seit >= tickMs) setNow(new Date());
      timer.current = window.setTimeout(ticken, tickMs);
    }, tickMs);
  }, [tickMs]);

  useEffect(() => {
    planen();
    return () => window.clearTimeout(timer.current);
  }, [planen]);

  const taktBeginn = useCallback(() => {
    taktSeit.current = Date.now();
    if (Date.now() - nowRef.current.getTime() > tickMs * 1.5) setNow(new Date());
  }, [tickMs]);

  const taktEnde = useCallback(() => {
    taktSeit.current = null;
    setNow(new Date());
    planen();
  }, [planen]);

  return { now, taktBeginn, taktEnde };
}
