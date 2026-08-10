/**
 * Render-only: der JETZT-Held und der FILM DES TAGES der Fahrplan-Seite
 * (Konzept `vp-fahrplan-kunde-konzept` §6.1/§6.2, Entscheide D1/D2/D3).
 *
 * Beide Bauteile rechnen NICHTS — die ganze Ableitung liegt rein in
 * `src/fahrplanJetzt.ts` bzw. `src/fahrplanFilm.ts`; hier steht nur die
 * Fläche. Die Phasenfarbe kommt aus dem geteilten `roleColor` (dieselbe
 * Farbsprache wie Diagramm und Erklär-Panel), das Ehrlichkeits-Abzeichen aus
 * dem geteilten `ProvBadge` der Historie — es gibt für beides genau EINE
 * Quelle im Portal.
 */

import { useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import { filmPastNote, type FilmRow, type FilmView } from '../fahrplanFilm';
import type { JetztHeldView } from '../fahrplanJetzt';
import { ProvBadge } from './HistorieWelt';
import { roleColor } from './FahrplanWhy';
import './Fahrplan.css';

/**
 * Block 1 — der Held: Zustandszeile (F5), die EINE Aussage mit der Zahl der
 * Ausführung, die Nachführungs-Zeile (nie als Fehler), der Warum-Satz (F2)
 * und die Messwert-Chips, die alles begründen.
 */
export function JetztHeld({ view }: { view: JetztHeldView }) {
  return (
    <Card padding="lg" radius="lg" className="vp-jetzt">
      <div className="vp-jetzt-kick">
        <span className="vp-card-label">Jetzt</span>
        <ProvBadge art={view.badgeArt} />
        {view.badgeNote && <span className="vp-jetzt-ago">{view.badgeNote}</span>}
      </div>

      <p className={`vp-jetzt-status is-${view.tone}`}>
        <i aria-hidden="true" />
        {view.status}
      </p>

      {/* Am Telefon eine Spalte (Leitbild 375 px), ab 1024 px links die
          Aussage, rechts Warum + Messwerte - dieselbe Ordnung, mehr Luft. */}
      <div className="vp-jetzt-body">
        <div className="vp-jetzt-main">
          <p className="vp-jetzt-lead">{view.lead}</p>

          <p className="vp-jetzt-value">
            {view.value ? (
              <>
                <b>{view.value}</b>
                {view.valueNote && <span>{view.valueNote}</span>}
              </>
            ) : (
              <>
                {/* „—" statt einer erfundenen Zahl - und immer MIT Grund. */}
                <b className="vp-jetzt-dash">—</b>
                {view.valueMissing && <span>{view.valueMissing}</span>}
              </>
            )}
          </p>

          {view.adjust && <p className="vp-jetzt-adjust">{view.adjust}</p>}

          {/* Flussabgleich (bernstein, kein Gerätefehler): der Sollwert ist
              register-bestätigt, aber die Physik fließt nicht - er ersetzt die
              Bestätigungszeile. */}
          {view.flowConflict && (
            <p className="vp-jetzt-conflict">
              <Icon name="alert-triangle" size={14} />
              {view.flowConflict}
            </p>
          )}

          {/* Bernstein, nicht rot: die Anlage setzt die geplante Abregelung
              (noch) nicht um bzw. die Messung widerspricht ihr - das ist kein
              Gerätefehler, darf aber nicht unter einer Plan-Aussage
              verschwinden. */}
          {view.conflict && (
            <p className="vp-jetzt-conflict">
              <Icon name="alert-triangle" size={14} />
              {view.conflict}
            </p>
          )}

          {/* Die belegte Abregelung ist eine gute Nachricht und steht deshalb
              nie im Warn-Slot darüber (PR 3, Stufe 3). */}
          {view.curtailment && (
            <p className="vp-jetzt-confirm">
              <Icon name="check" size={14} />
              {view.curtailment}
            </p>
          )}

          {view.confirm && (
            <p className="vp-jetzt-confirm">
              <Icon name="check" size={14} />
              {view.confirm}
            </p>
          )}
        </div>

        <div className="vp-jetzt-side">
          {view.why && (
            <p className="vp-jetzt-why">
              <span className="k">Warum?</span> {view.why}
            </p>
          )}

          {view.next && <p className="vp-jetzt-next">{view.next}</p>}

          {view.chips.length > 0 && (
            <div className="vp-jetzt-chips">
              {view.chips.map((c) => (
                <span key={c.label} className="vp-jetzt-chip">
                  {c.label} <b>{c.value}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * Block 2 — der Film: die Phasen als erzählte Liste mit Jetzt-Anker. Jede
 * Zeile trägt ihr WORT (Identität hängt nie an der Farbe allein), ein Tipp
 * klappt das bestehende Erklär-Panel DIREKT AN DER ZEILE aus (am Telefon
 * rendert dasselbe Panel als Bottom-Sheet).
 *
 * Mit dem Tages-Splice führt der Film den GANZEN Tag: die schon gelaufenen
 * Phasen stehen abgehakt und ruhig oben, mit dem Satz, der sie als PLAN
 * ausweist (`filmPastNote`) — Farbsprache und Pflicht-Markierungen gelten dort
 * genauso wie im Rest des Tages, nur gedämpft.
 */
export function TagesFilm({
  view,
  selected,
  onSelect,
  panel,
}: {
  view: FilmView;
  /** Der ausgewählte Phasen-Index; null = keiner. */
  selected: number | null;
  onSelect: (phaseIndex: number) => void;
  /** Das Erklär-Panel der ausgewählten Phase (wird an ihrer Zeile gerendert). */
  panel?: React.ReactNode;
}) {
  const [tomorrowOpen, setTomorrowOpen] = useState(false);
  const t = chartTheme();
  const pastNote = filmPastNote(view);

  const zeile = (row: FilmRow) => (
    <li key={row.phaseIndex} className={`vp-film-li${row.now ? ' is-now' : ''}${row.done ? ' is-done' : ''}`}>
      <button
        type="button"
        className="vp-film-row"
        aria-pressed={selected === row.phaseIndex}
        onClick={() => onSelect(row.phaseIndex)}
      >
        <span className="vp-film-dot" style={{ background: roleColor(row.role, t) }} aria-hidden="true" />
        <span className="vp-film-body">
          <span className="vp-film-was">
            {row.now && <span className="vp-film-now">Jetzt</span>}
            {row.done && (
              <span className="vp-film-done" aria-label="abgeschlossen">
                <Icon name="check" size={12} />
              </span>
            )}
            {row.label}
          </span>
          <span className="vp-film-meta">
            {row.time}
            {row.sub && <> · {row.sub}</>}
          </span>
          {/* Duty-Vorschau (PR 4): der Watt-Wert dieser Phase ist eine
              Vorhersage - das steht hier, bevor die Phase läuft. */}
          {row.duty && (
            <span className="vp-film-duty" title={row.duty.hint}>
              <Icon name="activity" size={12} />
              {row.duty.text}
            </span>
          )}
        </span>
        {row.eur && (
          <span className={`vp-film-eur${row.einkauf ? ' buy' : ''}`}>
            {row.eur}
            {row.einkauf && <i>Einkauf</i>}
          </span>
        )}
      </button>
      {selected === row.phaseIndex && panel}
    </li>
  );

  return (
    <div className="vp-film">
      {view.past.length > 0 && (
        <>
          {/* Abgehakt heißt GEPLANT, nicht gelaufen - das steht bei den Zeilen,
              nicht in einer Fußnote weit darunter. */}
          {pastNote && <p className="vp-film-pastnote">{pastNote}</p>}
          <ol className="vp-film-list">{view.past.map(zeile)}</ol>
        </>
      )}
      {view.today.length > 0 ? (
        <ol className="vp-film-list">{view.today.map(zeile)}</ol>
      ) : (
        <p className="vp-note vp-film-empty">{view.empty}</p>
      )}

      {view.tomorrowSummary && (
        <>
          <button
            type="button"
            className={`vp-film-more${tomorrowOpen ? ' is-open' : ''}`}
            aria-expanded={tomorrowOpen}
            onClick={() => setTomorrowOpen((o) => !o)}
          >
            <Icon name="chevron-down" size={16} />
            {view.tomorrowSummary}
          </button>
          {tomorrowOpen && <ol className="vp-film-list">{view.tomorrow.map(zeile)}</ol>}
        </>
      )}
    </div>
  );
}
