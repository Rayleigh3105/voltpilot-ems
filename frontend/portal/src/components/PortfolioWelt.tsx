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
import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import type { HistoryRange } from '../api';
import { PROVENIENZ } from '../historieWelten';
import { useIsPhone } from '../useIsPhone';
import { ZeitPopover } from './HistorieWelt';
import { VerlaufKarte } from './VerlaufKarte';
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

/** Eine Anlage der Flotte — die EINE Form, aus der beide Zwillinge lesen. */
export interface AnlagenZeileView {
  id: string;
  name: string;
  /** Der ehrliche Grund, wenn diese Anlage nichts beiträgt. */
  hinweis?: string | null;
  /** Die Adresse derselben Welt DIESER Anlage im GLEICHEN Zeitraum. */
  href: string;
  onOpen: () => void;
  /** Die fertigen Werte — in der Reihenfolge von `kopf`, samt Einheit. */
  werte: readonly string[];
  /** Die Mini-Kurve der Spalte „Verlauf". */
  spark: readonly (number | null)[];
  sparkTitel: string;
  sparkFarbe: string;
}

/**
 * **E6 · Liste statt Tabelle am Telefon** (Captain-Entscheid 03.09.2026,
 * wörtlich: „a) am Telefon immer Liste (V7), ab 700 px Tabelle") — für die
 * Anlagen-Tabelle beider Portfolio-Welten (Paket P8, E1 b).
 *
 * ⚠ Es sind ZWEI Bäume aus DENSELBEN Daten, nicht eine Tabelle mit
 *   `data-label`: eine Etikett/Wert-Karte MIT Tabellen-Semantik lässt einen
 *   Screenreader Spaltenköpfe vorlesen, die es optisch gar nicht gibt (die
 *   verworfene Option (c) des Entscheids). Die Grenze ist die Haus-Grenze
 *   720 px (`useIsPhone`), also dieselbe, an der der Bereich sonst umschaltet.
 *
 * ⚠ Am Telefon fällt seit P8 KEINE Spalte mehr weg. Die frühere Regel
 *   „Eingespeist wird unter 720 px ausgeblendet" (`.vp-pf-col-kwh`) war eine
 *   Notlösung der Tabellen-Klappform; die Liste trägt alle Werte in ihrer
 *   Sekundärzeile, also gibt es nichts mehr zu verstecken.
 *
 * `kopf` nennt NUR die Zahlen-Spalten. „Anlage" und „Verlauf" sind die zwei
 * festen Ränder jeder Zeile und stehen deshalb nicht in der Liste — so kann
 * kein Aufrufer sie an eine andere Stelle rutschen lassen.
 */
export function AnlagenBlock({
  label,
  kopf,
  zeilen,
}: {
  /** Das Label der Karte, 12/700 (V4). */
  label: string;
  /** Die Zahlen-Spalten, ohne „Anlage" und „Verlauf". */
  kopf: readonly string[];
  zeilen: readonly AnlagenZeileView[];
}) {
  const isPhone = useIsPhone();
  return (
    <VerlaufKarte label={label}>
      {isPhone ? (
        <ZeilenListe kopf={kopf} zeilen={zeilen} label={label} />
      ) : (
        <ZeilenTabelle kopf={kopf} zeilen={zeilen} />
      )}
    </VerlaufKarte>
  );
}

/**
 * Der Klick-Weg einer Zeile: ein ECHTER Link (Tastatur, Mittelklick und
 * „in neuem Tab öffnen" funktionieren), der den gewöhnlichen Klick abfängt und
 * die Welt im Rahmen der Anwendung öffnet.
 */
function beiKlick(onOpen: () => void) {
  return (e: ReactMouseEvent<HTMLElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onOpen();
  };
}

/** V7 · Die Liste am Telefon: Name links, führender Wert rechts, Rest darunter.
 *  ⚠ Nicht zu verwechseln mit `components/AnlagenTabelle.tsx` — das ist die
 *  Flotten-Tabelle des PORTFOLIO-COCKPITS (Stufe 4), eine andere Fläche. */
