/**
 * Das gemeinsame SKELETT beider Historie-Welten (Konzept
 * `data/vp-historie-konzept-t4` §4.2): Welt-Kopf → klebende Zeit-Leiste →
 * Karten → Fußkarte. Reine Render-Bausteine; jede Ableitung/Copy lebt im reinen
 * `historieWelten.ts` (das `PeakBand`/`FleetOverview`-Muster).
 *
 * Warum ein eigener Kopf statt der generischen Seiten-Überschrift: die Frage
 * „was schaue ich gerade an?" wird hier an Icon, Farbe, Titel, Abzeichen UND
 * dem Kartenpaar gleichzeitig beantwortet — und der Kopf ersetzt die frühere
 * Titel-/Untertitelzeile, statt sie zu ergänzen. Genau daran hing die
 * 515-px-Kopfzone am Telefon (vier Bedienzeilen: Welt · Zeitraum · Blätterer ·
 * Modus); übrig bleiben zwei.
 */
import type { ReactNode } from 'react';
import { Card } from '../../designsystem/components/core/Card';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { IconTile, type IconCategory } from '../../designsystem/components/core/IconTile';
import type { HistoryCoverage, HistoryRange } from '../api';
import {
  PROVENIENZ,
  type Provenienz,
  type Welt,
  type WeltSwitchCard,
} from '../historieWelten';
import {
  abdeckungView,
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
import type { DeltaView } from '../historieVergleich';
import { PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';
import { MonthStrip } from './MoneyView';

import './Historie.css';

/** Das Ehrlichkeits-Abzeichen einer Karte (genau eines je Karte, report §7). */
export function ProvBadge({ art }: { art: Provenienz }) {
  const info = PROVENIENZ[art];
  return (
    <span className={`vp-prov vp-prov-${art}`} title={info.satz}>
      {info.label}
    </span>
  );
}

/**
 * Der Kopf einer Karte: Icon-Kachel, Überschrift, Abzeichen — die eine Zeile,
 * die jede Karte beider Welten gleich aufbaut.
 */
export function KartenKopf({
  icon,
  category = 'dynamic',
  titel,
  art,
  extra,
}: {
  icon: IconName;
  category?: IconCategory;
  titel: string;
  art: Provenienz;
  extra?: ReactNode;
}) {
  return (
    <div className="vp-section-head" style={{ marginBottom: 'var(--vp-space-4)' }}>
      <IconTile category={category} size={40}>
        <Icon name={icon} size={20} />
      </IconTile>
      <h2>{titel}</h2>
      <ProvBadge art={art} />
      {extra}
    </div>
  );
}

/**
 * Welt-Kopf: Icon · Titel · Abzeichen · Einleitungssatz, darunter das
 * Kartenpaar für den Ein-Klick-Wechsel (leer = es gibt nur eine Welt, dann
 * rendert kein einsamer Schalter).
 */
export function WeltKopf({
  welt,
  cards,
  hrefFor,
  onOpen,
}: {
  welt: Welt;
  cards: WeltSwitchCard[];
  /** Der Link der Welt — echtes `href`, damit Öffnen-in-neuem-Tab funktioniert. */
  hrefFor: (card: WeltSwitchCard) => string;
  onOpen: (card: WeltSwitchCard) => void;
}) {
  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-welt-kopf vp-welt-${welt.id}`}
      // Die Kartenpolsterung ist am Telefon der größte Posten der Kopfzone;
      // `Card` setzt sie inline, also führen wir sie über eine Variable, die
      // die Medienabfrage schrumpfen kann (`style` gewinnt gegen `padding`).
      style={{ padding: 'var(--vp-welt-pad)' }}
    >
      <div className="vp-welt-head">
        <IconTile category="dynamic" size={44} style={{ background: 'var(--vp-welt-grad)' }}>
          <Icon name={welt.icon} size={22} />
        </IconTile>
        <div className="vp-welt-titles">
          <h1>
            {welt.label}
            <ProvBadge art={welt.badge} />
          </h1>
          <p>{welt.lead}</p>
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

/**
 * Das Sprungfeld der Zeit-Leiste (F2): ein NATIVES Datums-/Wochen-/Monatsfeld
 * bzw. eine Jahresauswahl — der Browser bringt seinen Kalender mit, und am
 * Telefon ist der des Systems jedem selbstgebauten überlegen.
 *
 * Grenzen kommen aus der Datenlage: nie in die Zukunft, nie vor die erste
 * gemessene Viertelstunde (`historieZeit.sprungGrenzen`).
 */
function Sprungfeld({
  range,
  anchor,
  now,
  coverage,
  onAnchor,
}: {
  range: HistoryRange;
  anchor: Date;
  now: Date;
  coverage?: HistoryCoverage | null;
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
          {sprungJahre(anchor, now, coverage).map((j) => (
            <option key={j} value={String(j)}>
              {j}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const grenzen = sprungGrenzen(range, now, coverage);
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
 * Die Datenlage-Zeile der Zeit-Leiste (F4): „Daten ab 19.06.2026 ▇▇▇▇░ 94 % der
 * Viertelstunden gemessen · 6 Lücken". Sie rendert NICHTS, wenn es nichts
 * Ehrliches zu sagen gibt — eine behauptete Abdeckung wäre schlimmer als keine.
 */
function AbdeckungZeile({
  coverage,
  stale,
}: {
  coverage?: HistoryCoverage | null;
  stale?: boolean;
}) {
  const view = abdeckungView(coverage);
  if (!view) return null;
  return (
    <div className={stale ? 'vp-zl-cover vp-zl-cover-stale' : 'vp-zl-cover'} title={view.titel}>
      {view.abText && <span className="vp-zl-ab">{view.abText}</span>}
      {view.balkenPct != null && (
        <span
          className="vp-zl-bar"
          role="img"
          aria-label={`Datenabdeckung ${view.balkenPct} Prozent`}
        >
          <i style={{ width: `${view.balkenPct}%` }} />
        </span>
      )}
      {view.satz && <span className="vp-zl-sat">{view.satz}</span>}
      {view.luecken && <span className="vp-zl-gap">· {view.luecken}</span>}
    </div>
  );
}

/**
 * Die klebende Zeit-Leiste — [Tag|Woche|Monat|Jahr] ‹ Anker › Heute 📅, darunter
 * der Monatsstreifen (Tag/Monat) und die Datenlage.
 *
 * Sie steht in BEIDEN Welten an derselben Stelle und regiert alles darunter
 * (dieselbe Idee wie die Bilanz-Leiste des Cockpits: der Zeitraum steht bei den
 * Zahlen, die er regiert). Klebend, weil man beim Lesen langer Seiten sonst
 * nach oben scrollen muss, um die Periode zu wechseln.
 *
 * **Der Schrittknopf ist nicht mehr die einzige Geste in die Vergangenheit**
 * (F2): daneben stehen das native Sprungfeld und — dort, wo Blättern wirklich
 * weh tut (Tag: 211 Klicks in den Januar, Monat: 7) — der Monatsstreifen aus
 * der Geld-Ansicht, hier als reiner Navigator ohne erfundene Zahlen.
 */
export function ZeitLeiste({
  range,
  anchor,
  onRange,
  onAnchor,
  coverage,
  stale,
  now = new Date(),
}: {
  range: HistoryRange;
  anchor: Date;
  onRange: (r: HistoryRange) => void;
  onAnchor: (d: Date) => void;
  /** Datenabdeckung des gezeigten Zeitraums (F4) — optional. */
  coverage?: HistoryCoverage | null;
  /** Die Abdeckung gehört noch zur vorherigen Periode (P5: gedimmt). */
  stale?: boolean;
  now?: Date;
}) {
  const nextDisabled = shiftAnchor(anchor, range, 1) > now;
  const streifen = zeigtStreifen(range);
  return (
    <div className="vp-zeitleiste">
      <div className="vp-zl-row">
        <div className="vp-seg" role="tablist" aria-label="Zeitraum">
          {PERIOD_RANGES.map((r) => (
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
          <Sprungfeld
            range={range}
            anchor={anchor}
            now={now}
            coverage={coverage}
            onAnchor={onAnchor}
          />
        </div>
      </div>
      {streifen && (
        <MonthStrip
          slots={streifenSlots(now, coverage)}
          selectedMonth={`${sprungWert(anchor, 'month')}-01`}
          showValues={false}
          ariaLabel="Monat anspringen"
          onSelect={(monthIso) => {
            const d = streifenAnker(monthIso, range, now);
            if (d) onAnchor(d);
          }}
        />
      )}
      <AbdeckungZeile coverage={coverage} stale={stale} />
    </div>
  );
}

/**
 * Die Vergleichszeile einer Kennzahl (F3) — „18 % mehr als im Juni". Rendert
 * NICHTS ohne ehrlichen Vergleich (`delta()` gibt dann null zurück): ein Δ
 * gegen eine erfundene Null wäre die teuerste Art zu lügen.
 */
export function DeltaZeile({ delta }: { delta: DeltaView | null }) {
  if (!delta) return null;
  return (
    <span className={`vp-delta vp-delta-${delta.wertung}`} title={delta.titel}>
      {delta.richtung !== 'gleich' && (
        <Icon name={delta.richtung === 'mehr' ? 'arrow-up' : 'arrow-down'} size={12} />
      )}
      {delta.text}
    </span>
  );
}

/**
 * P5-Vervollständigung: das Blättern lässt die alte Periode stehen — schlägt
 * der Abruf der NEUEN fehl, muss die Seite das sagen, sonst liest sich der
 * gedimmte Rest wie ein Ergebnis. Ein Balken, keine Karte: die Zahlen darunter
 * bleiben sichtbar, sie gehören nur zu einem anderen Zeitraum.
 */
export function PeriodeFehlgeschlagen({
  periode,
  onRetry,
}: {
  periode: string;
  onRetry: () => void;
}) {
  return (
    <div className="vp-zl-fehler" role="status">
      <Icon name="alert-triangle" size={16} aria-hidden="true" />
      <span>
        {periode} konnte nicht geladen werden — angezeigt bleibt der zuletzt geladene Zeitraum.
      </span>
      <button type="button" onClick={onRetry}>
        Erneut versuchen
      </button>
    </div>
  );
}

/** Die Fußkarte „Was diese Zahlen sind" — je Welt genau einmal, am Ende. */
export function WeltFuss({ welt }: { welt: Welt }) {
  return (
    <section className="vp-section">
      <Card padding="lg" radius="lg" className="vp-welt-fuss">
        <b>Was diese Zahlen sind</b>
        <p>{welt.fussText}</p>
      </Card>
    </section>
  );
}
