/**
 * X1 — die EINE „keine Daten ⇒ —, nie eine erfundene 0"-Regel als Helfer.
 *
 * Die Ehrlichkeitsregel des Produkts stand bisher an jeder Fläche neu: die
 * Kacheln des Cockpits schrieben `'–'` (Halbgeviertstrich), `format.fmtNum`
 * fiel auf `'-'` (Bindestrich) zurück und die Geld-Flächen auf `'—'`
 * (Geviertstrich) — auf EINEM Bildschirm nebeneinander (Audit X1). Hier steht
 * das Zeichen genau einmal, und die Prüfung „ist das überhaupt ein Wert?"
 * ebenfalls.
 *
 * Zwei Begriffe, bewusst getrennt:
 *
 * - {@link hasValue} — es liegt eine ECHTE Zahl vor. Eine gemessene `0` IST
 *   ein Wert (0 kW Netzbezug heißt „ausgeglichen", nicht „unbekannt").
 * - {@link isReportedTotal} — für SUMMEN aus dem Historie-Endpunkt. Der Server
 *   liefert an einem Tag ohne einen einzigen Messwert `pvGenerationKwh: 0.0`
 *   (statt `null` wie bei den Kostenfeldern), also eine erfundene 0 (Audit V2).
 *   Bis der Server das Feld ehrlich `null` macht, gilt hier eine 0-Summe als
 *   „nicht berichtet" — lieber „—" als eine Zahl, die es nicht gibt.
 *
 * Rein + framework-frei (der `plausible.ts`-Präzedenzfall); unit-getestet in
 * `nodata.test.ts`.
 */
import { fmtNum } from './format';

/** Das EINE Zeichen für „kein Wert" auf den Kundenflächen. */
export const NO_DATA = '—';

/** true, wenn eine echte, endliche Zahl vorliegt (eine gemessene 0 zählt). */
export function hasValue(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Zahl + Einheit, sonst {@link NO_DATA} — nie eine erfundene 0. Ersetzt
 * `fmtNum(v, unit)` überall dort, wo ein fehlender Wert sichtbar wird.
 */
export function numOrNoData(
  v: number | null | undefined,
  unit: string,
  digits = 1,
): string {
  return hasValue(v) ? fmtNum(v, unit, digits) : NO_DATA;
}

/**
 * Eine Summe aus dem Historie-Endpunkt, die WIRKLICH berichtet wurde.
 * Absent/NaN → false; **0 → false**, siehe die 0-Bucket-Erfindung oben.
 */
export function isReportedTotal(v: number | null | undefined): v is number {
  return hasValue(v) && v !== 0;
}
