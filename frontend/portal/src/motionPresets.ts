/**
 * **Die Bewegungs-Familie als TS-Zahlen** (Bewegungs-Programm P0).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §4.4, Captain-Entscheid
 * 04.09.2026 („alle Empfehlungen nehmen", E1–E10 = a).
 *
 * ## ⚠ EINE WAHRHEIT, ZWEI SPRACHEN
 *
 * Dieselben Zahlen stehen als `@property`-Initialwerte in
 * `designsystem/tokens/effects.css`. Das ist keine Kopie aus Bequemlichkeit,
 * sondern die Naht zwischen zwei Laufzeiten: CSS rechnet
 * `calc(<ms> * var(--vp-motion-scale))`, JS bekommt Sekunden. Der Waechter
 * `src/motionTokens.test.ts` liest BEIDE Dateien und verlangt Gleichheit je
 * Token — wer hier eine Zahl aendert, aendert sie dort mit (und umgekehrt).
 *
 * ## ⚠ DIESE DATEI IMPORTIERT NICHTS AUS `motion`
 *
 * Sie traegt reine Zahlen, damit sie im EINSTIEGS-Buendel liegen darf
 * (E10 a: „das Einstiegs-Buendel traegt NUR das erste Bild"). Motion selbst
 * lebt ausschliesslich in Lazy-Stuecken — siehe `src/motionFeatures.ts` und
 * `src/components/MotionRoot.tsx`. Ein `import { ... } from 'motion/react'`
 * hier wuerde 45 kB gz in den Einstieg ziehen; der Buendel-Waechter
 * `test/bundle-smoke.sh` faengt das.
 *
 * ## Die Skala (Konzept §3 Prinzip 2)
 *
 * 120 ms Feedback · 200 ms Zustand · 260/160 ms Erscheinen/Verschwinden ·
 * 300 ms Seite und Chart-Uebergang · 400 ms Chart-Einstieg (die eine
 * benannte Ausnahme, E2 a). „Ankommen weich, verlassen schnell": Ease-out
 * beim Erscheinen, Ease-in beim Verschwinden, Ease-in-out beim Bewegen
 * (E3 a); Ausblenden ist ~60 % der Einblend-Dauer.
 */

/** Eine Bewegung: Dauer in SEKUNDEN (Motion-Konvention) plus ihre Kurve. */
export type MotionPreset = {
  /** Sekunden — Motion rechnet in Sekunden, CSS in Millisekunden. */
  readonly duration: number;
  /** Vier Kontrollpunkte einer `cubic-bezier`, wie Motion sie erwartet. */
  readonly ease: readonly [number, number, number, number];
};

/** Ankommen: der Anfang schnell, das Ende weich. */
export const EASE_OUT = [0.2, 0.7, 0.2, 1] as const;
/** Verlassen: der Anfang weich, das Ende schnell — raus darf es eilig haben. */
export const EASE_IN = [0.4, 0, 1, 1] as const;
/** Bewegen/Morphen zwischen zwei Zustaenden (= das Haus-Token `--vp-ease`). */
export const EASE_INOUT = [0.4, 0, 0.2, 1] as const;

/** Druck, Hover, Chip-Farbe, Tooltip/Fahne, Fokus-Dimmen. */
export const FAST: MotionPreset = { duration: 0.12, ease: EASE_INOUT };
/** Zustandswechsel, Zahlen-Durchblenden, Chevron, Reiter-Unterstrich. */
export const BASE: MotionPreset = { duration: 0.2, ease: EASE_INOUT };
/** Erscheinen: Karten, Zeilen, Modal, Toast. */
export const ENTER: MotionPreset = { duration: 0.26, ease: EASE_OUT };
/** Verschwinden — kuerzer als das Erscheinen (Prinzip 3). */
export const EXIT: MotionPreset = { duration: 0.16, ease: EASE_IN };
/** Telefon-Blatt, Sheet, Drawer. */
export const PAGE: MotionPreset = { duration: 0.3, ease: EASE_INOUT };
/** Chart-Einstieg (Maske) — die eine benannte Ausnahme ueber 300 ms (E2 a). */
export const CHART: MotionPreset = { duration: 0.4, ease: EASE_OUT };
/** Chart-Morph, Jetzt-Marker, Ring-Bogen. */
export const CHART_UPDATE: MotionPreset = { duration: 0.3, ease: EASE_INOUT };

/** Staffel je Element in Sekunden. Deckel: hoechstens 8 verzoegerte Elemente. */
export const STAGGER = 0.03;
/** Der Deckel dazu (Prinzip 5) — 9 gestaffelte Karten wirken wie eine Welle. */
export const STAGGER_MAX = 8;
/** Weg beim Erscheinen, in px. */
export const DISTANCE = 8;

/**
 * Sheet/Drawer federn statt zu gleiten — die eine Feder des Hauses.
 *
 * ⚠ Sie traegt bewusst KEINE Dauer: eine Feder endet, wenn sie zur Ruhe
 * kommt, und eine zusaetzliche Dauer waere eine zweite Aussage darueber.
 * Unter reduzierter Bewegung nimmt `scaled()` ihr die Feder ab und macht
 * daraus einen Sprung (Dauer 0) — siehe dort.
 */
export const SHEET_SPRING = {
  type: 'spring',
  stiffness: 380,
  damping: 36,
} as const;

/**
 * Eine Vorgabe mit dem EINEN Schalter verrechnen.
 *
 * `scale` ist derselbe Wert wie `--vp-motion-scale` (1 = normal, 0 = reduziert;
 * Motion liefert ihn ueber `useReducedMotion()`, siehe `MotionRoot.tsx`).
 *
 * ⚠ `scale === 0` ergibt Dauer 0 — NICHT „keine Animation". Der Endzustand
 * wird trotzdem explizit gesetzt, nur eben sofort (Konzept §7.4: „jede
 * Bewegung unterbrechbar, Endzustand explizit gesetzt, auch bei 0 ms, nie von
 * `animationend` abhaengig"). Eine weggelassene Animation liesse ein Element
 * mit seinem Anfangszustand stehen — das waere der unsichtbare Dialog.
 */
export function scaled(preset: MotionPreset, scale: number): MotionPreset {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 0;
  return { duration: preset.duration * s, ease: preset.ease };
}

/** Die Staffel-Verzoegerung des `i`-ten Elements, gedeckelt (Prinzip 5). */
export function staggerDelay(index: number, scale = 1): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 0;
  const i = Math.max(0, Math.min(Math.floor(index), STAGGER_MAX));
  return i * STAGGER * s;
}
