import type { Ebene2 } from '../../erloesEbenen';

/**
 * **Preise & Vergütung** — Bauteil 4 der Variante C (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.10 „Anatomie C" (4), Anatomie §3.2 (8)).
 *
 * Eine FLACHE Karte: zugeklappt genau eine Zeile 16/600 mit Chevron,
 * aufgeklappt die Tabelle der Ebene 2 (38 % / 62 %) und die Begriffe.
 *
 * ⚠ **Sie ist eine eigene Karte, kein Anhang der Speicher-Karte.** Preise
 *   beantworten eine andere Frage als der Speicher; als vierte Zeile IN einer
 *   fremden Karte wäre sie „Fläche in der Fläche" (§2 Prinzip 3).
 *
 * ⚠ **REINE ANZEIGE** — jede Zahl und jeder Satz kommt aus `erloesEbenen.ts`,
 *   damit dieselbe Rechnung nie zwei Formulierungen bekommt. EEG-Anlagen
 *   bekommen die drei Markt-Zeilen dort gar nicht erst (E11).
 */
export interface PreiseZeileProps {
  ebene2: Ebene2;
}

export function PreiseZeile({ ebene2 }: PreiseZeileProps) {
  return (
    <details className="vp-c-preise">
      <summary>
        {ebene2.kopf}
        <span className="vp-c-led-chev" aria-hidden="true" />
      </summary>
      <div className="vp-c-preise-body">
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
      </div>
    </details>
  );
}
