import type { Ebene1, Ebene2 } from '../erloesEbenen';
import { RechenZeilen } from './SteuerungFormel';

/**
 * **Ebene 1 und Ebene 2 als Fläche** (Konzept `vp-erloese-seite-konzept-e2`
 * §3.3/§3.4/§3.11, Revision 2).
 *
 * Beide sind DISCLOSURE (das `ChartExplain`/`<details>`-Muster des Hauses):
 * zugeklappt kosten sie eine ruhige Zeile, aufgeklappt tragen sie die volle
 * Rechen-Tiefe. Reine Anzeige — jede Zahl und jeder Satz kommt aus
 * `erloesEbenen.ts`, damit dieselbe Rechnung nie zwei Formulierungen bekommt.
 */

/** Ebene 1 EINER Zeile — sie wohnt IM Akkordeon der Zeile, ohne zweiten Titel. */
export function Ebene1Panel({ ebene1 }: { ebene1: Ebene1 }) {
  return (
    <div className="vp-e1">
      <RechenZeilen zeilen={ebene1.zeilen} kopf={ebene1.kopf} />
    </div>
  );
}

/** Ebene 2 — „Preise & Vergütung" als Tabelle, darunter die Begriffe. */
export function Ebene2Panel({ ebene2 }: { ebene2: Ebene2 }) {
  return (
    <details className="vp-e2">
      <summary>{ebene2.kopf}</summary>
      <table className="vp-e2t">
        <tbody>
          {ebene2.zeilen.map((z) => (
            <tr key={z.label}>
              <th scope="row">{z.label}</th>
              <td>{z.wert}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ebene2.glossar.length > 0 && (
        <details className="vp-gl">
          <summary>Begriffe</summary>
          <dl className="vp-gl-list">
            {ebene2.glossar.map((g) => (
              <div key={g.begriff}>
                <dt>{g.begriff}</dt>
                <dd>{g.erklaerung}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </details>
  );
}
