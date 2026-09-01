/**
 * Render-only: die KOMPAKTE Jetzt-Karte und der FILM DES TAGES der Fahrplan-Seite
 * (Konzept `vp-fahrplan-kunde-konzept` §6 + UX-Runde `vp-fahrplan-ux-r7`).
 *
 * Keins der Bauteile rechnet — die Ableitung liegt rein in `src/fahrplanJetzt.ts`
 * bzw. `src/fahrplanFilm.ts`; hier steht nur die Fläche. Das Phasen-Band ist seit
 * r7 eine dritte Chart-Spur (`ScheduleChart showPhaseBand`), kein eigenes Element
 * mehr. Die Phasenfarbe kommt aus dem geteilten `roleColor` (dieselbe Farbsprache
 * wie Diagramm und Erklär-Panel), das Ehrlichkeits-Abzeichen aus dem geteilten
 * `ProvBadge` der Historie — es gibt für beides genau EINE Quelle im Portal.
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
 * Die KOMPAKTE Jetzt-Karte (r7, Captain: „zu viel Text"): eine Mini-Karte mit
 * genau drei Aussagen im Standard-Scroll — Zustand · Plan-/Ist-Wert · ggf.
 * Warnung. Der lange Warum-Satz und die Messwert-Chips wandern in den Aufklapper
 * „Warum & Messwerte", damit die Seite mit dem Diagramm führen kann.
 *
 * WARNUNGEN bleiben PROMINENT (K10, kein Informationsverlust): der Widerspruch
 * der Abregelung (`conflict`) und der bernstein Flussabgleich (`warn`) stehen
 * IMMER sichtbar, nie im Aufklapper. Die ruhigen grünen Bestätigungen und die
 * Erklärung sind die einzigen Dinge, die einklappen.
 */
export function JetztKompakt({ view }: { view: JetztHeldView }) {
  const [open, setOpen] = useState(false);

  const warnFlow = view.flowConflict && view.flowConflictSeverity === 'warn';
  const infoFlow = view.flowConflict && view.flowConflictSeverity === 'info';
  const hatDetail = Boolean(
    view.why || view.next || view.chips.length > 0 || view.confirm || view.curtailment || infoFlow,
  );

  return (
    <Card padding="md" radius="lg" className="vp-kompakt">
      <div className="vp-kompakt-head">
        <div className="vp-kompakt-kick">
          <span className="vp-card-label">Jetzt</span>
          <ProvBadge art={view.badgeArt} />
          {view.badgeNote && <span className="vp-jetzt-ago">{view.badgeNote}</span>}
        </div>

        <p className={`vp-kompakt-status is-${view.tone}`} role="status" aria-live="polite">
          <i aria-hidden="true" />
          {view.status}
        </p>

        {/* Plan-/Ist-Wert in EINER Zeile: die Aussage links, die Zahl der
            Ausführung rechts (oder „—" MIT Grund). */}
        <p className="vp-kompakt-value">
          <span className="k">{view.lead}</span>{' '}
          {view.value ? (
            <b>
              {view.value}
              {view.valueNote && <span className="vp-kompakt-note"> {view.valueNote}</span>}
            </b>
          ) : (
            <b className="vp-jetzt-dash">
              —{view.valueMissing && <span className="vp-kompakt-note"> {view.valueMissing}</span>}
            </b>
          )}
        </p>

        {/* Die Nachführungs-/Sicherungs-Zeile ist eine Aussage erster Ordnung
            über den laufenden Sollwert — sie bleibt im Standard-Scroll. */}
        {view.adjust && <p className="vp-kompakt-adjust">{view.adjust}</p>}
      </div>

      {/* Warnungen bleiben sichtbar (K10). */}
      {warnFlow && (
        <p className="vp-jetzt-conflict">
          <Icon name="alert-triangle" size={14} />
          {view.flowConflict}
        </p>
      )}
      {view.conflict && (
        <p className="vp-jetzt-conflict">
          <Icon name="alert-triangle" size={14} />
          {view.conflict}
        </p>
      )}

      {hatDetail && (
        <>
          <button
            type="button"
            className={`vp-kompakt-fold${open ? ' is-open' : ''}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="chevron-down" size={16} />
            Warum & Messwerte
          </button>
          {open && (
            <div className="vp-kompakt-detail">
              {view.why && (
                <p className="vp-jetzt-why">
                  <span className="k">Warum?</span> {view.why}
                </p>
              )}
              {view.next && <p className="vp-jetzt-next">{view.next}</p>}

              {/* Die gutartige Physik (grün) steht ruhig hier, nicht im
                  Warn-Slot oben. */}
              {infoFlow && (
                <p className="vp-jetzt-confirm">
                  <Icon name="check" size={14} />
                  {view.flowConflict}
                </p>
              )}
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
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Block 2 — der Film: die Phasen als erzählte Liste mit Jetzt-Anker. Jede
 * Zeile trägt ihr WORT (Identität hängt nie an der Farbe allein), ein Tipp
 * klappt das bestehende Erklär-Panel DIREKT AN DER ZEILE aus (am Telefon
 * rendert dasselbe Panel als Bottom-Sheet).
 *
 * Seit dem Zeitstrahl (r7) ist er der AUFKLAPPER „Alle Phasen" unter dem Band —
 * die vergangenen Phasen stehen abgehakt oben, mit dem Satz, der sie als PLAN
 * ausweist (`filmPastNote`).
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
