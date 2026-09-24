/**
 * FÜHLBARE RÜCKMELDUNG am Telefon (Tagesuhr des Fahrplans, Wunsch vom
 * 24.09.2026: „für Handy auch Vibrationshaptik").
 *
 * Drei kurze Muster — eine Rückmeldung, nie ein Alarm:
 *  - `tick`  : ein Tipp versetzt den Zeiger (Ring der Uhr, Viertelstunde im
 *              Bildfahrplan), beim Ziehen und Abspielen ist eine neue Phase
 *              erreicht, oder ein Wert am Zeiger wird angetippt;
 *  - `jetzt` : zurück bei „jetzt" — der Zeiger erreicht es, ein Tipp in die
 *              Mitte, der Knopf „Zurück zu jetzt", das Ende des Abspielens;
 *  - `ziel`  : ein Tipp auf eine Antwort zeigt ihre Stelle.
 *
 * Zwei Wege, und ohne beide passiert schlicht nichts — Haptik ist eine Zugabe,
 * nie eine Information:
 *  1. **Android/Chrome:** `navigator.vibrate` mit dem Muster in Millisekunden.
 *  2. **iPhone:** Safari kennt `navigator.vibrate` nicht. Ab iOS 18 spielt das
 *     System beim Umschalten eines nativen Schalters
 *     (`<input type="checkbox" switch>`) seinen Auswahl-Impuls. Ein
 *     unsichtbarer, sofort wieder entfernter Schalter leiht uns genau diesen
 *     Impuls; er ist `aria-hidden`, nicht fokussierbar und nie im Layout. Das
 *     System verlangt dafür eine frische Nutzer-Geste: bei Tipps ist er
 *     verlässlich, beim Ziehen entscheidet iOS.
 *
 * Nur bei grober Zeigereingabe (Touch): mit Maus oder Stift auf dem Rechner
 * vibriert nichts. Die Stärke regelt das Gerät (Systemeinstellungen), hier
 * wird nichts gespeichert — kein `localStorage` (Haus-Regel).
 */

export type HaptikArt = 'tick' | 'jetzt' | 'ziel';

/** Die Muster in Millisekunden (Android); ein Feld heißt: an, aus, an. */
export const HAPTIK_MUSTER: Readonly<Record<HaptikArt, number | readonly number[]>> = {
  tick: 8,
  jetzt: [6, 45, 10],
  ziel: 14,
};

/**
 * Mindestabstand zweier Impulse: wer den Zeiger schnell über mehrere Grenzen
 * zieht, spürt einzelne Ticks statt eines Brummens. Gemessen mit der
 * MONOTONEN Uhr (`performance.now()`), nie mit der Wanduhr: stellt ein
 * Zeitabgleich `Date.now()` zurück oder hält eine Testumgebung sie fest (die
 * Browser-Wächter tun das), bliebe nach dem ersten Impuls sonst alles still.
 */
export const HAPTIK_ABSTAND_MS = 45;

let letzter = Number.NEGATIVE_INFINITY;

function monoton(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/** Nur für Tests: der Abstands-Zähler beginnt von vorn. */
export function haptikZuruecksetzen(): void {
  letzter = Number.NEGATIVE_INFINITY;
}

function grobeEingabe(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Spielt einen Impuls. Gibt den benutzten Weg zurück (`'vibrate'` oder
 * `'schalter'`) oder null, wenn nichts gespielt wurde. `jetztMs` (monotone
 * Millisekunden) übergeben nur Tests.
 */
export function haptik(art: HaptikArt, jetztMs: number = monoton()): 'vibrate' | 'schalter' | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  if (!grobeEingabe()) return null;
  if (jetztMs - letzter < HAPTIK_ABSTAND_MS) return null;
  try {
    const nav = navigator as Navigator & { vibrate?: (muster: number | number[]) => boolean };
    if (typeof nav.vibrate === 'function') {
      const muster = HAPTIK_MUSTER[art];
      nav.vibrate(typeof muster === 'number' ? muster : [...muster]);
      letzter = jetztMs;
      return 'vibrate';
    }
    if (!('switch' in document.createElement('input'))) return null;
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.head.appendChild(label);
    label.click();
    label.remove();
    letzter = jetztMs;
    return 'schalter';
  } catch {
    return null;
  }
}
