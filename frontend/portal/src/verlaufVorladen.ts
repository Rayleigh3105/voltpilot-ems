import { useEffect, useRef } from 'react';
import { CHART_CHUNK, SUB_CHUNK } from './pageChunks';
import { PHONE_QUERY } from './useIsPhone';

/**
 * Lädt die Verlaufsseiten einer Anlage (Energie, Erlöse) samt ihren
 * Diagrammen im LEERLAUF vor, sobald eine Anlage offen ist — der Wechsel in
 * den Verlauf wartet dann auf kein Netz mehr.
 *
 * - Erst im Leerlauf (`requestIdleCallback` OHNE Frist, sonst nach 2 s), nie
 *   im Weg des ersten Bildes.
 * - Am Telefon erst nach der ersten Bedienung (Tippen, Taste, Scrollen):
 *   rund 250 kB gz (Verlauf und echarts) konkurrierten dort sonst mit dem
 *   ersten Bild und dem Live-Takt um Netz und Hauptthread, auch bei Kunden,
 *   die den Verlauf nie öffnen (Performance-Runde vp-perf2-portal, Idee 4).
 * - Nie bei gewünschter Datensparsamkeit (`navigator.connection.saveData`)
 *   oder sehr langsamem Netz (`2g`).
 * - Ein fehlgeschlagener Vorlade-Abruf ist still: die Seite lädt dann eben
 *   beim Öffnen, wie bisher.
 */
export function useVerlaufVorladen(aktiv: boolean): void {
  useImLeerlaufLaden(
    () => {
      for (const holen of [SUB_CHUNK.messwerte, SUB_CHUNK.erloese, CHART_CHUNK.energie, CHART_CHUNK.erloese]) {
        holen().catch(() => undefined);
      }
    },
    aktiv,
    { amTelefonErstNachBedienung: true },
  );
}

/** Was als erste Bedienung zählt. `scroll` in der Einfangphase, weil Scroll-Ereignisse innerer Flächen nicht aufsteigen. */
const BEDIENUNG = ['pointerdown', 'keydown', 'scroll'] as const;

/** Wurde in diesem Tab schon getippt oder getippt-geklickt (User Activation API)? Ohne die API: nein. */
function schonBedient(): boolean {
  const n = navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } };
  return n.userActivation?.hasBeenActive === true;
}

function istTelefon(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

/**
 * Der Leerlauf-Lader hinter {@link useVerlaufVorladen}, für jedes nachgeladene Stück, das ein Klick sofort finden soll
 * (etwa der Geräte-Assistent im Aufbau, `AnlegenFlowLazy.tsx`). Dieselben Regeln: erst im Leerlauf, nie bei
 * Datensparsamkeit oder `2g`, ein Fehler bleibt still. `laden` wird über eine Ref gehalten - ein neuer Rückruf je
 * Render startet nichts neu.
 *
 * Der Leerlauf hat KEINE Frist mehr (vorher spätestens nach 4 s): eine Frist erzwingt das Laden genau dann, wenn der
 * Hauptthread nie frei wird - also auf dem langsamsten Gerät, mitten im ersten Bild. `amTelefonErstNachBedienung`
 * wartet am Telefon zusätzlich auf die erste Bedienung (hat der Kunde in diesem Tab schon getippt, etwa um
 * hierher zu kommen, gilt das als Bedienung).
 */
export function useImLeerlaufLaden(
  laden: () => void,
  aktiv: boolean,
  { amTelefonErstNachBedienung = false }: { amTelefonErstNachBedienung?: boolean } = {},
): void {
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
    if (amTelefonErstNachBedienung && istTelefon() && !schonBedient()) {
      let abbrechen: (() => void) | null = null;
      const bedient = () => {
        weg();
        abbrechen = imLeerlauf(lade);
      };
      const weg = () => {
        for (const art of BEDIENUNG) window.removeEventListener(art, bedient, true);
      };
      for (const art of BEDIENUNG) window.addEventListener(art, bedient, { capture: true, passive: true });
      return () => {
        weg();
        abbrechen?.();
      };
    }
    return imLeerlauf(lade);
  }, [aktiv, amTelefonErstNachBedienung]);
}

/** Ruft `lade` im nächsten Leerlauf (ohne Frist); ohne `requestIdleCallback` (Safari) nach 2 s. Liefert den Abbruch. */
function imLeerlauf(lade: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(lade);
    return () => w.cancelIdleCallback?.(id);
  }
  const t = window.setTimeout(lade, 2000);
  return () => window.clearTimeout(t);
}
