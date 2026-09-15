import { FUNKTIONEN_UNBEKANNT, type FunktionenKarteAbschnitt } from '../uebersicht';
import './FunktionenKarte.css';

/**
 * Die Karte „Funktionen" der Unternehmens- und der Standort-Übersicht (UEMS
 * AP-01 IP-8, E5 = A, E6 = C): je Funktion, je Standort der Zustand und der
 * nächste Schritt — „Messen & Auswerten … einrichten" oder „Anlage aufnehmen".
 * „Steuern & Optimieren" steht nur da, wo eine Anlage teilnimmt; ein Standort,
 * an dem nur gemessen wird, schweigt darüber (`uebersicht.steuernSpricht`).
 *
 * ⚠ Der nächste Schritt ist ein BENANNTER Hinweis, kein Knopf: die Assistenten
 * „Messen & Auswerten" und „Steuern & Optimieren" (IP-9a/IP-10a) gibt es noch
 * nicht, und ein Knopf ohne Ziel wäre eine Sackgasse (Captain zu PR 771). Kommt
 * ein Assistent, wird sein Hinweis zu seinem Einstieg.
 *
 * Render-only: Zustand, Satz und Schritt entstehen in `uebersicht.funktionenKarte`.
 */
export function FunktionenKarte({
  abschnitte,
  laedt = false,
}: {
  /** `null` = die Funktionen sind nicht abrufbar. */
  abschnitte: FunktionenKarteAbschnitt[] | null;
  laedt?: boolean;
}) {
  return (
    <section className="vp-funktionen-karte" aria-labelledby="vp-funktionen-karte-titel" data-testid="funktionen-karte">
      <h2 id="vp-funktionen-karte-titel" className="vp-fk-titel">
        Funktionen
      </h2>
      {laedt ? (
        <p className="vp-fk-hinweis">Wird geladen …</p>
      ) : abschnitte == null ? (
        <p className="vp-fk-hinweis">{FUNKTIONEN_UNBEKANNT}</p>
      ) : (
        <div className="vp-fk-abschnitte">
          {abschnitte.map((a) => (
            <div key={a.funktion} className="vp-fk-abschnitt" data-funktion={a.funktion}>
              <h3 className="vp-fk-funktion">{a.label}</h3>
              {a.verbreitung && <p className="vp-fk-verbreitung">{a.verbreitung}</p>}
              <ul className="vp-fk-zeilen">
                {a.zeilen.map((z) => (
                  <li key={z.standortId} className={`is-${z.ton}`} data-zustand={z.zustand}>
                    <p className="vp-fk-zustand">
                      <span className="vp-fk-punkt" aria-hidden="true" />
                      {/* Name und Satz umbrechen NEBEN dem Punkt — nie der Punkt allein in einer Zeile. */}
                      <span className="vp-fk-text">
                        {z.name && <span className="vp-fk-standort">{z.name}</span>}
                        <span className="vp-fk-satz">{z.satz}</span>
                      </span>
                    </p>
                    {z.schritt && (
                      <p className="vp-fk-schritt">
                        <span className="vp-fk-schritt-wort">Nächster Schritt:</span> {z.schritt}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
