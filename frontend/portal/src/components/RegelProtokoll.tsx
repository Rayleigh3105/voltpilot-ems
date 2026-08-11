/**
 * Das kompakte GESAMT-PROTOKOLL unter der Regel-Liste (Einheitsmodell Stufe 5b,
 * Konzept `vp-komponenten-einheit-h2` Teil 5b.6) — reiner Renderer über
 * `regeln/verlauf.ts`.
 *
 * Es ist bewusst ein Aufklapper und KEIN eigener Navigationspunkt: „was hat
 * meine Anlage zuletzt getan" ist eine Anschlussfrage an die Liste darüber,
 * keine eigene Fläche. Zugeklappt kostet es eine Zeile.
 */
import type { ProtokollView } from '../regeln/verlauf';
import './Regeln.css';

export function RegelProtokoll({ view }: { view: ProtokollView }) {
  return (
    <details className="vp-regel-protokoll">
      <summary>
        {view.titel}
        {view.zeilen.length > 0 && (
          <span className="vp-regel-protokoll-n">{view.zeilen.length}</span>
        )}
      </summary>
      {view.zeilen.length > 0 ? (
        <ul className="vp-regel-protokoll-list">
          {view.zeilen.map((z) => (
            <li key={z.key} className={`ton-${z.ton}`}>
              {z.regel && <strong>{z.regel}</strong>}
              <span>{z.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vp-regeld-note">{view.leer}</p>
      )}
      {view.note && <p className="vp-regeld-note">{view.note}</p>}
    </details>
  );
}
