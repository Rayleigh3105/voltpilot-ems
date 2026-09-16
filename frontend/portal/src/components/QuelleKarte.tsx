import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  HISTORIE,
  OHNE_BEWERTUNG,
  QUELLE_BINDEN,
  QUELLE_TITEL,
  VERGLEICHSQUELLE_HINZUFUEGEN,
  type QuelleGroesseKarte,
} from '../quelleBinden';
import './QuelleKarte.css';

/**
 * Die Quelle-Karte der Messstellen-Seite (UEMS AP-04 IP-14, Mockups R2 · V1, E3): je Messgröße die
 * führende Quelle und jede Vergleichsquelle — mit ihren Werten NEBENEINANDER —, dazu die Historie
 * der führenden Quellen mit jeder Lücke.
 *
 * ⚠ E3: hier wird nichts bewertet. Kein Prozentwert, keine Abweichung, keine Ampel, kein stiller
 * Ersatz. Der Kunde sieht, was die eine und was die andere Quelle sagt — das ist der ganze Gewinn.
 *
 * ⚠ Die Werte stehen auch bei 375 px NEBENEINANDER (`auto-fit`, 9 rem): gestapelt wären es zwei
 * Zahlen untereinander, und genau der Vergleich, für den die zweite Quelle da ist, ginge verloren.
 */
export function QuelleKarte({
  karten,
  darfBinden,
  onBinden,
  onVergleich,
}: {
  karten: QuelleGroesseKarte[];
  darfBinden: boolean;
  onBinden: (karte: QuelleGroesseKarte) => void;
  onVergleich: (karte: QuelleGroesseKarte) => void;
}) {
  return (
    <section className="vp-qk" aria-labelledby="vp-qk-titel" data-testid="quelle-karte">
      <h2 id="vp-qk-titel">{QUELLE_TITEL}</h2>
      {karten.map((k) => (
        <div key={k.schluessel} className="vp-qk-groesse" data-testid={`quelle-groesse-${k.schluessel}`}>
          <h3>{k.titel}</h3>
          {k.werte.length > 0 ? (
            <ul className="vp-qk-werte" data-testid="quelle-werte">
              {k.werte.map((w) => (
                <li key={w.id} className={w.fuehrend ? 'vp-qk-wert is-fuehrend' : 'vp-qk-wert'}>
                  <span className="vp-qk-rolle">
                    {w.rolle}
                    {w.geplant && <Badge variant="tint">geplant</Badge>}
                  </span>
                  <span className="vp-qk-quelle">{w.quelle}</span>
                  {w.wert !== null ? (
                    <>
                      <span className="vp-qk-zahl">{w.wert}</span>
                      <span className="vp-qk-stand">{w.stand}</span>
                    </>
                  ) : (
                    <span className="vp-qk-ohne">{w.ohneWert}</span>
                  )}
                  {w.anteil && <span className="vp-qk-anteil">{w.anteil}</span>}
                  <span className="vp-qk-zeitraum">{w.zeitraum}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="vp-qk-leer">{k.leerFuehrend}</p>
          )}

          {k.werte.length > 1 && <p className="vp-qk-hinweis">{OHNE_BEWERTUNG}</p>}
          {k.werte.length > 0 && k.leerVergleich && <p className="vp-qk-leer">{k.leerVergleich}</p>}

          <p className="vp-qk-knoepfe">
            {darfBinden && k.fuehrendMoeglich && (
              <button type="button" className="vp-qk-knopf" onClick={() => onBinden(k)}>
                <Icon name="activity" size={14} />
                {QUELLE_BINDEN}
              </button>
            )}
            {darfBinden && (
              <button type="button" className="vp-qk-knopf" onClick={() => onVergleich(k)}>
                <Icon name="activity" size={14} />
                {VERGLEICHSQUELLE_HINZUFUEGEN}
              </button>
            )}
          </p>

          {k.historie.length > 1 && (
            <details className="vp-qk-historie">
              <summary>
                {HISTORIE} ({k.historie.length})
              </summary>
              <ol>
                {k.historie.map((h) => (
                  <li key={h.schluessel} className={`vp-qk-h is-${h.zustand}`}>
                    <span className="vp-qk-punkt" aria-hidden="true" />
                    <span className="vp-qk-h-text">
                      <span className="vp-qk-h-wert">{h.wert}</span>
                      <span className="vp-qk-h-zeit">{h.zeitraum}</span>
                    </span>
                    {h.marke && <Badge variant={h.zustand === 'geplant' ? 'tint' : 'ok'}>{h.marke}</Badge>}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      ))}
    </section>
  );
}
