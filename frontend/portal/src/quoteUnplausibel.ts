/**
 * Autarkie und Eigenverbrauch außerhalb 0…100 % (AP-10 E16 Nr. 5).
 *
 * Eine Quote ist ein Anteil; unter 0 oder über 100 % kann sie keiner sein. Dann
 * passen die Messwerte nicht zusammen — mehr Netzbezug als Verbrauch, mehr
 * Einspeisung als Erzeugung. Früher bog der Server solche Werte still auf 0
 * bzw. 100 % zurück: eine 105 sah wie ein perfektes Ergebnis aus und verschwieg
 * genau das, was der Kunde wissen müsste. Seither reist der Wert ungeklemmt,
 * die Historie-Summen tragen `autarkieUnplausibel`/`eigenverbrauchUnplausibel`,
 * und jede Fläche SAGT es — mit dem Satz aus dem Bilanz-Vertrag, nicht mit einem
 * eigenen Wortlaut.
 *
 * ⚠ Kein Balken, kein Bogen für eine unplausible Quote: eine Füllung bräuchte
 * wieder eine Klemme. Die Zahl steht, der Satz steht daneben.
 */
import { NBSP } from './format';
import { SATZ_REST_NEGATIV } from './uemsBilanz';

const MINUS = '−';

/**
 * Vorgabe AN: das Server-Kennzeichen kann eine Quote nur unplausibel MACHEN, nie
 * eine Zahl außerhalb 0…100 % entschuldigen. Fehlt es (ein älterer Server), wird
 * am Wertebereich geprüft — ein fehlendes Kennzeichen heißt nicht „plausibel".
 */
export function quoteUnplausibel(pct: number, flag?: boolean | null): boolean {
  return flag === true || pct < 0 || pct > 100;
}

/**
 * Die Zahl einer unplausiblen Quote: ganze Prozent, negativ mit U+2212 wie im
 * Bilanz-Vertrag. Läge die gerundete Zahl wieder IN 0…100 (100,4 %), steht eine
 * Nachkommastelle da — sonst läse sich die Meldung wie eine glatte 100.
 */
export function quoteZahl(pct: number): string {
  const ganz = Math.round(pct);
  const stellen = ganz >= 0 && ganz <= 100 ? 1 : 0;
  const betrag = Math.abs(pct).toLocaleString('de-DE', {
    minimumFractionDigits: stellen,
    maximumFractionDigits: stellen,
  });
  return `${pct < 0 ? MINUS : ''}${betrag}${NBSP}%`;
}

/** „Messwerte passen nicht zusammen (−20 %)" — `SATZ_REST_NEGATIV`, wörtlich. */
export function quoteSatz(pct: number): string {
  return SATZ_REST_NEGATIV.replace('{zahl}', quoteZahl(pct));
}
