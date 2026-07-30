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
import type { HistoryRange } from '../api';
import {
  PROVENIENZ,
  type Provenienz,
  type Welt,
  type WeltSwitchCard,
} from '../historieWelten';
import { PERIOD_RANGES, periodLabel, shiftAnchor } from '../periodNav';

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
 * Die klebende Zeit-Leiste — [Tag|Woche|Monat|Jahr] ‹ Anker › Heute.
 *
 * Sie steht in BEIDEN Welten an derselben Stelle und regiert alles darunter
 * (dieselbe Idee wie die Bilanz-Leiste des Cockpits: der Zeitraum steht bei den
 * Zahlen, die er regiert). Klebend, weil man beim Lesen langer Seiten sonst
 * nach oben scrollen muss, um die Periode zu wechseln.
 */
export function ZeitLeiste({
  range,
  anchor,
  onRange,
  onAnchor,
}: {
  range: HistoryRange;
  anchor: Date;
  onRange: (r: HistoryRange) => void;
  onAnchor: (d: Date) => void;
}) {
  const nextDisabled = shiftAnchor(anchor, range, 1) > new Date();
  return (
    <div className="vp-zeitleiste">
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
      </div>
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
