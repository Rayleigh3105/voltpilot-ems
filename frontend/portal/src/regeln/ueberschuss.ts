/**
 * **„Solar-Überschuss" als eigene Bedingung des Baukastens** (Konzept
 * `vp-steuerung-konzept-b3` §3.3, Stufe 2).
 *
 * Der Kunde fragt „lauf, wenn mehr Sonne da ist als das Haus braucht" — bis
 * hierher gab es das nur als REZEPT-Vorbelegung, also musste er die Absicht
 * vorher kennen, um sie zu finden. Jetzt steht sie dort, wo er ohnehin
 * hinschaut: in der Bedingungs-Auswahl.
 *
 * ⚠ **SIE WIRD VON EINER ANDEREN MASCHINE AUSGEFÜHRT, und das ist kein
 * Behelf.** Der Überschuss ist kein Messwert EINES Geräts, sondern eine
 * Differenz (PV − Haus), die auf dem Gerät laufend gebildet wird; auswerten
 * kann sie ausschließlich die Verbraucher-Regel-Maschine, deren Signal
 * `site.pv_surplus_kw` genau das ist. Der Wenn/Dann-Baukasten baut dagegen ein
 * Flow-Dokument aus Katalog-Bausteinen — und **einen Baustein dafür gibt es
 * nicht**; ihn im Portal zu erfinden hieße, eine Regel bauen zu lassen, die
 * validiert, simuliert und dann beim Ausrollen abgelehnt wird (der
 * dokumentierte Katalog-Gleichlauf: api ⟷ Portal ⟷ flowc).
 *
 * Das Konzept sieht genau das vor: „die Maschinen (`consumer_policy`-Compiler,
 * generierte Flows) bleiben — der Builder ist eine Projektion, nie ein zweites
 * Format." Der Baukasten ist die EINE Tür, hinter ihr läuft die Maschine, die
 * es kann.
 *
 * PURE + unit-getestet (`ueberschuss.test.ts`); die Fläche rendert nur.
 */

/** Das Wort in der Bedingungs-Auswahl. */
export const UEBERSCHUSS_LABEL = 'Solar-Überschuss';

/**
 * Warum diese Bedingung ihren eigenen Weg geht — ein Satz, der die MASCHINE
 * nicht nennt (sie ist für den Kunden unsichtbar), sondern das Ergebnis.
 */
export const UEBERSCHUSS_HINWEIS =
  'Den Solar-Überschuss rechnet Ihr Gerät laufend selbst aus. VoltPilot legt '
  + 'dafür eine Regel an, die direkt auf dem Gerät läuft — sie reagiert damit '
  + 'sofort, auch wenn die Verbindung gerade weg ist.';

/** Die Beschriftung des Knopfes, der dorthin führt. */
export const UEBERSCHUSS_WEITER = 'Regel für Solar-Überschuss anlegen';

/**
 * Der Grund, warum „Weiter zur Prüfung" mit einer Überschuss-Bedingung nicht
 * geht. Ein Knopf, der in eine Ablehnung liefe, wäre schlimmer als ein
 * benannter Einwand.
 */
export const UEBERSCHUSS_BLOCKIERT =
  'Mit „Solar-Überschuss" geht es hier nicht weiter — legen Sie die Regel über '
  + 'den Knopf daneben an.';

/**
 * Ob die Wahl „Solar-Überschuss" überhaupt angeboten werden darf: nur, wenn
 * die Fläche einen Weg dorthin hat. Ein Eintrag ohne Ziel wäre eine Sackgasse.
 */
export function bietetUeberschuss(hatWeg: boolean): boolean {
  return hatWeg;
}

/** Ob eine der gewählten Bedingungs-Arten der Überschuss ist. */
export function hatUeberschuss(arten: readonly string[]): boolean {
  return arten.includes('surplus');
}
