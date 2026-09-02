import { steuerungFormel, type SteuerungFormelInput } from '../erloesKomposition';
import {
  FORMEL_AUSLOESER_SCHRITTE,
  speicherSchritte,
  type RechenZeile,
  type SpeicherSchritteInput,
} from '../erloesEbenen';
import './SteuerungFormel.css';

/**
 * **Rechenzeilen** — „Formel = Betrag" in Festbreitenschrift plus ein Halbsatz
 * Herkunft (Konzept `vp-erloese-seite-konzept-e2` §3.3, Revision 2).
 *
 * Sie ersetzen die PROSA der alten Erklärung durch dieselbe Rechnung mit den
 * EINGESETZTEN Zahlen — die Tiefe bleibt vollständig, nur die Form wechselt.
 * Geteilt von Ebene 1 der Ergebnis-Zeilen und den Speicher-Schritten, damit
 * dieselbe Rechnung nirgends zweimal formuliert wird.
 */
export function RechenZeilen({ zeilen, kopf }: { zeilen: RechenZeile[]; kopf?: string }) {
  return (
    <div className="vp-rz">
      {kopf && <p className="vp-rz-kopf">{kopf}</p>}
      <ul className="vp-rz-list">
        {zeilen.map((z, i) => (
          <li key={`${i}-${z.formel}`}>
            <span className="vp-rz-fx">{z.formel}</span>
            <span className="vp-rz-hk">{z.herkunft}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Die Speicher-Erklärung als **Schritte 1–5** — der Aufklapper unter dem
 * Speicher-Block der Ergebnis-Karte.
 *
 * Inhaltlich ist es die vom Captain freigegebene Erklärung von
 * `steuerungFormel()`; hier steht sie mit den eingesetzten Zahlen und in
 * Schritten. Die Prosa-Fassung (`SteuerungFormel`) bleibt unverändert für die
 * Flächen, die keine Server-Summen zur Hand haben (Cockpit, Portfolio).
 */
export function SpeicherSchritte({
  input,
  className,
}: {
  input: SpeicherSchritteInput;
  className?: string;
}) {
  const zeilen = speicherSchritte(input);
  if (zeilen.length === 0) return null;
  return (
    <details className={className ? `vp-formel ${className}` : 'vp-formel'}>
      <summary>{FORMEL_AUSLOESER_SCHRITTE}</summary>
      <div className="vp-formel-body">
        <RechenZeilen zeilen={zeilen} />
      </div>
    </details>
  );
}

/**
 * „Wie wird das berechnet?" — der Aufklapper UNTER dem Steuerungs-Chip
 * („davon 3,73 € durch VoltPilots Steuerung"), Captain-Wunsch 01.09.2026.
 *
 * Er ist bewusst ein `<details>` und kein Tooltip: die Antwort ist eine
 * Rechnung mit drei Zeilen und zwei Preisen, und die passt in keinen
 * Einzeiler (dasselbe Muster wie der Technik-Blick des Fahrplan-„Warum").
 * Zugeklappt kostet er GENAU eine ruhige Zeile — die Karte darf durch ihn
 * nicht wachsen.
 *
 * Reine Anzeige: JEDER Satz kommt aus `steuerungFormel()`, damit die vier
 * Flächen (Cockpit gross + Telefon, Steuerung, Portfolio, Erlöse-Welt) über
 * dieselbe Zahl nie Verschiedenes behaupten können.
 */
export function SteuerungFormel({
  input,
  className,
}: {
  input: SteuerungFormelInput;
  className?: string;
}) {
  const f = steuerungFormel(input);
  return (
    <details className={className ? `vp-formel ${className}` : 'vp-formel'}>
      <summary>{f.ausloeser}</summary>
      <div className="vp-formel-body">
        <p className="vp-formel-kern">{f.kern}</p>

        <dl className="vp-formel-rechnung">
          {f.zeilen.map((z) => (
            <div key={z.label} className="vp-formel-zeile">
              <dt>{z.label}</dt>
              <dd>{z.text}</dd>
            </div>
          ))}
        </dl>

        <dl className="vp-formel-preise">
          {f.preise.map((p) => (
            <div key={p.label} className="vp-formel-zeile">
              <dt>{p.label}</dt>
              <dd>
                {p.text}
                {p.zusatz && <span className="vp-formel-zusatz">{p.zusatz}</span>}
              </dd>
            </div>
          ))}
        </dl>

        {f.historik && <p className="vp-formel-historik">{f.historik}</p>}

        <p className="vp-formel-hinweis">{f.hinweis}</p>
      </div>
    </details>
  );
}
