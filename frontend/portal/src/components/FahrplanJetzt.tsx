/**
 * Render-only: die KOMPAKTE Jetzt-Karte, der TAGES-ZEITSTRAHL und der FILM DES
 * TAGES der Fahrplan-Seite (Konzept `vp-fahrplan-kunde-konzept` §6, Entscheide
 * D1/D2/D3; UX-Runde r7).
 *
 * Keins der Bauteile rechnet — die Ableitung liegt rein in `src/fahrplanJetzt.ts`,
 * `src/fahrplanStrahl.ts` bzw. `src/fahrplanFilm.ts`; hier steht nur die Fläche.
 * Die Phasenfarbe kommt aus dem geteilten `roleColor`/`roleMark` (dieselbe
 * Farbsprache wie Diagramm und Erklär-Panel), das Ehrlichkeits-Abzeichen aus dem
 * geteilten `ProvBadge` der Historie — es gibt für beides genau EINE Quelle im
 * Portal.
 */

import { useState } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { chartTheme } from '../chartTheme';
import { filmPastNote, type FilmRow, type FilmView } from '../fahrplanFilm';
import { strahlView } from '../fahrplanStrahl';
import type { JetztHeldView } from '../fahrplanJetzt';
import { ProvBadge } from './HistorieWelt';
import { roleColor, roleMark } from './FahrplanWhy';
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
 * Der TAGES-ZEITSTRAHL (r7, Captain: „den Fahrplan in einer besseren Art
 * darstellen"): ein waagerechtes Band über der Tagesachse. Jede Phase ist ein
 * farbiges Segment, dessen Breite ihrer Dauer entspricht; die laufende trägt den
 * Jetzt-Marker, die vergangenen sind gedämpft. Ein Tipp auf ein Segment öffnet
 * das BESTEHENDE Erklär-Panel — es gibt genau EINEN Panel-Ort, unter dem Band.
 *
 * K10 (Farbe nie allein): breite Segmente tragen ihr WORT inline, schmale ihr
 * Wort im `title`/Accessible-Name, und die Legende unter dem Band nennt jede
 * vorkommende Phase mit Wort UND Farbe.
 *
 * Die volle Phasenliste bleibt als Aufklapper darunter (`TagesFilm`) — nichts
 * geht verloren. Fehlt das Band (keine Phase), führt die Liste direkt.
 */
export function TagesStrahl({
  view,
  now,
  selected,
  onSelect,
  panel,
}: {
  view: FilmView;
  now: Date;
  /** Der ausgewählte Phasen-Index; null = keiner. */
  selected: number | null;
  onSelect: (phaseIndex: number) => void;
  /** Das Erklär-Panel der ausgewählten Phase (wird EINMAL unter dem Band gerendert). */
  panel?: React.ReactNode;
}) {
  const [listOpen, setListOpen] = useState(false);
  const t = chartTheme();
  const strahl = strahlView(view, now);

  // Ohne Band gibt es nichts zu zeichnen — dann führt die Vollliste direkt (die
  // Ansicht ist dann zeichengleich zum früheren Film).
  if (!strahl) {
    return <TagesFilm view={view} selected={selected} onSelect={onSelect} panel={panel} />;
  }

  return (
    <div className="vp-strahl">
      <div className="vp-strahl-band" role="group" aria-label="Tagesverlauf des Fahrplans">
        {strahl.segments.map((seg) => (
          <button
            key={seg.phaseIndex}
            type="button"
            className={
              `vp-strahl-seg${seg.now ? ' is-now' : ''}${seg.done ? ' is-done' : ''}` +
              `${selected === seg.phaseIndex ? ' is-sel' : ''}`
            }
            style={{
              left: `${seg.leftPct}%`,
              width: `${seg.widthPct}%`,
              background: roleColor(seg.role, t),
            }}
            aria-pressed={selected === seg.phaseIndex}
            title={`${seg.label} · ${seg.time}`}
            onClick={() => onSelect(seg.phaseIndex)}
          >
            {seg.big && (
              <span className="vp-strahl-seg-lbl">
                <span className="w">{seg.label}</span>
                {seg.eur && <b>{seg.eur}</b>}
              </span>
            )}
          </button>
        ))}
        {strahl.nowPct != null && (
          <span className="vp-strahl-now" style={{ left: `${strahl.nowPct}%` }} aria-hidden="true">
            <i />
          </span>
        )}
      </div>

      {strahl.ticks.length > 0 && (
        <div className="vp-strahl-axis" aria-hidden="true">
          {strahl.ticks.map((tk) => (
            <span key={tk.atPct} className="vp-strahl-tick" style={{ left: `${tk.atPct}%` }}>
              {tk.label}
            </span>
          ))}
        </div>
      )}

      {/* K10: die Legende nennt jede vorkommende Phase mit Wort UND Farbe. */}
      <ul className="vp-strahl-legende">
        {strahl.legende.map((l) => {
          const mark = roleMark(l.role, t);
          return (
            <li key={l.role}>
              <span
                className="vp-strahl-swatch"
                style={mark.form === 'filled'
                  ? { background: mark.color }
                  : { boxShadow: `inset 0 0 0 2px ${mark.color}` }}
                aria-hidden="true"
              />
              {l.label}
            </li>
          );
        })}
      </ul>

      {/* Das Erklär-Panel der angetippten Phase — EIN Ort unter dem Band. */}
      {selected != null && panel}

      {/* Die volle Phasenliste bleibt als Aufklapper erhalten (nichts geht
          verloren). Sie bekommt KEIN Inline-Panel — das steht schon über ihr. */}
      <button
        type="button"
        className={`vp-strahl-more${listOpen ? ' is-open' : ''}`}
        aria-expanded={listOpen}
        onClick={() => setListOpen((o) => !o)}
      >
        <Icon name="chevron-down" size={16} />
        Alle Phasen
      </button>
      {listOpen && <TagesFilm view={view} selected={selected} onSelect={onSelect} />}
    </div>
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
