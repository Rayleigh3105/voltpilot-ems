import { useEffect, useRef } from 'react';

/**
 * Der stille Auffrischungs-Takt hinter der Lebendigkeits-Bezugszeit
 * (siehe `liveness.ts` für das WARUM).
 *
 * Zwei Auslöser, beide notwendig:
 *
 *  1. **Intervall** — der Normalbetrieb bei geöffnetem Tab.
 *  2. **`visibilitychange` → sichtbar** — Browser drosseln `setInterval` in
 *     Hintergrund-Tabs massiv (Chrome: höchstens einmal pro Minute, bei
 *     „intensive throttling" noch seltener), ein zugeklappter Laptop hält ihn
 *     ganz an. Ohne diesen zweiten Auslöser sähe der zurückkehrende Kunde bis
 *     zum nächsten Intervall-Tick veraltete Daten — genau das Fenster, in dem
 *     die falsche Warnung auffiel. Deshalb wird beim Zurückkommen SOFORT
 *     geholt statt auf den Takt zu warten.
 *
 * `poll` wird über eine Ref gehalten, damit ein neu erzeugter Callback den
 * Takt nicht bei jedem Render zurücksetzt (sonst könnte ein häufig
 * re-renderndes Portal das Intervall dauerhaft neu starten und nie feuern).
 */
export function useFreshnessPoll(
  poll: () => void,
  intervalMs: number,
  enabled: boolean = true,
): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled) return;
    const run = () => pollRef.current();
    const timer = window.setInterval(run, intervalMs);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, enabled]);
}
