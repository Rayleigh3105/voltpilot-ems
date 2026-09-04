/**
 * **Der Zahlenwechsel des Portals** (Bewegungs-Programm P3, Signaturmoment
 * Nr. 3 aus E9 a).
 *
 * Konzept `data/vp-motion-konzept-m1/report.md` §6 Zeile „Zahlenwechsel"
 * (Ist: Sprung → Neu: „Durchblenden 200 ms (alt nach oben aus, neu von unten
 * ein); **nie zählen**") und Captain-Antwort 3 („Nur zeichnen und einblenden.
 * Zahlen stehen sofort richtig").
 *
 * ## ⚠ DIE EINE REGEL, aus der alles Übrige folgt: ES WIRD NIE GEZÄHLT
 *
 * Ein Count-up erfindet Zwischenwerte — und ein lesbarer Falschwert ist in
 * einem Betriebswerkzeug eine Falschaussage, keine Animation (Prinzip 4). Der
 * Baustein hält deshalb ZWEI Zeichenketten nebeneinander: den ALTEN Wert, der
 * nach oben ausblendet, und den NEUEN, der von unten einblendet. Beide standen
 * irgendwann wirklich da. `swapRendered()` ist die maschinenlesbare Fassung
 * dieser Zusage: was es zurückgibt, IST die Menge dessen, was im DOM steht —
 * und `swapNumber.test.ts` prüft über zufällige Folgen, dass darin nie etwas
 * auftaucht, das nicht als Eingabe hereinkam.
 *
 * ## ⚠ WARUM `seq` UND NICHT DER WERT ALS SCHLÜSSEL
 *
 * React braucht einen Schlüssel, der sich bei JEDEM Wechsel ändert, damit die
 * CSS-Animation neu anläuft. Der WERT taugt dafür nicht: „12,4 kW" → „13,1 kW"
 * → „12,4 kW" ergäbe zweimal denselben Schlüssel, und der dritte Wechsel liefe
 * ohne Bewegung ab (im Labor genau so gesehen). `seq` zählt Wechsel, nicht
 * Werte.
 *
 * ## ⚠ GLEICH IST NICHT WECHSEL
 *
 * `swapNext` gibt bei unverändertem Wert das IDENTISCHE Objekt zurück. Das ist
 * die Bedingung dafür, dass ein Re-Render aus einem fremden Grund (Minuten-Uhr,
 * Fenstergrösse) keine Bewegung auslöst — „jede Bewegung sagt, WAS passiert
 * ist" (Prinzip 1). Ohne diese Kurzschluss-Regel blinkte das Cockpit im
 * 30-Sekunden-Takt.
 *
 * Diese Datei importiert NICHTS — weder React noch `motion`. Sie ist reine
 * Zustandsarithmetik und darf deshalb im Einstiegs-Bündel liegen (E10 a).
 */

/** Was gerade dasteht: der aktuelle Wert und — für 200 ms — sein Vorgänger. */
export interface SwapState {
  /** Der Wert, der gilt. Er steht ab dem ersten Frame fertig im DOM. */
  readonly value: string;
  /** Der Wert davor, solange er ausblendet; `null` = kein Wechsel im Gange. */
  readonly prev: string | null;
  /** Zählt WECHSEL (nicht Werte) — der Schlüssel, der die Animation neu anwirft. */
  readonly seq: number;
}

/** Der Anfangszustand: ein Wert, kein Vorgänger, kein Wechsel. */
export function swapInit(value: string): SwapState {
  return { value, prev: null, seq: 0 };
}

/**
 * Einen neuen Wert übernehmen.
 *
 * Unverändert ⇒ dasselbe Objekt (siehe „GLEICH IST NICHT WECHSEL" oben).
 * Verändert ⇒ der bisherige Wert wird zum Vorgänger und `seq` zählt hoch.
 */
export function swapNext(state: SwapState, value: string): SwapState {
  if (value === state.value) return state;
  return { value, prev: state.value, seq: state.seq + 1 };
}

/**
 * Den Vorgänger fallen lassen, nachdem er ausgeblendet hat.
 *
 * ⚠ Der Aufrufer hängt das an eine UHR, nicht an `animationend` (Konzept §7.4:
 * „Endzustand explizit gesetzt, auch bei 0 ms, nie von `animationend`
 * abhängig"). Bleibt der Vorgänger doch einmal stehen, ist er harmlos: er
 * liegt absolut, trägt `aria-hidden` und endet bei Deckkraft 0.
 */
export function swapSettle(state: SwapState): SwapState {
  if (state.prev === null) return state;
  return { value: state.value, prev: null, seq: state.seq };
}

/**
 * Was in diesem Zustand im DOM steht — die Ehrlichkeits-Zusage als Funktion.
 *
 * Der neue Wert zuerst (er ist der, den Vorlesesoftware liest), der alte
 * danach (`aria-hidden`, nur Bild). Nichts anderes wird je gerendert.
 */
export function swapRendered(state: SwapState): string[] {
  return state.prev === null ? [state.value] : [state.value, state.prev];
}
