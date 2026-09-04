import { useEffect, useRef, useState, type ReactElement, type SVGProps } from 'react';
import { swapInit, swapNext, swapSettle, type SwapState } from '../swapNumber';

/**
 * **Der EINE Baustein für einen Zahlenwechsel** (Bewegungs-Programm P3,
 * Signaturmoment Nr. 3 aus Captain-Entscheid E9 a).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §6 Zeile „Zahlenwechsel":
 * heute springt jede Kennzahl, jeder Hero-Betrag und jeder Ring-Prozentwert im
 * selben Frame. Neu: der alte Wert blendet 200 ms nach oben aus, der neue von
 * unten ein — und **es wird nie gezählt** (Captain-Antwort 3).
 *
 * ## ⚠ ES GIBT ZWEI FASSUNGEN, WEIL ES ZWEI LAUFZEITEN GIBT
 *
 * {@link SwapNumber} ist HTML (Kennzahl-Zeilen, Hero-Betrag, Preisleiste),
 * {@link SwapText} ist SVG (`<text>` im Energiefluss und im Ring-Donut). Sie
 * teilen die Regel ({@link useSwap}) und die zwei Keyframes; sie unterscheiden
 * sich nur darin, WIE der alte Wert aus dem Fluss genommen wird — im HTML per
 * `position: absolute`, im SVG gar nicht, weil `x`/`y` dort ohnehin absolut
 * sind. Ein gemeinsames Bauteil hätte für den SVG-Fall ein `<foreignObject>`
 * gebraucht: eine zweite Textrasterung mitten im Diagramm.
 *
 * ## ⚠ DER TEXT STEHT IMMER FERTIG IM DOM
 *
 * Beide Fassungen rendern ausschliesslich Zeichenketten, die als `value`
 * hereinkamen (`swapRendered()` ist die maschinenlesbare Zusage, geprüft in
 * `swapNumber.test.ts`). Vorlesesoftware liest nur den NEUEN Wert: der alte
 * trägt `aria-hidden`.
 *
 * ## ⚠ KEINE `motion`-ABHÄNGIGKEIT
 *
 * Der Wechsel ist eine CSS-Animation auf `opacity`/`transform` (Prinzip 9,
 * Compositor-Eigenschaften). Damit darf dieser Baustein im EINSTIEGS-Bündel
 * liegen — der Hero-Betrag ist Teil des ersten Bildes, und `motion` wäre dort
 * 45 kB gz (E10 a). Der Bündel-Wächter `test/bundle-smoke.sh` prüft das.
 *
 * Unter reduzierter Bewegung nullt `--vp-motion-scale` die Dauer: beide
 * Animationen laufen mit 0 s ab und stehen sofort auf ihrem Endzustand — der
 * alte Wert ist unsichtbar, der neue da. Das IST der Sprung von früher, nur
 * ohne Sonderregel (Konzept §7.4).
 */

/**
 * Wie lange der ausgeblendete Vorgänger im Baum bleibt.
 *
 * ⚠ Bewusst grosszügiger als die 200 ms der Animation und bewusst eine UHR
 * statt `animationend` (Konzept §7.4). Bleibt der Vorgänger doch einmal
 * stehen, ist er harmlos: `aria-hidden`, absolut liegend, Deckkraft 0.
 */
const SETTLE_MS = 420;

/** Die gemeinsame Regel beider Fassungen. */
function useSwap(value: string): SwapState {
  const [state, setState] = useState<SwapState>(() => swapInit(value));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Der Wechsel selbst passiert beim RENDERN, nicht in einem Effekt: sonst
  // stuende der neue Wert einen Frame lang ohne seinen Vorgaenger da und der
  // erste Frame der Animation ginge verloren.
  const next = swapNext(state, value);
  if (next !== state) setState(next);

  useEffect(() => {
    if (next.prev === null) return undefined;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(swapSettle), SETTLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // `seq` zaehlt WECHSEL - `prev` allein wuerde bei A -> B -> A nicht neu
    // ausloesen (siehe `swapNumber.ts`).
  }, [next.seq, next.prev]);

  return next;
}

export interface SwapNumberProps {
  /** Der fertige, formatierte Wert. Es wird nie gerechnet und nie gezählt. */
  value: string;
  className?: string;
  /** `title` wandert auf den Träger, damit der Tooltip beim Wechsel bleibt. */
  title?: string;
}

/** Die HTML-Fassung: Kennzahl-Zeilen, Hero-Betrag, Preisleisten-Wert. */
export function SwapNumber({ value, className, title }: SwapNumberProps): ReactElement {
  const s = useSwap(value);
  return (
    <span className={className ? `vp-swap ${className}` : 'vp-swap'} title={title}>
      {s.prev !== null && (
        <span key={`o${s.seq}`} className="vp-swap-out" aria-hidden="true">
          {s.prev}
        </span>
      )}
      <span key={`n${s.seq}`} className="vp-swap-in">
        {value}
      </span>
    </span>
  );
}

export type SwapTextProps = Omit<SVGProps<SVGTextElement>, 'children'> & {
  /** Der fertige, formatierte Wert. */
  value: string;
};

/**
 * Die SVG-Fassung: ein `<text>`-Paar auf DERSELBEN Position.
 *
 * ⚠ Zwei `<text>` mit gleichem `x`/`y` überlagern sich per Konstruktion — in
 * SVG gibt es keinen Textfluss, den der alte Wert stören könnte. Genau deshalb
 * braucht diese Fassung kein `position: absolute` und keinen zweiten Träger:
 * das Diagramm behält seine Geometrie Zeichen für Zeichen (Owner-Auflage zum
 * Energiefluss).
 */
export function SwapText({ value, className, ...rest }: SwapTextProps): ReactElement {
  const s = useSwap(value);
  const cls = (extra: string) => (className ? `${extra} ${className}` : extra);
  return (
    <>
      {s.prev !== null && (
        <text key={`o${s.seq}`} {...rest} className={cls('vp-swap-out')} aria-hidden="true">
          {s.prev}
        </text>
      )}
      <text key={`n${s.seq}`} {...rest} className={cls('vp-swap-in')}>
        {value}
      </text>
    </>
  );
}
