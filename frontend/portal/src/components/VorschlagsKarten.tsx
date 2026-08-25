/**
 * Die **VORSCHLÄGE** am Kopf der Regel-Kapsel (Steuerung Stufe 6, Konzept
 * `vp-steuerung-konzept-b3` §3.3; Leitprinzip Regel 1 „Vorschlag vor Regel").
 *
 * Sie ist eine reine RENDER-Fläche: welche Karten es gibt, wie sie heissen und
 * womit sie begründet sind, entscheidet ausschliesslich `src/vorschlaege.ts`
 * (pure + unit-getestet + vom Warum-Wächter geprüft). Hier steht kein einziger
 * abgeleiteter Satz.
 *
 * ⚠ **Drei Handlungen, und jede sagt vorher, was sie tut.** „Übernehmen"
 * öffnet den BESTEHENDEN Regel-Baukasten vorbefüllt — es entsteht dabei keine
 * Regel, die der Kunde nicht gesehen hat; „Später" und „Ablehnen" tragen ihre
 * Frist im Titel, damit niemand rät, wie lange etwas verschwindet.
 */
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import {
  ABLEHNEN,
  ABLEHNEN_HINWEIS,
  SPAETER,
  SPAETER_HINWEIS,
  UEBERNEHMEN,
  WAS_BRINGT,
  WAS_BRINGT_HINWEIS,
  WAS_BRINGT_NICHT,
  vorschlagKopf,
  type Vorschlag,
} from '../vorschlaege';
import { VORSCHAU_LAEUFT, vorschauSatz } from '../vorschau';
import type { VorschauStand } from './useVorschau';

export function VorschlagsKarten({
  vorschlaege,
  busy = false,
  onUebernehmen,
  onStumm,
  onVorschau,
  vorschauFuer = null,
  vorschau,
}: {
  vorschlaege: Vorschlag[];
  busy?: boolean;
  /** Öffnet den Baukasten VORBEFÜLLT — nie eine fertige Regel. */
  onUebernehmen: (v: Vorschlag) => void;
  /** „Später" (1 Tag) / „Ablehnen" (7 Tage) — die Frist rechnet der Server. */
  onStumm: (v: Vorschlag, state: 'spaeter' | 'abgelehnt') => void;
  /**
   * Stufe 7: der Kunde FRAGT nach der Wirkung EINES Vorschlags. Absent = die
   * Karten sehen zeichengleich aus wie in Stufe 6.
   */
  onVorschau?: (v: Vorschlag) => void;
  /** Für welchen Vorschlag gerade gefragt wurde (Schlüssel). */
  vorschauFuer?: string | null;
  vorschau?: VorschauStand;
}) {
  if (vorschlaege.length === 0) return null;
  return (
    <div className="vp-vorschlaege" aria-label="Vorschläge von VoltPilot">
      <p className="vp-vorschlaege-kopf">
        <Icon name="sun" size={14} />
        <span>{vorschlagKopf(vorschlaege.length)}</span>
      </p>
      <ul className="vp-vorschlagliste">
        {vorschlaege.map((v) => (
          <li key={v.key} className="vp-vorschlag">
            <p className="vp-vorschlag-titel">{v.titel}</p>
            <p className="vp-vorschlag-grund">{v.begruendung}</p>
            {/* Die WIRKUNG dieses Vorschlags — gefragt, nie gedrängt (jede
                Antwort ist ein echter Solver-Lauf). Der Satz kommt aus der
                reinen Ableitung; hier wird nichts formuliert. */}
            {vorschauFuer === v.key && (
              <p className="vp-vorschlag-vorschau">
                {vorschau?.laeuft
                  ? VORSCHAU_LAEUFT
                  : vorschauSatz(vorschau?.ergebnis ?? null)}
              </p>
            )}
            <div className="vp-vorschlag-aktionen">
              <Button size="sm" disabled={busy} onClick={() => onUebernehmen(v)}>
                {UEBERNEHMEN}
              </Button>
              {onVorschau && vorschauFuer !== v.key && (
                <Button
                  size="sm"
                  variant="outline"
                  // Ein Knopf, der strukturell nichts liefern kann, wird nicht
                  // angeboten — dort steht der Grund im Titel.
                  disabled={busy || v.knoepfe == null}
                  title={v.knoepfe == null ? WAS_BRINGT_NICHT : WAS_BRINGT_HINWEIS}
                  onClick={() => onVorschau(v)}
                >
                  {WAS_BRINGT}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                title={SPAETER_HINWEIS}
                onClick={() => onStumm(v, 'spaeter')}
              >
                {SPAETER}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                title={ABLEHNEN_HINWEIS}
                onClick={() => onStumm(v, 'abgelehnt')}
              >
                {ABLEHNEN}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
