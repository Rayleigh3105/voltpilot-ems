import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/** Sperrt den Seiten-Scroll (gezählt, ein Zähler für das ganze Haus); die Rückgabe gibt ihn frei. */
export declare function sperreSeitenScroll(): () => void;

/** Hält Tab und Shift-Tab in `panel`; der Tastendruck blubbert nicht weiter. */
export declare function fokusFalle(event: ReactKeyboardEvent | KeyboardEvent, panel: HTMLElement | null): void;

/** Nennt den Auslöser der nächsten Überlagerung ausdrücklich (ein Menüeintrag verschwindet, sein Knopf bleibt). */
export declare function merkeAusloeser(element: HTMLElement | null): void;

/**
 * Wohin der Fokus nach dem Schließen zurückgeht, beim Öffnen gelesen: der genannte Auslöser, sonst das vom Zeiger
 * getroffene Element, das der Browser nicht selbst fokussiert hat (Safari), sonst `document.activeElement`.
 */
export declare function fokusAusloeser(): HTMLElement | null;

/** Stapel der Überlagerungen: Scroll-Sperre, Fokus hinein und zurück, Escape nur für die oberste Fläche. */
export declare function useUeberlagerung(
  sichtbar: boolean,
  panelRef: { current: HTMLElement | null },
  onClose: () => void,
): void;
