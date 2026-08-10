import { useCallback, useState } from 'react';

/**
 * K3/M13 · Detailtiefe — „Mehr anzeigen ▾" je Diagramm.
 *
 * Der Grundzustand einer Fläche zeigt höchstens {@link BASE_SERIES_LIMIT}
 * Reihen; Ladestand, Netz, Prognosen und Vergleiche liegen eine Stufe tiefer.
 * Das ist nicht nur Verständlichkeit: der dataviz-Validator schreibt „cut
 * series or facet instead" ausdrücklich als die Antwort auf nicht trennbare
 * Farbpaare vor — weniger gleichzeitige Reihen IST das Farb-Werkzeug.
 *
 * Der Zustand wird PRO DIAGRAMM in der Tab-Sitzung gemerkt (das
 * `initialVerlaufOpen`/`VERLAUF_OPEN_KEY`-Muster aus `liveDetail.ts`): wer die
 * Tiefe einmal aufgeklappt hat, findet sie beim Zurückspringen offen — und ein
 * neuer Tab beginnt wieder ruhig. `localStorage` wäre die falsche Ebene: eine
 * einmal ausgeklappte Fläche würde den Grundzustand dauerhaft ersetzen.
 */

/** Der Speicherschlüssel EINER Fläche. */
export function chartDetailKey(chart: string): string {
  return `vp.chart.detail.${chart}`;
}

/** Die reine Lesart des gespeicherten Werts — alles ausser „1" ist zu. */
export function initialChartDetail(stored: string | null): boolean {
  return stored === '1';
}

/**
 * Der Aufklapp-Zustand einer Chart-Fläche plus sein Umschalter.
 * Ein nicht verfügbarer Speicher (privater Modus, SSR) ist kein Fehler — die
 * Fläche startet dann einfach im Grundzustand.
 */
export function useChartDetail(chart: string): [boolean, () => void] {
  const key = chartDetailKey(chart);
  const [open, setOpen] = useState(() => {
    try {
      return initialChartDetail(sessionStorage.getItem(key));
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* Speicher nicht verfügbar - der Zustand lebt dann nur im Bild. */
      }
      return next;
    });
  }, [key]);
  return [open, toggle];
}
