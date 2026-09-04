import React from 'react';

/**
 * **Das Ausblenden einer Überlagerung** — der EINE Mechanismus, mit dem Modal
 * und Bottom-Sheet nach dem Schließen noch so lange im Baum bleiben, wie ihre
 * Ausblendung dauert (Bewegungs-Programm P6, Konzept
 * `data/vp-motion-konzept-m1/report.md` §6 Zeile „Modal / Drawer": „Ausblenden
 * immer … Zustand ‚closing' im Modal").
 *
 * ## ⚠ WARUM KEIN `AnimatePresence`
 *
 * Das Modal liegt im EINSTIEGS-Bündel (jede Seite kann eines öffnen), und
 * Captain-Entscheid E10 a lautet „Motion nur in Lazy-Stücken" (+0,07 kB gz
 * statt +16,1). Der Zustand „schließend" ist deshalb ein `useState` und die
 * Bewegung reines CSS; der Wächter `test/bundle-smoke.sh` beweist, dass im
 * Einstiegs-Chunk kein Motion-Symbol steht.
 *
 * ## ⚠ DIE DAUER WIRD GEMESSEN, NIE GERATEN
 *
 * Gewartet wird genau `--vp-motion-exit` — dasselbe Token, mit dem das CSS
 * ausblendet. Es kommt aus `getComputedStyle(:root)`, also aus DERSELBEN
 * Wahrheit, und der EINE Schalter `--vp-motion-scale: 0` macht daraus `0s`:
 * unter `prefers-reduced-motion` verschwindet die Fläche damit SOFORT, ohne
 * dass hier ein zweiter Media-Query stünde.
 *
 * **Und was sich nicht als schlichte Zeit lesen lässt, wird nicht gewartet.**
 * Das deckt zwei Fälle mit derselben Regel ab: jsdom liefert für ein
 * Custom-Property nichts (`''`), und Safari < 16.4 kennt `@property` nicht und
 * gibt den unaufgelösten Token-Strom `calc(160ms * 1)` zurück. Beide Male ist
 * die ehrliche Antwort „ich kenne die Dauer nicht" — und eine unbekannte Dauer
 * darf eine Fläche nie am Verschwinden hindern. Folge, auf die sich Tests
 * verlassen können: **in jsdom schließt eine Überlagerung synchron wie vor
 * P6.** Wer das Warten prüfen will, setzt `--vp-motion-exit` selbst auf der
 * `documentElement` (siehe `src/components/Modal.test.tsx`).
 */
export function ausblendDauerMs() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  const roh = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue('--vp-motion-exit')
    .trim();
  const m = /^([\d.]+)(ms|s)$/.exec(roh);
  if (!m) return 0;
  const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Zeitpuffer über der Token-Dauer: ein Frame, damit der letzte Frame steht. */
const PUFFER_MS = 40;

/**
 * `open` hinein, „ist die Fläche im Baum?" heraus — plus das Wort für den
 * Zustand dazwischen.
 *
 * Die Entscheidung fällt WÄHREND des Renderns (das dokumentierte
 * React-Muster „adjusting state when a prop changes"), nicht in einem Effekt:
 * ein Effekt liefe erst NACH dem Render, in dem `open` bereits `false` ist —
 * die Fläche wäre für einen Frame verschwunden und käme zum Ausblenden zurück.
 * Genau dieses Flackern ist der Grund für die zwei Zustandsvariablen.
 *
 * @param {boolean} open   Der Wunsch des Aufrufers.
 * @param {{current: Element|null}} [ref] Die Fläche, deren `animationend` das
 *   Warten vorzeitig beendet. Der Zeitgeber bleibt der Rückfall — ein Element,
 *   das gar nicht animiert (Bestandsstil, `display:none` im Hintergrund),
 *   dürfte sonst nie verschwinden.
 * @returns {{sichtbar: boolean, schliessend: boolean}}
 */
export function useAusblenden(open, ref) {
  const [vorher, setVorher] = React.useState(open);
  const [schliessend, setSchliessend] = React.useState(false);

  if (vorher !== open) {
    setVorher(open);
    setSchliessend(!open && ausblendDauerMs() > 0);
  }

  React.useEffect(() => {
    if (!schliessend) return undefined;
    const fertig = () => setSchliessend(false);
    const el = ref?.current ?? null;
    const uhr = setTimeout(fertig, ausblendDauerMs() + PUFFER_MS);
    el?.addEventListener('animationend', fertig);
    return () => {
      clearTimeout(uhr);
      el?.removeEventListener('animationend', fertig);
    };
  }, [schliessend, ref]);

  return { sichtbar: open || schliessend, schliessend };
}
