import { Icon } from '../../designsystem/components/core/Icon';
import { BOARD_HINT } from '../livePuls';
import type { LivePulsRow, TodayLine } from '../livePuls';
import { NO_DATA } from '../nodata';

import './LivePuls.css';

/**
 * Das Komponenten-Board (vp-cockpit-unten-ux-n3 PR 2 — EINE Zeilen-Grammatik):
 * je Komponente eine Kachel-Zeile
 *
 *   [Gesundheitspunkt] [Icon] Name (+ Bestands-Notiz)
 *                             JETZT-Wert + Richtungswort (+ Detail/SoC-Mini)
 *   | heute: Energie | ›
 *
 * Die ganze Zeile ist EIN Absprung in den Verlauf, mit einem IMMER sichtbaren
 * Chevron (das alte Hover-only-„Verlauf"-Label existierte auf Touch nicht).
 * Sparklines sind ersatzlos entfallen (D4/K3); der Trend wohnt in der
 * Verlauf-Ebene der Karte. Ab 900 px stehen die Kacheln 2-spaltig — die
 * gestreckte Telefon-Liste mit totem Mittelraum (K6) ist damit weg.
 *
 * Thin + render-only — jede Ableitung ist die pure `livePuls.ts` (+
 * `liveDetail.withDayTotals` für die Heute-Spalte); hier wird nur gezeichnet.
 */

const HEALTH: Record<string, { cls: string; title: string }> = {
  ok: { cls: 'vp-health-ok', title: 'Liefert Daten' },
  stale: { cls: 'vp-health-warn', title: 'Meldet gerade keine Daten' },
  never: { cls: 'vp-health-off', title: 'Noch keine Daten' },
  // H2: nichts gemeldet ist NICHT „liefert Daten" - grau, mit ehrlichem Titel.
  unknown: { cls: 'vp-health-off', title: 'Noch keine Rückmeldung' },
};

/** Eine Zeile der Heute-Spalte: das WORT trägt die Richtung (aria/title). */
function Today({ line }: { line: TodayLine }) {
  const label = line.word ? `${line.word} ${line.text}` : line.text;
  return (
    <span className="vp-puls-today-line" aria-label={label} title={line.word ?? undefined}>
      {line.arrow && (
        <Icon name={line.arrow === 'up' ? 'arrow-up' : 'arrow-down'} size={12} />
      )}
      {line.text}
    </span>
  );
}

function Row({
  row,
  onOpen,
}: {
  row: LivePulsRow;
  onOpen: (t: { entityId: string; channel: string }) => void;
}) {
  const dot = HEALTH[row.health] ?? HEALTH.unknown;
  return (
    <button
      type="button"
      className={`vp-puls-row${row.stateTone === 'muted' ? ' muted' : ''}`}
      disabled={row.target == null}
      onClick={() => row.target && onOpen(row.target)}
      title={row.fullTitle ?? row.title}
    >
      <span className={`vp-health-dot ${dot.cls}`} title={dot.title} aria-hidden="true" />
      <span className="vp-puls-ico">
        <Icon name={row.icon} size={16} />
      </span>
      <span className="vp-puls-body">
        <span className="vp-puls-name">
          {row.title}
          {row.titleNote && <span className="vp-puls-note">{row.titleNote}</span>}
        </span>
        <span className="vp-puls-now">
          <b className="vp-puls-val">{row.value}</b>
          {row.socPct != null && (
            <span className="vp-puls-socmini" aria-hidden="true">
              <i style={{ width: `${row.socPct}%` }} />
            </span>
          )}
          <span className="vp-puls-state">
            {row.arrow && (
              <Icon name={row.arrow === 'up' ? 'arrow-up' : 'arrow-down'} size={13} />
            )}
            {row.stateLabel}
            {row.subLine && <span className="vp-puls-sub"> · {row.subLine}</span>}
          </span>
        </span>
      </span>
      <span className="vp-puls-today">
        <span className="vp-puls-today-cap" aria-hidden="true">
          heute
        </span>
        {row.today == null || row.today.length === 0 ? (
          <span className="vp-puls-today-line vp-puls-today-none">{NO_DATA}</span>
        ) : (
          row.today.map((l, i) => <Today key={i} line={l} />)
        )}
      </span>
      <span className="vp-puls-go" aria-hidden="true">
        <Icon name="chevron-right" size={16} />
      </span>
    </button>
  );
}

export function LivePuls({
  rows,
  onOpenVerlauf,
}: {
  rows: LivePulsRow[];
  onOpenVerlauf: (target: { entityId: string; channel: string }) => void;
}) {
  return (
    <div className="vp-puls" aria-label="Komponenten im Detail">
      <div className="vp-puls-head">
        <h3>Komponenten</h3>
        <span className="vp-puls-hint">{BOARD_HINT}</span>
      </div>
      <div className="vp-puls-rows">
        {rows.map((row) => (
          <Row key={row.key} row={row} onOpen={onOpenVerlauf} />
        ))}
      </div>
    </div>
  );
}
