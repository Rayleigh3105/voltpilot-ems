import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/** Sperrt den Seiten-Scroll (gezählt, ein Zähler für das ganze Haus); die Rückgabe gibt ihn frei. */
export declare function sperreSeitenScroll(): () => void;

/** Hält Tab und Shift-Tab in `panel`; der Tastendruck blubbert nicht weiter. */
export declare function fokusFalle(event: ReactKeyboardEvent | KeyboardEvent, panel: HTMLElement | null): void;

/** Stapel der Überlagerungen: Scroll-Sperre, Fokus hinein und zurück, Escape nur für die oberste Fläche. */
export declare function useUeberlagerung(
  sichtbar: boolean,
  panelRef: { current: HTMLElement | null },
  onClose: () => void,
): void;
