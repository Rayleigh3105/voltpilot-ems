/**
 * **Der Bewegungs-Leser der Diagramme** (Bewegungs-Programm P1).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §4.3 + §5, Captain-Entscheid
 * 04.09.2026 („alle Empfehlungen nehmen", E1–E10 = a).
 *
 * Das Bewegungs-Gegenstueck zu {@link chartTheme} (Farben) und `chartStyle.ts`
 * (Geometrie): Canvas loest kein `var()` auf, also werden die Bewegungs-Tokens
 * aus dem `:root` GELESEN und als Zahlen an ECharts gereicht — dieselbe Technik,
 * derselbe Grund.
 *
 * ## ⚠ EINSTIEG IST NIE ECHARTS-WACHSTUM (E1 a, Ehrlichkeitsregel)
 *
 * Der Einstieg laeuft mit `animation: false`: jeder Balken, jede Linie steht ab
 * dem ERSTEN Bild auf ihrem wahren Wert. Aufgebaut wird nur die FORM — von einer
 * CSS-Maske am Container (`useEChart`, `@keyframes vp-chart-reveal`). Werkseitig
 * waechst ECharts aus der Null (gemessen: 0 % Tinte bis 126 ms, 26 % bei 405 ms),
 * und ein Balken auf halber Hoehe ist ein LESBARER FALSCHWERT. Deshalb ist der
 * Einstieg hier ausgeschaltet und nicht bloss verkuerzt.
 *
 * ## ⚠ MORPH NUR ZWISCHEN ZWEI ECHTEN ZUSTAENDEN
 *
 * Die Update-Phase darf morphen: der Zwischenwert ist die Interpolation zweier
 * GEMESSENER Zustaende (Zeitraumwechsel, neuer Live-Punkt) und liest sich als
 * Bewegung, nicht als Zahl. Ein Nullstart waere dagegen ein erfundener Wert —
 * genau der Unterschied, den {@link motionOptions} mit `phase` ausdrueckt.
 *
 * ## ⚠ NICHT GEMERKT (anders als `chartTheme()`)
 *
 * `chartTheme()` merkt sich seine Farben, weil Farben nach dem ersten Bild
 * feststehen. Der Bewegungs-Schalter `--vp-motion-scale` steht NICHT fest: er
 * haengt an `prefers-reduced-motion`, und das darf der Nutzer waehrend der
 * Sitzung umlegen. Ein Zwischenspeicher wuerde die Bewegung dann weiterlaufen
 * lassen, obwohl das System sie abbestellt hat. Kosten: EIN
 * `getComputedStyle`-Aufruf je `setOption` (gemessen unter 0,1 ms).
 */

/** Die vier Zahlen, die ein Diagramm aus der Bewegungs-Familie braucht. */
export interface ChartMotion {
  /** Einstieg: die Maske, die das Bild von links freigibt (ms, `--vp-motion-chart`). */
  enter: number;
  /** Uebergang zwischen zwei ECHTEN Zustaenden (ms, `--vp-motion-chart-update`). */
  update: number;
  /** Interaktion: Fokus/Dimmen, Tooltip, Achsen-Fahne (ms, `--vp-motion-fast`). */
  fast: number;
  /** 0 = Bewegung ist aus (`prefers-reduced-motion`) — alles steht sofort. */
  scale: number;
}

/**
 * Eine Token-Zahl aus einem schon gelesenen `CSSStyleDeclaration` holen.
 *
 * ⚠ Die Tokens sind per `@property` als `<time>` registriert (P0,
 * `designsystem/tokens/effects.css`), deshalb liefert `getComputedStyle` die
 * AUFGELOESTE Dauer (`"0.4s"` oder `"400ms"`), nie das `calc(...)` aus dem
 * Stylesheet. Beide Schreibweisen muessen gelesen werden: Chrome antwortet in
 * Sekunden, andere Maschinen in Millisekunden.
 */
function tokenMs(styles: CSSStyleDeclaration | null, name: string, fallback: number): number {
  if (!styles) return fallback;
  const roh = styles.getPropertyValue(name).trim();
  if (!roh) return fallback;
  const n = parseFloat(roh);
  if (!Number.isFinite(n)) return fallback;
  if (/ms$/i.test(roh)) return n;
  if (/s$/i.test(roh)) return n * 1000;
  return n; // dimensionslos: der Schalter selbst
}

/**
 * Die Bewegungs-Zahlen des laufenden Dokuments.
 *
 * Liest `getComputedStyle(document.documentElement)` GENAU EINMAL je Aufruf und
 * zieht alle vier Werte daraus (vier getrennte Aufrufe waeren vier Layout-
 * Abfragen fuer dieselbe Antwort). Ohne DOM (Server, Testlauf) gelten die
 * Initialwerte der Familie — dieselben Zahlen wie in `effects.css` und
 * `motionPresets.ts`.
 */
