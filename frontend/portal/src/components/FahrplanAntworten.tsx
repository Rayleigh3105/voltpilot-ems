/**
 * Die ANTWORTEN des Tagesbilds (E1) und die WAAGE der gewählten
 * Viertelstunde (E5). Render-only: jeder Satz kommt aus
 * `fahrplanAntworten.ts` bzw. `fahrplanWaage.ts`.
 *
 * Eine Antwort steht als ZEILE in Stichworten (Überblick 20.10.2026:
 * „Als Nächstes · 18:15 Einspeisen") und trägt ihren ORT im Bild: ein Tipp
 * zeigt die Stelle (am Telefon dreht die Uhr den Zeiger dorthin, am Rechner
 * markiert das Tagesband sie) und klappt den ganzen Satz mit seinem
 * Ehrlichkeits-Abzeichen auf.
 */

import type { Antwort, AntwortKey } from '../fahrplanAntworten';
import type { Waage } from '../fahrplanWaage';
import { fmtNum } from '../format';
import { ProvBadge } from './HistorieWelt';

export function FahrplanAntworten({
  antworten,
  gewaehlt,
  onWahl,
  form,
  nachtragHref,
  erloeseHref,
  onSonnenstromOeffnen,
}: {
  antworten: Antwort[];
  /** Die aufgeklappte Antwort; null = keine. */
  gewaehlt: AntwortKey | null;
  /** Ein Tipp auf eine Kachel: ihren ganzen Satz zeigen (und ihre Stelle im Bild). */
  onWahl: (a: Antwort) => void;
  /**
   * `kacheln` = zwei, drei Kacheln nebeneinander unter der Uhr (Telefon);
   * `spalten` = Spalten in der Jetzt-Karte (Rechner), mit leiser Zeile.
   */
  form: 'kacheln' | 'spalten';
  /** Wohin der Nachtrag-Satz der Geld-Antwort führt (Speicher-Stammdaten). */
  nachtragHref?: string;
  /** Wohin „Zu den Erlösen" führt. */
  erloeseHref?: string;
  /**
   * Die Sonnen-Erzählung (§4.3/§4.5): öffnet „Ihr Sonnenstrom heute" statt
   * zu den Erlösen zu führen (`details === 'sonnenstrom'`); ohne Angabe
   * bleibt der Knopf weg.
   */
  onSonnenstromOeffnen?: () => void;
}) {
  if (antworten.length === 0) return null;
  const offen = antworten.find((a) => a.key === gewaehlt) ?? null;
  return (
    <div className={`vp-antw-gruppe is-${form}`}>
      <ul
        className={`vp-antw is-${form}`}
        style={{ ['--vp-antw-n' as string]: String(antworten.length) }}
        aria-label="Antworten zum Fahrplan"
      >
        {antworten.map((a) => (
          <li key={a.key} className={`vp-antw-zeile${gewaehlt === a.key ? ' is-gewaehlt' : ''}`}>
            <button
              type="button"
              className="vp-antw-knopf"
              aria-expanded={gewaehlt === a.key}
              aria-label={`${a.frage} ${a.antwort}`}
              onClick={() => onWahl(a)}
            >
              <span className="vp-antw-label">{a.kurz.label}</span>
              <span className={`vp-antw-wert${a.key === 'bringt' ? ' is-geld' : ''}`}>{a.kurz.wert}</span>
              {form === 'spalten' && a.kurz.meta && <span className="vp-antw-meta">{a.kurz.meta}</span>}
            </button>
          </li>
        ))}
      </ul>
      {offen && (
        <div className="vp-antw-detail" role="status">
          <p className="vp-antw-satz">
            <ProvBadge art={offen.art === 'gemessen' ? 'gemessen' : 'geplant'} /> {offen.antwort}
          </p>
          {offen.zusatz &&
            (offen.nachtrag && nachtragHref ? (
              <a className="vp-antw-zusatz" href={nachtragHref}>
                {offen.zusatz}
              </a>
            ) : (
              <p className="vp-antw-zusatz">{offen.zusatz}</p>
            ))}
          {offen.notiz && <p className="vp-antw-zusatz">{offen.notiz}</p>}
          {offen.details === 'erloese' && erloeseHref && (
            <a className="vp-tb-link" href={erloeseHref}>
              Zu den Erlösen ›
            </a>
          )}
          {offen.details === 'sonnenstrom' && onSonnenstromOeffnen && (
            <button type="button" className="vp-tb-link" onClick={onSonnenstromOeffnen}>
              Zu Ihrem Sonnenstrom ›
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Die WAAGE: zwei Werte je kWh als Balken nebeneinander, die gewählte Seite
 * hervorgehoben, darunter der eine Satz. Beim Warten spricht nur die Marge
 * des Optimierers (keine Balken).
 */
export function FahrplanWaage({
  waage,
  zeit,
  fuss,
}: {
  waage: Waage;
  /** Die Uhrzeit hinter der Frage („jetzt", „um 15:30 Uhr"); ohne: nur die Frage. */
  zeit?: string;
  /** Unter dem Satz: der Weg zu allen Gründen der Viertelstunde. */
  fuss?: React.ReactNode;
}) {
  const max = waage.seiten ? Math.max(...waage.seiten.map((s) => s.ct), 0.1) : 1;
  return (
    <section className="vp-waage" aria-label="Die Waage dieser Viertelstunde">
      <p className="vp-waage-frage">
        {waage.frage}
        {zeit && <span className="vp-waage-zeit"> {zeit}</span>}
      </p>
      {waage.seiten && (
        <div className="vp-waage-seiten">
          {waage.seiten.map((s, k) => (
            <div key={s.label} className={`vp-waage-seite${waage.gewaehlt === k ? ' is-gewaehlt' : ''}`}>
              <span className="vp-waage-label">{s.label}</span>
              <span className="vp-waage-balken" aria-hidden="true">
                <i
                  className={s.kosten ? 'is-kosten' : ''}
                  style={{ width: `${Math.max(4, (s.ct / max) * 100)}%` }}
                />
              </span>
              <span className="vp-waage-wert">{fmtNum(s.ct, 'ct/kWh', 1)}</span>
              <small className="vp-waage-hinweis">{s.hinweis}</small>
            </div>
          ))}
        </div>
      )}
      <p className={`vp-waage-urteil${waage.gleichstand ? ' is-gleich' : ''}`}>{waage.urteil}</p>
      {fuss}
    </section>
  );
}
