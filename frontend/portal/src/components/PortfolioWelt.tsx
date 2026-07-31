/**
 * Das gemeinsame SKELETT der zwei PORTFOLIO-Welten (PR G, Konzept
 * `data/vp-historie-konzept-t4` §4.3): Welt-Kopf → Zeit-Leiste → Summenkarte →
 * Anlagen-Tabelle → Fußkarte. Reine Render-Bausteine; jede Ableitung/Copy lebt
 * im reinen `portfolioHistorie.ts` (das `HistorieWelt.tsx`-Muster).
 *
 * **Warum die Zeit-Leiste hier eine EIGENE ist und nicht die der Anlagen-Welt:**
 * deren dritte Zeile ist die Datenlage EINER Anlage (`HistoryCoverage` ist
 * anlagenscharf) — auf der Portfolio-Ebene gäbe es N davon, und eine davon zu
 * zeigen wäre eine Behauptung über die anderen. Die Portfolio-Leiste sagt
 * stattdessen ihre eigene Wahrheit („3 von 4 Anlagen mit Daten"). Alles
 * Übrige ist geteilt: die reinen Sprung-Helfer aus `historieZeit.ts`, der
 * `MonthStrip` der Geld-Ansicht und die CSS-Klassen der Anlagen-Welt
 * (`Historie.css`) — die Leiste sieht deshalb überall gleich aus.
 */
