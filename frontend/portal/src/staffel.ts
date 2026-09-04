import { useEffect, useRef } from 'react';

/**
 * **Die Listen-Staffel** (Bewegungs-Programm P6, Konzept
 * `data/vp-motion-konzept-m1/report.md` §6 Zeile „Listen/Karten": „260 ms,
 * 30 ms je Zeile, Deckel 8; beim Nachladen nur neue Zeilen; nie beim zweiten
 * Besuch").
 *
 * ## ⚠ DIE BEWEGUNG IST CSS, DIESES MODUL IST NUR DIE ERINNERUNG
 *
 * Gestaffelt wird über die Klasse `.vp-stagger` am BEHÄLTER (`index.css`,
 * Block „Bewegung · P6"): jedes Kind blendet 260 ms ein, das i-te mit
 * `i × --vp-motion-stagger` Verzögerung, gedeckelt bei 8. Daraus folgen zwei
 * Eigenschaften, die man nicht bauen muss, weil CSS sie schenkt:
 *
 * - **Beim Nachladen staffeln nur NEUE Zeilen.** Eine CSS-Animation läuft,
 *   wenn ein Element in den Baum kommt; die schon stehenden haben ihre
 *   längst hinter sich und rühren sich nicht.
 * - **Der Deckel ist eine Regel, keine Rechnung.** `:nth-child(n + 10)` trägt
 *   dieselbe Verzögerung wie das neunte Kind — kein Index reist durch TSX,
 *   keine Liste braucht eine `style`-Prop.
 *
 * ## ⚠ WAS CSS NICHT WEISS: DASS MAN DIESE LISTE SCHON GESEHEN HAT
 *
 * Genau dafür gibt es dieses Modul. Kehrt der Kunde auf eine Fläche zurück,
 * baut React ihre Zeilen NEU auf — CSS würde erneut staffeln, und eine Liste,
 * die bei jedem Besuch tanzt, ist Zierde statt Aussage (Prinzip 1). Die
 * gesehenen Listen stehen deshalb in einem modulweiten `Set`:
 *
 * - **Kein `localStorage`.** „Schon gesehen" gilt für DIESE Sitzung; über
 *   einen Neustart hinweg ist das Erscheinen der Liste wieder eine Nachricht.
 * - **Kein Zustand im Baum.** Der Behälter, der sich erinnern müsste, ist
 *   genau der, der beim Zurückkehren neu entsteht.
 */
const gesehen = new Set<string>();

/** Nur für Tests: die Sitzung vergisst, was sie gesehen hat. */
export function staffelZuruecksetzen(): void {
  gesehen.clear();
}

/** Nur für Tests: gilt diese Liste als schon gesehen? */
export function staffelGesehen(schluessel: string): boolean {
  return gesehen.has(schluessel);
}

/**
 * Die Klasse für den Behälter einer Liste — `'vp-stagger'` beim ersten Mal,
 * danach `''`.
 *
 * ⚠ **Der Eintrag ins `Set` passiert im EFFEKT, die Entscheidung im Render.**
 * Ein `Set.add` während des Renderns wäre eine Nebenwirkung, und React ruft
 * eine Komponente unter `StrictMode` in der Entwicklung zweimal auf — der
 * zweite Durchlauf hielte die Liste dann für schon gesehen und die Staffel
 * fiele ausgerechnet dort aus, wo man sie prüfen will. Die Entscheidung liegt
 * in einem `useRef` und steht damit für die Lebensdauer dieser Instanz fest.
 *
 * @param schluessel Benennt die LISTE, nicht ihren Inhalt — z. B.
 *   `'portfolio-anlagen'`. Zwei Flächen mit demselben Schlüssel gelten als
 *   dieselbe Liste; eine Liste, deren Schlüssel den Inhalt trägt, staffelte
 *   bei jedem Filterwechsel neu.
 */
export function useStaffel(schluessel: string): string {
  const entschieden = useRef<string | null>(null);
  if (entschieden.current === null) {
    entschieden.current = gesehen.has(schluessel) ? '' : 'vp-stagger';
  }
  useEffect(() => {
    gesehen.add(schluessel);
  }, [schluessel]);
  return entschieden.current;
}

/** Die Klasse an eine bestehende anhängen, ohne doppelte Leerzeichen. */
export function mitStaffel(basis: string, staffel: string): string {
  return staffel ? `${basis} ${staffel}` : basis;
}