export function chartMotion(): ChartMotion {
  const styles =
    typeof window !== 'undefined' && typeof getComputedStyle === 'function'
      ? getComputedStyle(document.documentElement)
      : null;
  return {
    enter: tokenMs(styles, '--vp-motion-chart', 400),
    update: tokenMs(styles, '--vp-motion-chart-update', 300),
    fast: tokenMs(styles, '--vp-motion-fast', 120),
    scale: tokenMs(styles, '--vp-motion-scale', 1),
  };
}

/** Die zwei Phasen eines Diagramms: erstes Bild vs. jeder spaetere Zustand. */
export type ChartPhase = 'enter' | 'update';

/** Die Bewegungs-Optionen, die {@link motionOptions} unter die Konsumenten legt. */
export interface MotionOptions {
  animation: boolean;
  animationDurationUpdate: number;
  animationEasingUpdate: 'cubicInOut';
  animationDelayUpdate: 0;
  animationThreshold: number;
  stateAnimation: { duration: number; easing: 'cubicOut' };
  /** Nur ergaenzt, wo das Diagramm selbst einen Tooltip erklaert — siehe {@link mergeMotion}. */
  tooltip: { transitionDuration: number };
  /** dito fuer die Achsen-Fahne. */
  axisPointer: { animationDurationUpdate: number };
}

/**
 * Die ECharts-Optionen einer Phase.
 *
 * - **`enter`** ⇒ `animation: false`. Der Wert steht, die Maske baut die Form.
 * - **`update`** ⇒ Morph in `--vp-motion-chart-update` mit `cubicInOut`
 *   (E3: bewegen/morphen nimmt die Zwischen-Kurve, nicht die Ankommen-Kurve).
 * - **Schalter 0** ⇒ jede Dauer 0 und `animation: false`. Der Endzustand wird
 *   trotzdem gesetzt, nur eben sofort (Konzept §7.4).
 *
 * ⚠ `animationThreshold` bleibt bei 2000 (Werk, Konzept §7.3): der dichteste
 * Chart im Umfang hat 576 Punkte, und ueber der Schwelle schaltet ECharts den
 * Morph selbst ab — richtig so, das ist der Schutz vor einem Ruckler bei einem
 * Jahres-Explorer, keine Bewegungs-Entscheidung von uns.
 */
export function motionOptions(m: ChartMotion, phase: ChartPhase): MotionOptions {
  const aus = m.scale === 0;
  const update = aus ? 0 : m.update;
  const fast = aus ? 0 : m.fast;
  return {
    animation: phase === 'update' && !aus,
    animationDurationUpdate: update,
    animationEasingUpdate: 'cubicInOut',
    animationDelayUpdate: 0,
    animationThreshold: 2000,
    stateAnimation: { duration: fast, easing: 'cubicOut' },
    tooltip: { transitionDuration: fast / 1000 },
    axisPointer: { animationDurationUpdate: fast },
  };
}

/** Ein Wert, den wir flach mit unseren Vorgaben mischen duerfen. */
function istObjekt(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Die Optionen EINES Konsumenten mit der Bewegung der Phase unterlegen.
 *
 * ## ⚠ DER KONSUMENT GEWINNT — IMMER
 *
 * Die Bewegung liegt UNTER den Optionen des Diagramms, nie darueber. Drei
 * Flaechen setzen `animation: false` selbst (`BeobachteteRegister`,
 * `SiteMeasurementComparison`, `WhatIfCompareChart`) — die bleiben still, und
 * das ist gewollt (Konzept §2.2 „3 Stellen"). So bleiben alle 16 Konsumenten
 * unveraendert; der Hebel sitzt in {@link useEChart}.
 *
 * ## ⚠ TOOLTIP UND ACHSEN-FAHNE WERDEN NIE ERFUNDEN
 *
 * `tooltip` und `axisPointer` sind eigene ECharts-KOMPONENTEN: wer sie in die
 * Optionen schreibt, schaltet sie EIN. Ein Diagramm, das bewusst keinen Tooltip
 * hat, bekaeme durch eine Bewegungs-Dauer plötzlich einen. Deshalb werden die
 * zwei nur ERGAENZT, wo das Diagramm sie selbst erklaert — und dort flach
 * gemischt, damit `axisPointer.link` und der ganze Tooltip-Inhalt stehen bleiben.
 */
export function mergeMotion<T extends Record<string, unknown>>(
  opt: T,
  m: ChartMotion,
  phase: ChartPhase,
): T {
  const mo = motionOptions(m, phase);
  const { tooltip, axisPointer, ...basis } = mo;
  const gemischt: Record<string, unknown> = { ...basis, ...opt };
  if (istObjekt(opt.tooltip)) gemischt.tooltip = { ...tooltip, ...opt.tooltip };
  if (istObjekt(opt.axisPointer)) gemischt.axisPointer = { ...axisPointer, ...opt.axisPointer };
  return gemischt as T;
}
