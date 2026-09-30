/**
 * PHASEN-ÜBERGABE Inline-Lader → React-Lader (Review NICE-2, Konzept „Der Puls").
 *
 * Der Inline-Lader in `index.html` (`.vp-bs-ring` / `@keyframes vp-bs-pulse`)
 * läuft schon, wenn React mountet. FORM und Loop des React-Laders
 * (`.vp-loader-ring` / `vp-loader-pulse`) sind byte-identisch - aber ohne
 * Kopplung starten die React-Ringe bei PHASE 0. Der Rhythmus springt dann beim
 * Übergang sichtbar (ein Ring verschwindet und taucht sofort wieder auf), auch
 * wenn Geometrie und Wortmarke pixelgleich sind (das prüft
 * `e2e/loader-parity.spec.ts`).
 *
 * `readBootPulsePhase()` liest die `currentTime` der laufenden Inline-Ring-
 * Animation (`getAnimations()`) und liefert daraus den negativen
 * `animation-delay`, mit dem der React-Lader auf DIESELBE Phase startet. Der
 * Boot-Cover setzt ihn als CSS-Variable `--vp-loader-phase` (siehe
 * `VpLoaderScreen`); `src/index.css` faltet die Variable in den `animation-delay`
 * der drei Ringe (Rückfall `0s`).
 *
 * ⚠ Rein additiv und defensiv. Gibt es keine laufende Inline-Animation mehr
 * (Skelett schon entfernt, reduzierte Bewegung, `getAnimations` fehlt, oder wir
 * laufen im JSDOM-Test), liefert die Funktion `null` - dann startet der React-
 * Lader wie bisher bei Phase 0. Das ist sichtbar folgenlos, weil in genau diesen
 * Fällen KEIN Inline-Lader daneben steht, an den anzuknüpfen wäre.
 */

/** Periodenlänge der Puls-Loop in ms - identisch in `index.html` und `src/index.css` (1.8s). */
const PULSE_PERIOD_MS = 1800;

/** Nur das erste, versatzfreie Inline-Ring (`r1`); sein `currentTime` IST die rohe Phase. */
const INLINE_RING_R1 = '#vp-boot-skeleton .vp-bs-ring.r1';

/**
 * Der `animation-delay`-Wert (`z. B. "-742ms"`), mit dem der React-Lader die
 * laufende Inline-Puls-Phase übernimmt - oder `null`, wenn es keine gibt.
 */
export function readBootPulsePhase(): string | null {
  try {
    const ring = document.querySelector(INLINE_RING_R1);
    const withAnims = ring as (Element & { getAnimations?: () => Animation[] }) | null;
    if (!ring || typeof withAnims?.getAnimations !== 'function') return null;

    const anims = withAnims.getAnimations();
    const pulse =
      anims.find(
        (a) => (a as Animation & { animationName?: string }).animationName === 'vp-bs-pulse',
      ) ?? anims[0];
    if (!pulse) return null;

    // `currentTime` ist bei einer CSS-Animation eine Zahl in ms; die DOM-Typen
    // erlauben auch `CSSNumericValue`/`null` (Scroll-Timelines, Halt). Nur eine
    // endliche Zahl trägt eine Phase - alles andere (`null`, Objekt) → keine.
    const ms = pulse.currentTime;
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;

    const phase = ((ms % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
    // Negativer Delay = „starte bereits `phase` ms fortgeschritten".
    return `-${Math.round(phase)}ms`;
  } catch {
    return null;
  }
}
