import type { ReactNode } from 'react';

import { Icon } from '../../designsystem/components/core/Icon';
import { BOARD_HINT } from '../livePuls';
import type { LivePulsRow, TodayLine } from '../livePuls';
import { NO_DATA } from '../nodata';
import { MiniShareBar } from './MiniChart';

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
  fold,
}: {
  row: LivePulsRow;
  onOpen: (t: { entityId: string; channel: string }) => void;
  fold?: FoldProps;
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
            <MiniShareBar className="vp-puls-socmini" size="micro" fraction={row.socPct / 100} />
          )}
          <span className="vp-puls-state">
            {row.arrow && (
              <Icon name={row.arrow === 'up' ? 'arrow-up' : 'arrow-down'} size={13} />
            )}
            {row.stateLabel}
            {row.subLine && <span className="vp-puls-sub"> · {row.subLine}</span>}
            {/* P5d: ein BERECHNETER Ladestand gibt sich hier zu erkennen. Er
                steht NEBEN dem Zustand, nicht statt seiner - „Lädt" bleibt
                wahr, auch wenn die Zahl daneben gerechnet ist. */}
            {row.herkunft && (
              <span className="vp-puls-sub vp-puls-herkunft"> · {row.herkunft}</span>
            )}
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
      {!fold && (
        <span className="vp-puls-go" aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
      )}
    </button>
  );
}

/** Die Aufklapp-Steuerung einer Zeile (heute: die Zusammensetzung des Hauses). */
export interface FoldProps {
  open: boolean;
  onToggle: () => void;
  /** Der Name der Sache, die sich öffnet - für das `aria-label`. */
  label: string;
  /** Was hinter dem Chevron steht. */
  panel: ReactNode;
}

/**
 * Eine aufklappbare Zeile: der ZEILEN-Klick bleibt der Verlauf, das Aufklappen
 * ist ein EIGENER Knopf daneben. Zwei Ziele in EINER Schaltfläche wären die
 * Doppeldeutigkeit, die dieses Haus verbietet - und ein `<button>` im
 * `<button>` ist ohnehin kein gültiges HTML.
 */
function FoldableRow({
  row,
  onOpen,
  fold,
}: {
  row: LivePulsRow;
  onOpen: (t: { entityId: string; channel: string }) => void;
  fold: FoldProps;
}) {
  return (
    <>
      <div className="vp-puls-rowwrap">
        <Row row={row} onOpen={onOpen} fold={fold} />
        <button
          type="button"
          className={`vp-puls-fold${fold.open ? ' open' : ''}`}
          aria-expanded={fold.open}
          aria-label={fold.open ? `${fold.label} schließen` : `${fold.label} anzeigen`}
          onClick={fold.onToggle}
        >
          {/* Der Satz kennt nur `chevron-down`; die Richtung dreht die CSS -
              den ZUSTAND trägt ohnehin `aria-expanded`, nicht die Grafik. */}
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
      {fold.open && fold.panel}
    </>
  );
}

export function LivePuls({
  rows,
  onOpenVerlauf,
  fold,
}: {
  rows: LivePulsRow[];
  onOpenVerlauf: (target: { entityId: string; channel: string }) => void;
  /** Die EINE Zeile, die sich aufklappen lässt, mit ihrem Panel. */
  fold?: (FoldProps & { key: string }) | null;
}) {
  return (
    <div className="vp-puls" aria-label="Komponenten im Detail">
      <div className="vp-puls-head">
        <h3>Komponenten</h3>
        <span className="vp-puls-hint">{BOARD_HINT}</span>
      </div>
      <div className="vp-puls-rows">
        {rows.map((row) =>
          fold && fold.key === row.key ? (
            <FoldableRow key={row.key} row={row} onOpen={onOpenVerlauf} fold={fold} />
          ) : (
            <Row key={row.key} row={row} onOpen={onOpenVerlauf} />
          ),
        )}
      </div>
    </div>
  );
}
