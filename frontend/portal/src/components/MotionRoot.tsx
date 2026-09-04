/**
 * **Der Motion-Wirt fuer Lazy-Stuecke** (Bewegungs-Programm P0, E10 a).
 *
 * Wer in P4–P6 mit Motion animiert, wickelt SEIN Lazy-Stueck hierin ein — nie
 * die Anwendung. `MotionRoot` laedt `domAnimation` erst beim Montieren nach
 * (`src/motionFeatures.ts`) und gibt seinen Kindern den Schalter mit, den CSS
 * schon hat.
 *
 * ```tsx
 * // in einer React.lazy-Seite:
 * import { MotionRoot, useMotionScale } from '../components/MotionRoot';
 * import { ENTER, scaled } from '../motionPresets';
 * import { m, AnimatePresence } from 'motion/react';
 *
 * <MotionRoot>
 *   <Inhalt />
 * </MotionRoot>
 * ```
 *
 * ## ⚠ DREI REGELN, DIE HIER HAENGEN
 *
 * 1. **`strict`.** `LazyMotion strict` laesst `<motion.div>` nicht mehr zu und
 *    erzwingt `<m.div>` — die Vollkomponente wuerde die ganze Bibliothek in
 *    das Stueck ziehen und damit den Grund dieser Datei aufheben.
 * 2. **Der Schalter ist derselbe.** `useMotionScale()` liefert 0 unter
 *    `prefers-reduced-motion` — dieselbe Null, die `--vp-motion-scale` in CSS
 *    traegt (`designsystem/tokens/effects.css`). Es gibt keine zweite
 *    Entscheidung darueber, ob sich etwas bewegt.
 * 3. **DIESES MODUL DARF KEIN EINSTIEGS-MODUL IMPORTIEREN.** Es importiert
 *    `motion/react` statisch; ein Einstiegs-Import zoege 45 kB gz mit. Der
 *    Waechter `test/bundle-smoke.sh` prueft das bei jedem Lauf.
 */
import { LazyMotion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Der EINE Schalter, wie JS ihn sieht: 1 = normal, 0 = reduzierte Bewegung.
 *
 * Bewusst NICHT aus `getComputedStyle(--vp-motion-scale)` gelesen: Motions
 * `useReducedMotion()` haengt an derselben Media-Query, aktualisiert sich
 * aber, wenn der Nutzer die Einstellung IM LAUFENDEN BETRIEB umlegt — ein
 * einmaliges `getComputedStyle` taete das nicht. Die Zahl ist dieselbe.
 */
export function useMotionScale(): number {
  return useReducedMotion() ? 0 : 1;
}

/** Laedt `domAnimation` nach und stellt es seinen Kindern bereit. */
export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion strict features={() => import('../motionFeatures').then((mod) => mod.default)}>
      {children}
    </LazyMotion>
  );
}
