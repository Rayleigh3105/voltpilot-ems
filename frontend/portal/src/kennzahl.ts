/**
 * DIE KENNZAHLEN-SKALA (Portfolio Revision 2, Scout `vp-portfolio-konzept-r2`
 * §5.4 + Mockup `08-kennzahlen-skala.html`).
 *
 * Eine Zahl im Portal trägt genau EINE Form: Label oben (12 px, Satzschreibung,
 * nie versal), Wert tabular in der Marken-Tinte, Einheit LEISE daneben,
 * darunter höchstens eine Unterzeile, die die Grundlage nennt. Die frühere
 * `KpiCard` (40-px-Icon-Kachel in Kategoriefarbe, Zahl 24/800, Radius 16) ist
 * damit auf der Flotten-Ebene abgelöst — neun Farbflächen konkurrierten dort
 * mit ihren eigenen Zahlen, und die Einheit war Teil der fetten Zahl.
 *
 * **Warum ein eigenes Modul und nicht die Komponente:** die Zellen entstehen in
 * REINEN Ableitungen (`portfolioCockpit.ts` heute, das Anlagen-Cockpit in S6),
 * und eine reine Ableitung importiert nie eine React-Datei. Die Komponente
 * `components/KennzahlLeiste.tsx` rendert diese Form und sonst nichts.
 *
 * ⚠ **Die Einheit ist ein EIGENES Feld, nie ein Teil von `wert`.** Nur so kann
 * sie leise gesetzt werden (13 px grau) und trotzdem mit ihrer Zahl auf einer
 * Zeile bleiben; `fmtNum` liefert beides zusammen und ist für die Skala
 * deshalb bewusst nicht die Quelle.
 */

/** Eine Zelle der Kennzahlen-Leiste. */
export interface KennzahlZelle {
  /** Stabiler Schlüssel (der Baustein, der sie beisteuert). */
  id: string;
  /** Das Label über der Zahl — Satzschreibung, nie versal. */
  label: string;
  /**
   * Der Wert OHNE Einheit, schon deutsch formatiert. `null` gibt es hier
   * nicht: eine Kennzahl ohne Wert wird gar nicht erst gebaut (die
   * M0-Ehrlichkeit „kein Baustein ohne Wert").
   */
  wert: string;
  /** Die leise Einheit; null = der Wert trägt keine (z. B. eine Stückzahl). */
  einheit: string | null;
  /** Die Unterzeile, die die Grundlage NENNT; null = es gibt nichts zu sagen. */
  unterzeile: string | null;
  /**
   * `warn` färbt NUR die Unterzeile gedämpft-amber — sie ist dann ein
   * Vorbehalt („2 von 3 Anlagen melden gerade"), nie eine Störung. Die ZAHL
   * bleibt in jeder Lage die Marken-Tinte; eine rote Kennzahl wäre eine
   * Behauptung über den Wert selbst.
   */
  ton?: 'ruhig' | 'warn';
  /**
   * Die LEIT-Kennzahl der Seite (30 px statt 22 px). Es gibt höchstens EINE je
   * Leiste — sie ersetzt den früheren Geld-Held im Marken-Verlauf
   * (Captain-Entscheid E2: „Held entfällt; die Tonalität lebt im Wort").
   */
  lead?: boolean;
}
