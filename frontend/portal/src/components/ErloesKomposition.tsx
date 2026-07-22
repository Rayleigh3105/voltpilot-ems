import { Icon } from '../../designsystem/components/core/Icon';
import type { EarningsRange, EarningsSite } from '../api';
import {
  erloesKomposition,
  type ErloesKompositionView,
  type PeriodTotal,
  type StreamRow,
} from '../erloesKomposition';
import type { MoneyStream } from '../surface';
import './ErloesKomposition.css';

/**
 * Der Cockpit-Block **Erlös-Komposition** (M4, #532): Geld als Stapel von
 * Strömen, einer je aktivem Modus — die Ströme RE-PLATZIEREN vorhandene
 * Earnings-Zahlen, es wird nichts neu gerechnet (report §1.4).
 *
 * Jede Zeile trägt ihr **eigenes Perioden-Etikett**, die Summen stehen **je
 * Periode** und ein Hinweis sagt es laut, sobald mehrere Perioden im Stapel
 * stehen — vermiedene Leistungskosten sind ein Abrechnungsperioden-Stand,
 * EV/Handel sind Zeitraum-Werte. Eine Zeile ohne Zurechnung (Automationen)
 * zeigt ehrlich „—".
 *
 * Der Drill-in führt in die **Erlös**-Historie — bewusst getrennt von der
 * Telemetrie-Historie, die zu `base(entities)` gehört (feedback.md).
 *
 * Alle Ableitung liegt im reinen, unit-getesteten `erloesKomposition.ts`;
 * diese Komponente rendert nur. Sie ist bewusst **eigenständig** — die
 * Platzierung im Cockpit macht M3 (#531).
 */
export function ErloesKomposition({
  streams,
  money,
  range,
  at,
  now,
  onOpenErloesHistorie,
}: {
  /** `moneyStreams(activeModes(site))` aus dem M0-Read-Model. */
  streams: MoneyStream[];
  money: EarningsSite | null;
  range: EarningsRange;
  at?: Date;
  now?: Date;
  /** Öffnet die Erlös-Historie; fehlt sie, entfällt der Drill-in. */
  onOpenErloesHistorie?: () => void;
}) {
  const view = erloesKomposition({ streams, money, range, at, now });
  if (view.isEmpty) return null;
  return <ErloesKompositionView view={view} onOpenErloesHistorie={onOpenErloesHistorie} />;
}

/** Render-only: nimmt die fertige Ableitung entgegen (Tests/Storys/M3). */
export function ErloesKompositionView({
  view,
  onOpenErloesHistorie,
}: {
  view: ErloesKompositionView;
  onOpenErloesHistorie?: () => void;
}) {
  if (view.isEmpty) return null;
  return (
    <section className="vp-streams-block" aria-label="Erlös-Komposition">
      <header className="vp-streams-head">
        <h3 className="vp-streams-title">{view.title}</h3>
        <span className="vp-streams-from">Erlös-Komposition</span>
        {view.drillIn && onOpenErloesHistorie && (
          <button
            type="button"
            className="vp-streams-drill"
            onClick={onOpenErloesHistorie}
            title={view.drillIn.hint}
          >
            {view.drillIn.label}
            <Icon name="chevron-right" size={14} />
          </button>
        )}
      </header>

      <ul className="vp-streams">
        {view.rows.map((r) => (
          <Row key={r.id} row={r} />
        ))}
      </ul>

      <ul className="vp-streams-totals">
        {view.totals.map((t) => (
          <Total key={t.period} total={t} />
        ))}
      </ul>

      {view.periodNote && <p className="vp-streams-periodnote">{view.periodNote}</p>}
      {view.footnote && <p className="vp-streams-note">{view.footnote}</p>}
      {view.drillIn && <p className="vp-streams-note">{view.drillIn.hint}</p>}
    </section>
  );
}

function Row({ row }: { row: StreamRow }) {
  return (
    // Der Zustands-Modifier trägt bewusst das `-s-`-Infix: `vp-stream-value`
    // wäre namensgleich mit der KIND-Klasse `.vp-stream-value` (der rechten
    // Wertspalte) - die Zeile hätte deren `margin-left:auto` + Spalten-Flex
    // geerbt und wäre zu einem rechtsbündigen Stapel ohne Balken kollabiert.
    <li className={`vp-stream vp-stream-s-${row.state}`}>
      <span className="vp-stream-dot" style={{ background: row.hue }} aria-hidden="true" />
      <span className="vp-stream-label">{row.label}</span>
      <span className="vp-stream-value">
        {row.valueText}
        {/* Perioden-Etikett JE ZEILE - die tragende Ehrlichkeitsregel. */}
        <small className="vp-stream-period">{row.periodLabel}</small>
      </span>
      <span className="vp-stream-bar">
        <i style={{ width: `${Math.round(row.barFraction * 100)}%`, background: row.hue }} />
      </span>
      {row.note && <span className="vp-stream-note">{row.note}</span>}
    </li>
  );
}

function Total({ total }: { total: PeriodTotal }) {
  return (
    <li className="vp-stream vp-stream-total">
      <span className="vp-stream-label">{total.label}</span>
      <span className="vp-stream-value">{total.valueText}</span>
    </li>
  );
}
