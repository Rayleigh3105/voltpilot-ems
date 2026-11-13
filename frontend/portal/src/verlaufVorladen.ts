import { useEffect, useRef } from 'react';
import { CHART_CHUNK, SUB_CHUNK } from './pageChunks';

/**
 * Lädt die Verlaufsseiten einer Anlage (Energie, Erlöse) samt ihren
 * Diagrammen im LEERLAUF vor, sobald eine Anlage offen ist — der Wechsel in
 * den Verlauf wartet dann auf kein Netz mehr.
 *
 * - Erst im Leerlauf (`requestIdleCallback`, sonst nach 2 s), nie im Weg des
 *   ersten Bildes.
 * - Nie bei gewünschter Datensparsamkeit (`navigator.connection.saveData`)
 *   oder sehr langsamem Netz (`2g`).
 * - Ein fehlgeschlagener Vorlade-Abruf ist still: die Seite lädt dann eben
 *   beim Öffnen, wie bisher.
 */
export function useVerlaufVorladen(aktiv: boolean): void {
  useImLeerlaufLaden(() => {
    for (const holen of [SUB_CHUNK.messwerte, SUB_CHUNK.erloese, CHART_CHUNK.energie, CHART_CHUNK.erloese]) {
      holen().catch(() => undefined);
    }
  }, aktiv);
}

/**
 * Der Leerlauf-Lader hinter {@link useVerlaufVorladen}, für jedes nachgeladene Stück, das ein Klick sofort finden soll
 * (etwa der Geräte-Assistent im Aufbau, `AnlegenFlowLazy.tsx`). Dieselben Regeln: erst im Leerlauf, nie bei
 * Datensparsamkeit oder `2g`, ein Fehler bleibt still. `laden` wird über eine Ref gehalten - ein neuer Rückruf je
 * Render startet nichts neu.
 */
export function useImLeerlaufLaden(laden: () => void, aktiv: boolean): void {
  const ladenRef = useRef(laden);
  ladenRef.current = laden;
  useEffect(() => {
    if (!aktiv || typeof window === 'undefined') return;
    const netz = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (netz?.saveData || netz?.effectiveType === 'slow-2g' || netz?.effectiveType === '2g') return;
    const lade = () => {
      try {
        ladenRef.current();
      } catch {
        /* still: das Stück lädt dann beim Öffnen */
      }
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(lade, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(lade, 2000);
    return () => window.clearTimeout(t);
  }, [aktiv]);
}
