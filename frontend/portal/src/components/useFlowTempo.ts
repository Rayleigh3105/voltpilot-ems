import { useLayoutEffect, type RefObject } from 'react';
import { flowTempo } from '../live';

/**
 * **Das Fluss-Tempo an die Punkte bringen, ohne sie springen zu lassen**
 * (Bewegungs-Programm P3, Captain-Entscheid E4 a; Konzept
 * `data/vp-motion-konzept-m1/report.md` §5 Zeile G: „Tempo gleitet — Dauer
 * ändert sich, Animation läuft weiter").
 *
 * ## ⚠ WARUM NICHT EINFACH `animation-duration`
 *
 * Das war der erste Griff und er ist falsch. Eine CSS-Animation behält beim
 * Ändern ihrer Dauer die VERSTRICHENE ZEIT, nicht den Fortschritt: wer bei
 * 0,45 s in einen 0,9-s-Zyklus hinein (also auf halbem Weg) die Dauer auf
 * 1,8 s setzt, steht plötzlich bei einem Viertel — die Punkte springen
 * rückwärts. Im Browser nachgemessen, und genau das verbietet §5 Zeile G.
 *
 * ## DIE FORM, DIE ES KANN: `Animation.playbackRate`
 *
 * Die Web-Animations-Spezifikation schreibt für den `playbackRate`-Setter vor:
 * *„Let previous time be the value of the current time … Set the playback rate
 * … If previous time is not null, set the current time to previous time."* Die
 * aktuelle Zeit bleibt also erhalten — die Punkte stehen im selben Moment an
 * derselben Stelle und laufen von dort mit neuer Geschwindigkeit weiter. Das
 * ist Geschwindigkeits-Interpolation, vom Browser gerechnet, ohne rAF-Schleife
 * und ohne einen einzigen Attribut-Schreibvorgang je Frame.
 *
 * Die CSS-Regel behält dafür ihre feste Referenz-Dauer ({@link REFERENCE_S},
 * = das Tempo bei 2 kW); die Rate ist `REFERENCE_S / flowTempo(kW)` und liegt
 * damit im Band [0,5 … 2].
 *
 * ## ⚠ DIE LEISTUNG STEHT AM ELEMENT, NICHT IM HOOK-ARGUMENT
 *
 * `data-vp-kw` je Punktlinie ist der Grund, warum EIN Hook beide Diagramme
 * bedient (`EnergyFlow` mit vier festen Speichen, `AdaptiveEnergyFlow` mit N
 * abgeleiteten). Ein Argument-Array hätte zwei Ableitungen gebraucht, die
 * auseinanderlaufen können.
 *
 * ## ⚠ REDUZIERTE BEWEGUNG BRAUCHT HIER KEINE REGEL
 *
 * Der eine Schalter setzt `.vp-flow-on/.vp-flow-rev { animation: none }`
 * (`index.css`, Dateiende). Dann gibt es keine Animation, `getAnimations()`
 * liefert nichts, und dieser Hook tut nichts — die Punkte stehen als
 * Dash-Muster. Die Richtung sagt dort die `.vp-flow-arrow`-Spitze.
 */

/** Die Dauer, die in `index.css` steht — sie ist die Rate-1-Referenz. */
export const REFERENCE_S = 0.9;
/** Der Name der Loop-Keyframes; nur sie wird skaliert, nie das Einblenden. */
const LOOP = 'vp-flow';

/** Die Rate einer Speiche: mehr Leistung ⇒ grössere Zahl ⇒ schnellere Punkte. */
export function flowRate(kW: number): number {
  return REFERENCE_S / flowTempo(kW);
}

function apply(root: Element | null): boolean {
  if (!root) return true;
  const lines = root.querySelectorAll<SVGElement>('.vp-flow-line[data-vp-kw]');
  let complete = true;
  lines.forEach((line) => {
    const kW = Number(line.dataset.vpKw);
    const rate = flowRate(Number.isFinite(kW) ? kW : 0);
    // `getAnimations` ist nicht in jeder Testumgebung da (jsdom kennt es
    // nicht) — ohne sie bleibt es beim Referenz-Tempo, nie bei einem Fehler.
    const anims = typeof line.getAnimations === 'function' ? line.getAnimations() : [];
    const loop = anims.find((a) => (a as CSSAnimation).animationName === LOOP);
    if (!loop) {
      // Der Stil war beim Layout-Effekt noch nicht aufgelöst — ein Frame
      // später steht die Animation. (Ohne Animation, also unter reduzierter
      // Bewegung, gibt es dauerhaft nichts zu tun; dann ist die Liste leer.)
      if (anims.length === 0) complete = false;
      return;
    }
    if (loop.playbackRate !== rate) loop.playbackRate = rate;
  });
  return complete;
}

/**
 * Nach jedem Rendern die Raten nachziehen.
 *
 * Zwei Durchläufe, und der zweite ist kein Aberglaube: React ruft Layout-
 * Effekte nach der DOM-Änderung auf, eine frisch eingefügte Punktlinie hat
 * dort aber noch keine laufende Animation. Der rAF-Nachlauf holt genau diesen
 * Fall — und läuft nur, wenn der erste Durchlauf etwas offen liess.
 */
export function useFlowTempo(ref: RefObject<Element | null>): void {
  useLayoutEffect(() => {
    if (apply(ref.current)) return undefined;
    const id = requestAnimationFrame(() => apply(ref.current));
    return () => cancelAnimationFrame(id);
  });
}
