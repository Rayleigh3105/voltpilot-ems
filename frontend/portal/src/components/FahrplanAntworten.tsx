/**
 * Die ANTWORTEN unter dem Tagesbild (E1) und die WAAGE der gewählten
 * Viertelstunde (E5). Render-only: jeder Satz kommt aus
 * `fahrplanAntworten.ts` bzw. `fahrplanWaage.ts`.
 *
 * Jede Antwort trägt ihr Ehrlichkeits-Abzeichen („Geplant"/„Gemessen") und
 * ihren ORT im Bild: ein Tipp zeigt die Stelle (am Telefon dreht die Uhr den
 * Zeiger dorthin, am Rechner markiert der Bildfahrplan sie).
 */

import { Icon } from '../../designsystem/components/core/Icon';
import type { Antwort, AntwortKey } from '../fahrplanAntworten';
import type { Waage } from '../fahrplanWaage';
import { fmtNum } from '../format';
import { ProvBadge } from './HistorieWelt';

export function FahrplanAntworten({
  antworten,
  gewaehlt,
  onWahl,
  form,
}: {
  antworten: Antwort[];
  /** Die Antwort, deren Stelle gerade gezeigt wird; null = keine. */
  gewaehlt: AntwortKey | null;
  /** Ein Tipp auf eine Antwort: ihre Stelle zeigen und sie ausführlich nennen. */
  onWahl: (a: Antwort) => void;
  /**
   * `reihe` = alle nebeneinander — am Telefon die einzige Form, in der ALLE
   * Antworten im ersten Bildschirm beginnen (E9); `liste` = untereinander,
   * neben der Uhr. In der schmalen Reihe steht der Zusatz erst im Banner.
   */
  form: 'reihe' | 'reihe-schmal' | 'liste';
}) {
  if (antworten.length === 0) return null;
  const zusatzZeigen = form !== 'reihe-schmal';
  return (
    <ul
      className={`vp-antw is-${form}`}
      style={{ ['--vp-antw-n' as string]: String(antworten.length) }}
      aria-label="Antworten zum Fahrplan"
    >
      {antworten.map((a) => (
        <li key={a.key} className={`vp-antw-kachel${gewaehlt === a.key ? ' is-gewaehlt' : ''}`}>
          <button
            type="button"
            className="vp-antw-knopf"
            aria-pressed={gewaehlt === a.key}
            onClick={() => onWahl(a)}
          >
            {/* Frage, dann gleich die Antwort - am Telefon beginnt sie so noch
                im ersten Bildschirm; das Abzeichen folgt darunter. */}
            <span className="vp-antw-frage">{a.frage}</span>
            <span className="vp-antw-text">{a.antwort}</span>
            <span className="vp-antw-kopf">
              <ProvBadge art={a.art === 'gemessen' ? 'gemessen' : 'geplant'} />
              {a.zeit && <span className="vp-antw-zeit">ab {a.zeit}</span>}
            </span>
            {zusatzZeigen && a.zusatz && <span className="vp-antw-zusatz">{a.zusatz}</span>}
            {a.ziel && <Icon name="map-pin" size={14} className="vp-antw-ort" aria-hidden="true" />}
          </button>
        </li>
      ))}
    </ul>
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
