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
import { useState, type ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { HistoryRange } from '../api';
import { PROVENIENZ } from '../historieWelten';
import { useIsPhone } from '../useIsPhone';
import { ZeitPopover } from './HistorieWelt';
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
import { VpDatePicker } from './VpDatePicker';
import { VpPicker } from './VpPicker';

import './Historie.css';
import './PortfolioWelt.css';
import { MiniLineSpark } from './MiniChart';

/**
 * Der Welt-Kopf ist seit E3 **eine unsichtbare Überschrift und sonst nichts** —
 * der Zwilling von `WeltKopf` der Anlagen-Welt (Konzept
 * `vp-erloese-lesbar-konzept-u3` §3.5/§3.10, Befund B4; E12 macht die Erlöse-
 * Seite zum Piloten fürs ganze Portal, die Portfolio-Welt zieht deshalb mit).
 *
 * Was er war: eine Karte mit 44-px-Icon-Kachel, Titel, Abzeichen und
 * Einleitungssatz — Höhe VOR der ersten Zahl, und dahinter klebte die
 * Zeit-Leiste. Was er sagte, sagen `PortfolioTabs` darüber (die Welt) und
 * `KartenKopf` an jeder Karte (die Art der Zahlen) schon.
 *
 * **Der Kontext-Satz geht nicht verloren:** „4 Anlagen · Juli 2026" nennt die
 * EBENE, über die die Zahlen sprechen — er wandert in die Überschrift, die
 * Screenreader vorlesen, und steht sichtbar in den Kartenköpfen darunter.
 */
export function PortfolioWeltKopf({
  welt,
  kontext,
}: {
  welt: PortfolioWelt;
  /** „4 Anlagen · Juli 2026" — die Ebene und der Zeitraum in einem Satz. */
  kontext: string;
}) {
  return (
    <h1 className="vp-sr-only">
      {welt.label} — Portfolio, {PROVENIENZ[welt.badge].label} · {kontext}
    </h1>
  );
}

/**
 * Das Sprungfeld je Zeitraum (F2) - der Zwilling der Anlagen-Welt, seit dem
 * Picker-System ebenfalls der Haus-Picker statt eines nativen Felds (der
 * System-Kalender beginnt auf einem englisch eingestellten Rechner am SONNTAG).
 * Der WERT bleibt ISO, `ankerAusWert` liest ihn unveraendert.
 */
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

  const uebernehmen = (v: string) => {
    const d = ankerAusWert(v, range);
    if (d) onAnchor(d);
  };

  if (feld === 'year') {
    return (
      <VpPicker
        className="vp-zl-jump"
        ariaLabel={label}
        options={sprungJahre(anchor, now).map((j) => ({
          value: String(j),
          label: String(j),
        }))}
        value={wert}
        onChange={uebernehmen}
      />
    );
  }

  // Ohne anlagenscharfe Abdeckung wird nur die ZUKUNFT begrenzt - ein
  // geratenes Startdatum über eine ganze Flotte wäre eine Behauptung.
  const grenzen = sprungGrenzen(range, now, null);
  return (
    <VpDatePicker
      className="vp-zl-jump"
      ariaLabel={label}
      art={feld === 'week' ? 'woche' : feld === 'month' ? 'monat' : 'tag'}
      value={wert}
      onChange={uebernehmen}
      min={grenzen.min}
      max={grenzen.max}
    />
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
  /* E3: der Monatsstreifen war die ZWEITE Zeile der Leiste. Er wohnt jetzt
     hinter dem ⋯-Knopf — wie in der Anlagen-Welt, mit demselben Bauteil. */
  const [blattOffen, setBlattOffen] = useState(false);
  /* E3: am Telefon klebt die Leiste NICHT (sie ässe sonst ein Drittel des
     Bildschirms) und steht in zwei Zeilen — dieselbe Regel und dieselbe
     Klasse wie in der Anlagen-Welt. */
  const isPhone = useIsPhone();
  /* Das ⋯-Blatt trägt den Monatsstreifen und — am Telefon — das Sprungfeld. */
  const hatBlatt = streifen || isPhone;
  const mehrKnopf = hatBlatt ? (
    <button
      type="button"
      className="vp-zl-more"
      aria-label="Zeitraum & Monat"
      aria-expanded={blattOffen}
      onClick={() => setBlattOffen((o) => !o)}
    >
      <Icon name="more-horizontal" size={18} />
    </button>
  ) : null;
  return (
    <div className={isPhone ? 'vp-zeitleiste vp-zeitleiste-mobil' : 'vp-zeitleiste'}>
      <div className={isPhone ? 'vp-zl-row vp-zl-row-1' : 'vp-zl-row'}>
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
        {/* Am Telefon steht der ⋯-Knopf neben dem Zeitraum (Zeile 1), sonst am
            Ende der einen Zeile — dieselbe Anordnung wie in der Anlagen-Welt. */}
        {isPhone && mehrKnopf}
      </div>
      <div className={isPhone ? 'vp-zl-row vp-zl-row-2' : 'vp-zl-row-inline'}>
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
          {/* Am Telefon wohnt das Sprungfeld im ⋯-Blatt (E3) — sonst bräche die
              Bedienzeile in eine dritte Zeile. Dieselbe Regel wie in der
              Anlagen-Welt. */}
          {!isPhone && (
            <Sprungfeld range={range} anchor={anchor} now={now} onAnchor={onAnchor} />
          )}
        </div>
        {!isPhone && mehrKnopf}
      </div>
      {blattOffen && hatBlatt && (
        <ZeitPopover onClose={() => setBlattOffen(false)}>
          {isPhone && (
            <Sprungfeld range={range} anchor={anchor} now={now} onAnchor={onAnchor} />
          )}
          {streifen && (
          <MonthStrip
            slots={streifenSlots(now)}
            selectedMonth={`${sprungWert(anchor, 'month')}-01`}
            showValues={false}
            ariaLabel="Monat anspringen"
            onSelect={(monthIso) => {
              const d = streifenAnker(monthIso, range, now);
              if (d) onAnchor(d);
              setBlattOffen(false);
            }}
          />
          )}
        </ZeitPopover>
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
  // Seit Stufe 5 der geteilte Linien-Baustein. Sein Vertrag IST das, was
  // dieser Trend vorbildlich schon konnte (Null immer im Bild, Lücken bleiben
  // Lücken) - er hat es nur verallgemeinert und um die echte Nulllinie
  // ergänzt, die hier fehlte: ein negativer Trend hing vorher ohne Bezug im
  // Bild.
  const punkte = werte.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (punkte.length < 2) return <span className="vp-muted">—</span>;
  return (
    <MiniLineSpark
      className="vp-pf-spark"
      points={werte.map((value, i) => ({ key: String(i), value: value ?? null }))}
      width={80}
      ariaLabel={titel}
      style={farbe === DEFAULT_TREND_COLOR ? undefined : { ['--mini-line' as string]: farbe }}
    />
  );
}

/** Die Haus-Farbe des Portfolio-Trends (der Baustein setzt sie als Vorgabe). */
const DEFAULT_TREND_COLOR = 'var(--vp-navy, #1e3a5f)';

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
