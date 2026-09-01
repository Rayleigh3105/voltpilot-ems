import { steuerungFormel, type SteuerungFormelInput } from '../erloesKomposition';
import './SteuerungFormel.css';

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

        <p className="vp-formel-hinweis">{f.hinweis}</p>
      </div>
    </details>
  );
}
