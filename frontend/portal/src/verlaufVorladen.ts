import { useEffect } from 'react';
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
  useEffect(() => {
    if (!aktiv || typeof window === 'undefined') return;
    const netz = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (netz?.saveData || netz?.effectiveType === 'slow-2g' || netz?.effectiveType === '2g') return;
    const lade = () => {
      for (const holen of [SUB_CHUNK.messwerte, SUB_CHUNK.erloese, CHART_CHUNK.energie, CHART_CHUNK.erloese]) {
        holen().catch(() => undefined);
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
