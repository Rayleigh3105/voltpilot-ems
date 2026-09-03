import type { Ebene1 } from '../erloesEbenen';
import { RechenZeilen } from './SteuerungFormel';

/**
 * **Ebene 1 als Fläche** (Konzept `vp-erloese-seite-konzept-e2`
 * §3.3/§3.4/§3.11, Revision 2).
 *
 * Sie ist DISCLOSURE (das `ChartExplain`/`<details>`-Muster des Hauses):
 * zugeklappt kostet sie eine ruhige Zeile, aufgeklappt trägt sie die volle
 * Rechen-Tiefe. Reine Anzeige — jede Zahl und jeder Satz kommt aus
 * `erloesEbenen.ts`, damit dieselbe Rechnung nie zwei Formulierungen bekommt.
 *
 * ⚠ Sie hat seit P2 KEINE Fläche mehr, sondern eine 2-px-Linie links
 * (§3.2 (5)) — ein grauer Grund in einer Karte wäre „Fläche in der Fläche".
 */

/** Ebene 1 EINER Zeile — sie wohnt IM Akkordeon der Zeile, ohne zweiten Titel. */
export function Ebene1Panel({ ebene1 }: { ebene1: Ebene1 }) {
  return (
    <div className="vp-e1">
      <RechenZeilen zeilen={ebene1.zeilen} kopf={ebene1.kopf} />
    </div>
  );
}

/* ⚠ `Ebene2Panel` ist mit Variante C ENTFALLEN. „Preise & Vergütung" ist dort
 * keine vierte Zeile in einer fremden Karte mehr, sondern eine EIGENE flache
 * Karte: `components/erloese/PreiseZeile.tsx` (§3.10 „Anatomie C" (4)). Der
 * Inhalt — Tabelle und Begriffe — ist wörtlich derselbe und kommt weiter aus
 * `erloesEbenen.ts`. */