function ZeilenListe({
  kopf,
  zeilen,
  label,
}: {
  kopf: readonly string[];
  zeilen: readonly AnlagenZeileView[];
  label: string;
}) {
  return (
    <ul className="vp-c-pfl" aria-label={label}>
      {zeilen.map((z) => (
        <li key={z.id} className="vp-c-pfl-row">
          {/* ⚠ Die ganze Zeile ist der Weg — 48 px hoch (V7), damit die
              Trefferfläche nicht so breit ist wie der Name der Anlage. */}
          <a className="vp-c-pfl-a" href={z.href} onClick={beiKlick(z.onOpen)}>
            <span className="vp-c-pfl-name">{z.name}</span>
            <span className="vp-c-pfl-wert">{z.werte[0] ?? '—'}</span>
            <span className="vp-c-pfl-chev" aria-hidden="true" />
            {kopf.length > 1 && (
              <span className="vp-c-pfl-sek">
                {kopf.slice(1).map((k, i) => (
                  <span key={k} className="vp-c-pfl-paar">
                    <span className="vp-c-pfl-lab">{k}</span> {z.werte[i + 1] ?? '—'}
                  </span>
                ))}
              </span>
            )}
            <span className="vp-c-pfl-trend">
              <MiniTrend werte={z.spark} titel={z.sparkTitel} farbe={z.sparkFarbe} />
            </span>
            {z.hinweis && <span className="vp-c-pfl-note">{z.hinweis}</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Die Tabelle ab 721 px — die EINZIGE echte `<table>` des Bereichs „Verlauf"
 * (Bauplan §7, Zeile P8). Kopf 12/700 Versalien auf `--vp-c-muted` (V7).
 */
function ZeilenTabelle({
  kopf,
  zeilen,
}: {
  kopf: readonly string[];
  zeilen: readonly AnlagenZeileView[];
}) {
  return (
    <table className="vp-c-pft">
      <thead>
        <tr>
          <th scope="col">Anlage</th>
          {kopf.map((k) => (
            <th key={k} scope="col" className="num">
              {k}
            </th>
          ))}
          <th scope="col">Verlauf</th>
        </tr>
      </thead>
      <tbody>
        {zeilen.map((z) => (
          <tr key={z.id} className="clickable" onClick={z.onOpen}>
            <th scope="row">
              <a href={z.href} onClick={beiKlick(z.onOpen)}>
                {z.name}
              </a>
              {z.hinweis && <span className="vp-c-pft-note">{z.hinweis}</span>}
            </th>
            {kopf.map((k, i) => (
              <td key={k} className="num">
                <span className="vp-c-pft-v">{z.werte[i] ?? '—'}</span>
              </td>
            ))}
            <td>
              <MiniTrend werte={z.spark} titel={z.sparkTitel} farbe={z.sparkFarbe} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Die Fußkarte „Was diese Zahlen sind" — je Welt genau einmal, am Ende. */
export function PortfolioWeltFuss({ welt }: { welt: PortfolioWelt }) {
  return (
    <section className="vp-section">
      {/* P8 · dieselbe Hülle und dieselbe Schrift wie der Fuß der Reiter
          (`VerlaufFuss`): `.vp-c-card` setzt `--vp-c-font`, die Haus-Karte
          nicht. Das Abzeichen wechselt dabei auf die EINE Chip-Optik des
          Bereichs (E9/P0) — es bleibt, es sieht nur aus wie sein Nachbar. */}
      <div className="vp-c-card vp-c-fuss">
        <b className="vp-c-fuss-titel">Was diese Zahlen sind</b>
        <p className="vp-c-fuss-text">{welt.fussText}</p>
        <p className="vp-c-fuss-text vp-pf-fuss-badge">
          <span className="vp-chip">{PROVENIENZ[welt.badge].label}</span>{' '}
          {PROVENIENZ[welt.badge].satz}
        </p>
      </div>
    </section>
  );
}
