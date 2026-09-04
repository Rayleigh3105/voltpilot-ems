/** Die gemessene Dauer von `--vp-motion-exit` in ms; 0 = nicht warten. */
export declare function ausblendDauerMs(): number;

/** Hält eine Überlagerung im Baum, bis ihre Ausblendung durch ist. */
export declare function useAusblenden(
  open: boolean,
  ref?: { current: Element | null },
): { sichtbar: boolean; schliessend: boolean };