import type { ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import type { HistoryRange } from '../api';
import { PROVENIENZ } from '../historieWelten';
import {
  ankerAusWert,
  sprungFeld,
  sprungGrenzen,
  sprungJahre,
  sprungLabel,
  sprungWert,
  streifenAnker,
  streifenSlots,
  zeigtStreifen,
} from '../historieZeit';
import { periodLabel, shiftAnchor } from '../periodNav';
import type { PortfolioAbdeckung, PortfolioWelt } from '../portfolioHistorie';
import { portfolioRanges } from '../portfolioHistorie';
import { MonthStrip } from './MoneyView';
import { ProvBadge } from './HistorieWelt';

import './Historie.css';
import './PortfolioWelt.css';

/** Eine Karte des Welt-Wechslers auf Portfolio-Ebene. */
export interface PortfolioSwitchCard {
  welt: PortfolioWelt;
  active: boolean;
}

/**
 * Welt-Kopf: Icon · Titel · Ehrlichkeits-Abzeichen · Einleitungssatz, darunter
 * das Kartenpaar für den Ein-Klick-Wechsel. Genau wie auf der Anlage — nur
 * nennt die Unterzeile die Ebene („4 Anlagen · Juli 2026"), damit nie unklar
 * ist, worüber die Zahlen sprechen.
 */
export function PortfolioWeltKopf({
  welt,
  cards,
  kontext,
  hrefFor,
  onOpen,
}: {
  welt: PortfolioWelt;
  cards: PortfolioSwitchCard[];
  /** „4 Anlagen · Juli 2026" — die Ebene und der Zeitraum in einem Satz. */
  kontext: string;
  hrefFor: (card: PortfolioSwitchCard) => string;
  onOpen: (card: PortfolioSwitchCard) => void;
}) {
  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-welt-kopf vp-welt-${welt.id}`}
      style={{ padding: 'var(--vp-welt-pad)' }}
    >
      <div className="vp-welt-head">
        <IconTile category="dynamic" size={44} style={{ background: 'var(--vp-welt-grad)' }}>
          <Icon name={welt.icon} size={22} />
        </IconTile>
        <div className="vp-welt-titles">
          <h1>
            {welt.label}
            <span className="vp-pf-ebene">Portfolio</span>
            <ProvBadge art={welt.badge} />
          </h1>
          <p>
            {welt.lead} <span className="vp-pf-kontext">{kontext}</span>
          </p>
        </div>
      </div>
      {cards.length > 1 && (
        <div className="vp-welt-switch" role="group" aria-label="Ansicht wechseln">
          {cards.map((card) => (
            <a
              key={card.welt.id}
              className={`vp-wsw vp-welt-${card.welt.id}${card.active ? ' on' : ''}`}
              href={hrefFor(card)}
              aria-current={card.active ? 'page' : undefined}
              onClick={(e) => {
                // Modifier-Klicks (neuer Tab) dem Browser überlassen.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpen(card);
              }}
            >
              <span className="vp-wsw-ico" aria-hidden="true">
                <Icon name={card.welt.icon} size={17} />
              </span>
              <span className="vp-wsw-text">
                <span className="vp-wsw-label">{card.welt.label}</span>
                <span className="vp-wsw-sub">{card.welt.switchLead}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Das native Sprungfeld je Zeitraum (F2) — der Browser bringt den Kalender mit. */
function Sprungfeld({
  range,
  anchor,
  now,
  onAnchor,
}: {
  range: HistoryRange;
  anchor: Date;
  now: Date;
  onAnchor: (d: Date) => void;
}) {
  const feld = sprungFeld(range);
  const label = sprungLabel(range);
  const wert = sprungWert(anchor, range);

  if (feld === 'year') {
    return (
      <label className="vp-zl-jump">
        <span className="vp-visually-hidden">{label}</span>
        <Icon name="calendar" size={16} aria-hidden="true" />
        <select
          aria-label={label}
          title={label}
          value={wert}
          onChange={(e) => {
            const d = ankerAusWert(e.target.value, range);
            if (d) onAnchor(d);
          }}
        >
          {sprungJahre(anchor, now).map((j) => (
            <option key={j} value={String(j)}>
              {j}
            </option>
          ))}
        </select>
      </label>
    );
  }

  // Ohne anlagenscharfe Abdeckung wird nur die ZUKUNFT begrenzt - ein
  // geratenes Startdatum über eine ganze Flotte wäre eine Behauptung.
  const grenzen = sprungGrenzen(range, now, null);
  return (
    <label className="vp-zl-jump">
      <span className="vp-visually-hidden">{label}</span>
      <Icon name="calendar" size={16} aria-hidden="true" />
      <input
        type={feld}
        aria-label={label}
        title={label}
        value={wert}
        min={grenzen.min}
        max={grenzen.max}
        onChange={(e) => {
          const d = ankerAusWert(e.target.value, range);
          if (d) onAnchor(d);
        }}
      />
    </label>
  );
}

/**
 * Die klebende Zeit-Leiste der Portfolio-Ebene: [Zeiträume] ‹ Anker › Heute 📅,
 * darunter der Monatsstreifen (Tag/Monat). Die angebotenen Zeiträume kommen aus
 * der WELT (`portfolioRanges`) — die Erlöse-Welt bietet keine Woche an, weil
 * ihr Endpunkt keine kennt.
 */
export function PortfolioZeitLeiste({
  welt,
  range,
  anchor,
  onRange,
  onAnchor,
  now = new Date(),
}: {
  welt: PortfolioWelt;
  range: HistoryRange;
  anchor: Date;
  onRange: (r: HistoryRange) => void;
  onAnchor: (d: Date) => void;
  now?: Date;
}) {
  const nextDisabled = shiftAnchor(anchor, range, 1) > now;
  const streifen = zeigtStreifen(range);
  return (
    <div className="vp-zeitleiste">
      <div className="vp-zl-row">
        <div className="vp-seg" role="tablist" aria-label="Zeitraum">
          {portfolioRanges(welt.id).map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              className={range === r.id ? 'active' : ''}
              onClick={() => onRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="vp-period-nav">
          <button
            type="button"
            className="step"
            aria-label="Vorheriger Zeitraum"
            onClick={() => onAnchor(shiftAnchor(anchor, range, -1))}
          >
            <Icon name="chevron-left" size={18} />
          </button>
          <span className="label">{periodLabel(anchor, range)}</span>
          <button
            type="button"
            className="step"
            aria-label="Nächster Zeitraum"
            disabled={nextDisabled}
            onClick={() => onAnchor(shiftAnchor(anchor, range, 1))}
          >
            <Icon name="chevron-right" size={18} />
          </button>
          <button type="button" className="step" onClick={() => onAnchor(new Date())}>
            Heute
          </button>
          <Sprungfeld range={range} anchor={anchor} now={now} onAnchor={onAnchor} />
        </div>
      </div>
      {streifen && (
        <MonthStrip
          slots={streifenSlots(now)}
          selectedMonth={`${sprungWert(anchor, 'month')}-01`}
          showValues={false}
          ariaLabel="Monat anspringen"
          onSelect={(monthIso) => {
            const d = streifenAnker(monthIso, range, now);
            if (d) onAnchor(d);
          }}
        />
      )}
    </div>
  );
}

/**
 * Der Abdeckungs-Satz an der Summe — er rendert NUR, wenn nicht alle Anlagen
 * Daten tragen. Das ist die Portfolio-Antwort auf „woraus besteht diese Zahl
 * eigentlich?".
 */
export function AbdeckungsSatz({ abdeckung }: { abdeckung: PortfolioAbdeckung }) {
  if (!abdeckung.satz) return null;
  return (
    <p className="vp-pf-abdeckung">
      <Icon name="info" size={14} aria-hidden="true" />
      {abdeckung.satz}
    </p>
  );
}

/**
 * Ein abhängigkeitsfreier Mini-Trend (SVG-Polyline) — dieselbe Idee wie die
 * Spark-Balken der Flotten-Übersicht, nur als Linie und ohne Achse: er zeigt
 * die FORM des Zeitraums, nie einen ablesbaren Wert.
 *
 * Fehlende Werte sind LÜCKEN, keine Nullen: die Linie wird an ihnen
 * unterbrochen. Unter zwei Punkten wird gar nichts gezeichnet (eine Linie aus
 * einem Punkt behauptet einen Verlauf, den niemand gemessen hat).
 */
export function MiniTrend({
  werte,
  titel,
  farbe = 'var(--vp-navy, #1e3a5f)',
}: {
  werte: readonly (number | null)[];
  titel: string;
  farbe?: string;
}) {
  const punkte = werte.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (punkte.length < 2) return <span className="vp-muted">—</span>;
  const min = Math.min(...punkte, 0);
  const max = Math.max(...punkte, 0);
  const spanne = max - min || 1;
  const w = 80;
  const h = 18;
  const dx = werte.length > 1 ? w / (werte.length - 1) : w;

  // Zusammenhängende Segmente: eine Lücke beendet das laufende Segment.
  const segmente: string[] = [];
  let aktuell: string[] = [];
  werte.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      if (aktuell.length > 1) segmente.push(aktuell.join(' '));
      aktuell = [];
      return;
    }
    const x = i * dx;
    const y = h - ((v - min) / spanne) * (h - 2) - 1;
    aktuell.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (aktuell.length > 1) segmente.push(aktuell.join(' '));
  if (segmente.length === 0) return <span className="vp-muted">—</span>;

  return (
    <svg
      className="vp-pf-spark"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      role="img"
      aria-label={titel}
    >
      <title>{titel}</title>
      {segmente.map((p, i) => (
        <polyline key={i} points={p} fill="none" stroke={farbe} strokeWidth="1.6" />
      ))}
    </svg>
  );
}

/**
 * Die Anlagen-Tabelle beider Welten: `.vp-table.responsive` (der Portfolio-
 * Präzedenzfall — sie klappt unter 720 px zu Etikett/Wert-Karten), jede Zeile
 * ein Absprung in DIESELBE Welt DIESER Anlage.
 */
export function AnlagenTabelle({
  kopf,
  children,
}: {
  kopf: readonly string[];
  children: ReactNode;
}) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table className="vp-table responsive vp-pf-table">
        <thead>
          <tr>
            {kopf.map((k) => (
              <th key={k}>{k}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </Card>
  );
}

/** Die Fußkarte „Was diese Zahlen sind" — je Welt genau einmal, am Ende. */
export function PortfolioWeltFuss({ welt }: { welt: PortfolioWelt }) {
  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg" className="vp-welt-fuss">
        <b>Was diese Zahlen sind</b>
        <p>{welt.fussText}</p>
        <p className="vp-pf-fuss-badge">
          <ProvBadge art={welt.badge} /> {PROVENIENZ[welt.badge].satz}
        </p>
      </Card>
    </section>
  );
}
