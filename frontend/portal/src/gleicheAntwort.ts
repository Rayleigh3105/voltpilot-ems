import { useCallback, useRef, useState } from 'react';

/**
 * UNVERÄNDERTE TAKT-ANTWORTEN BEHALTEN (Performance-Runde vp-perf2-portal, Idee 3).
 *
 * Das Anlagen-Cockpit fragt seine Live-Endpunkte alle 10 s (`LIVE_POLL_MS`), den Plan und die Tagessummen alle 30 s.
 * Jede Antwort ist ein NEUES Objekt, auch wenn sie Wort für Wort der vorigen gleicht (Ladepunkte ohne Ladung, der
 * Plan zwischen zwei Optimierer-Läufen, die Steuerungs-Rückmeldung ohne neuen Befehl) - und jedes neue Objekt im
 * Zustand rendert die ganze `AnlageSeite` neu (≈ 5 ms Desktop, ≈ 20 ms am Telefon).
 *
 * `gleichOderNeu(alt, neu)` gibt bei gleichem Inhalt das ALTE Objekt zurück. Als Zustands-Updater benutzt
 * (`setX((alt) => gleichOderNeu(alt, neu))`) erkennt React daran „nichts geändert“ und rendert nicht. Nichts wird
 * dadurch älter: gleich ist nur, was in jeder Zahl, jedem Zeitstempel und jedem Text übereinstimmt (JSON-Vergleich);
 * eine Antwort mit neuem Stand ersetzt die alte wie bisher.
 */
const alsText = new WeakMap<object, string>();

function text(wert: object): string {
  let t = alsText.get(wert);
  if (t === undefined) {
    t = JSON.stringify(wert);
    alsText.set(wert, t);
  }
  return t;
}

export function gleichOderNeu<T>(alt: T, neu: T): T {
  if (Object.is(alt, neu)) return alt;
  if (alt == null || neu == null || typeof alt !== 'object' || typeof neu !== 'object') return neu;
  return text(alt) === text(neu) ? alt : neu;
}

/**
 * `useState` für Takt-Antworten: der Setzer behält bei gleichem Inhalt das alte Objekt ({@link gleichOderNeu}) und
 * ruft React dann gar nicht erst. Verglichen wird VOR `setState`, gegen den zuletzt gesetzten Wert: ein Updater, der
 * den alten Zustand zurückgibt, rendert die Komponente nach einer Änderung trotzdem noch einmal (React prüft das erst
 * beim Rendern). Er nimmt nur Werte, keine Updater-Funktionen.
 */
export function useTaktZustand<T>(anfang: T): [T, (neu: T) => void] {
  const [wert, setWert] = useState<T>(anfang);
  const zuletzt = useRef<T>(wert);
  const setzen = useCallback((neu: T) => {
    const naechster = gleichOderNeu(zuletzt.current, neu);
    if (naechster === zuletzt.current) return;
    zuletzt.current = naechster;
    setWert(() => naechster);
  }, []);
  return [wert, setzen];
}
