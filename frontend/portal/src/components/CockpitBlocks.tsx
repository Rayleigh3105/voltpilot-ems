import type { ReactNode } from 'react';
import { Badge } from '../../designsystem/components/core/Badge';
import { Card } from '../../designsystem/components/core/Card';
import { Icon } from '../../designsystem/components/core/Icon';
import type { AnlagenSub } from '../nav';
import {
  TOOLBOX_ACTION,
  TOOLBOX_POINTER,
  type BlockTile,
  type CockpitBlockView,
  type EigenverbrauchBlockView,
  type HandelBlockView,
  type AutomationRow,
} from '../cockpit';
import {
  heroChips,
  type CockpitHeroView,
  type MobileRow,
  type StickyHead,
} from '../cockpitWidgets';
import { SteuerungFormel } from './SteuerungFormel';
import './CockpitBlocks.css';

/**
 * M3 (#531) — die Render-Hälfte des **Modul-Stapels**. Jede Ableitung liegt im
 * reinen, unit-getesteten `src/cockpit.ts`; hier wird nur gerendert.
 *
 * Der gemeinsame **Blockrahmen** trägt drei Dinge, die die Projektion lesbar
 * machen (report §1.1/§2.2): Titel, das sichtbare **„von"-Tag** (welcher Modus
 * den Block beisteuert; Basis-Blöcke sagen „Entitäten") und die **Drill-ins**
 * in die Tiefen-Sichten, die die abgelöste Tab-Leiste ersetzen.
 */
export function CockpitBlock({
  view,
  onOpenSub,
  children,
}: {
  view: CockpitBlockView;
  onOpenSub: (sub: AnlagenSub) => void;
  children: ReactNode;
}) {
  return (
    <Card
      padding="lg"
      radius="lg"
      className={`vp-block${view.lead ? ' vp-block-lead' : ''}`}
      style={{ minWidth: 0 }}
    >
      <header className="vp-block-head">
        <h3 className="vp-block-title">{view.title}</h3>
        <span className={`vp-block-from${view.isBase ? ' is-base' : ''}`}>
          {view.isBase ? view.fromTag : `Betriebsmodell: ${view.fromTag}`}
        </span>
        {view.drillIns.length > 0 && (
          <span className="vp-block-drills">
            {view.drillIns.map((d) => (
              <button
                key={`${d.sub}:${d.label}`}
                type="button"
                className="vp-block-drill"
                title={d.hint}
                onClick={() => onOpenSub(d.sub)}
              >
                {d.label}
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
          </span>
        )}
      </header>
      {children}
    </Card>
  );
}

/** Eine Kachelreihe (Handel-/Eigenverbrauchs-Block). */
function Tiles({ tiles }: { tiles: BlockTile[] }) {
  return (
    <div className="vp-block-tiles">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="vp-block-tile"
          style={{ ['--tile-hue' as string]: `var(--vp-flow-${t.hue})` }}
        >
          <span className="vp-block-tile-label">{t.label}</span>
          <span className="vp-block-tile-value">{t.value}</span>
          {t.sub && <span className="vp-block-tile-sub">{t.sub}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * Der **Handel-Block** (iff Markt-Modus): die Handels-Erzählung des Tages —
 * was verdient wurde, wann geladen und wann verkauft wird. Alle Zahlen kommen
 * aus bestehenden Earnings-Feldern und dem persistierten Fahrplan.
 */
export function HandelBlockBody({ view }: { view: HandelBlockView }) {
  if (view.isEmpty) {
    return (
      <p className="vp-block-note">
        Sobald ein Fahrplan und Börsenpreise vorliegen, steht hier Ihre
        Handels-Erzählung des Tages.
      </p>
    );
  }
  return (
    <>
      <Tiles tiles={view.tiles} />
      {view.praemieNote && <p className="vp-block-note">{view.praemieNote}</p>}
    </>
  );
}

/**
 * Der **Eigenverbrauchs-Block** (iff EV-Modus): Autarkie, PV-Nutzung und wie
 * weit der Speicher heute trägt.
 */
export function EigenverbrauchBlockBody({ view }: { view: EigenverbrauchBlockView }) {
  if (view.isEmpty) {
    return (
      <p className="vp-block-note">
        Sobald Ihre Anlage einen vollen Tag gemessen hat, stehen hier Autarkie
        und PV-Nutzung.
      </p>
    );
  }
  return <Tiles tiles={view.tiles} />;
}

/** Der **Geräte-Automatik**-Block (iff Automationen): eine Zeile je Regel. */
export function GeraeteAutomatikBody({ rows }: { rows: AutomationRow[] }) {
  return (
    <ul className="vp-automations">
      {rows.map((r) => (
        <li key={r.key} className="vp-automation">
          <Icon name="zap" size={16} />
          <span className="vp-automation-name">{r.name}</span>
          <span className="vp-automation-line">{r.line}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Die EINE ruhige Zeile, die auf die Toolbox zeigt (report §0/§1.3): sie wirbt
 * NIE für einen bestimmten Modus — die volle Auswahl lebt in Steuerung →
 * „Modus hinzufügen".
 */
export function ToolboxPointer({ onOpen }: { onOpen: () => void }) {
  return (
    <p className="vp-toolbox-line">
      {TOOLBOX_POINTER} —
      <button type="button" className="vp-toolbox-cta" onClick={onOpen}>
        {TOOLBOX_ACTION}
        <Icon name="chevron-right" size={14} />
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Mobil-Umbau Stufe 2 — die Telefon-Fassung des Cockpits (<= 720 px)
// ---------------------------------------------------------------------------
//
// Render-only, wie alles hier: JEDE Regel steht im reinen `cockpitWidgets.ts`
// (`heroChips`/`fahrplanZeile`/`preisZeile`/`stickyHead`/`mobileWidgets`).
// Diese Bausteine erscheinen ausschliesslich unterhalb der Telefon-Grenze
// (`useIsPhone`), die Buehne oberhalb bleibt unangetastet.

/**
 * Die EINE Geld-Karte, direkt unter dem Fluss: Zeitraum-Segment, Zahl,
 * Zurechnung und die Ringe als Chips. Am Telefon ersetzt sie die Bilanz-Leiste
 * der Buehne UND die Kacheln „Erloese"/„Handel" — dieselbe Aussage stand dort
 * bis zu viermal auf einem halben Bildschirm.
 */
export function MobileMoneyCard({
  view,
  periodSeg,
}: {
  view: CockpitHeroView;
  periodSeg?: ReactNode;
}) {
  const chips = heroChips(view.rings);
  // Eine Karte ohne Geld, ohne Chips und ohne Zeitraum-Wahl haette nichts zu
  // sagen - dann gibt es sie nicht (kein leerer Rahmen).
  if (!view.money && chips.length === 0 && !periodSeg) return null;
  return (
    <Card padding="lg" radius="lg" className="vp-mob-money" style={{ minWidth: 0 }}>
      {/* Zahl links, Zeitraum-Segment rechts DANEBEN (nicht darüber): das
          Segment regiert genau diese Zahl, und eine eigene Zeile dafür kostet
          am Telefon ~40 px, ohne etwas zu erklären. */}
      <div className="vp-mob-money-top">
        <span className="vp-mob-money-main">
          {view.money && (
            <>
              <span className="vp-mob-money-label">{view.money.label}</span>
              <span className="vp-mob-money-value">{view.money.value}</span>
            </>
          )}
        </span>
        {periodSeg && <span className="vp-mob-money-seg">{periodSeg}</span>}
      </div>
      {view.money?.attribution && (
        <span
          className={`vp-mob-money-attr${view.money.attributionInterim ? ' is-interim' : ''}`}
          title={view.money.attributionTitel ?? undefined}
        >
          {view.money.attribution}
        </span>
      )}
      {view.money?.bestand && (
        <span className="vp-mob-money-bestand" title={view.money.bestand.titel ?? undefined}>
          <span>{view.money.bestand.text}</span>
          {view.money.bestand.badge && (
            <Badge variant="tint" className="vp-mob-money-bestand-badge">
              {view.money.bestand.badge}
            </Badge>
          )}
        </span>
      )}
      {/* Dieselbe Erklaerung wie am Rechner - der Chip erklaert sich ueberall. */}
      {view.money?.formel && <SteuerungFormel input={view.money.formel} />}
      {chips.length > 0 ? (
        <div className="vp-mob-chips">
          {chips.map((c) => (
            <span key={c.id} className={`vp-mob-chip vp-mob-chip-${c.id}`} title={c.title}>
              {c.text}
            </span>
          ))}
        </div>
      ) : (
        view.ringsNote && <p className="vp-mob-money-note">{view.ringsNote}</p>
      )}
    </Card>
  );
}

/**
 * Eine Aussage-ZEILE mit Absprung (Fahrplan, Boersenpreis). Am Telefon tragen
 * die zwei Karten ihre Diagramme nicht mehr selbst — die wohnen auf den
 * Zielseiten, die seit Mobil-Stufe 1 in der Bottom-Bar sitzen.
 */
export function MobileRowCard({
  icon,
  row,
  linkLabel,
  onOpen,
  badge,
}: {
  icon: 'zap' | 'trending-up' | 'euro';
  row: MobileRow;
  linkLabel: string;
  onOpen: () => void;
  /** Das Provenienz-Abzeichen („Geplant"); null = keines. */
  badge?: { label: string; title: string } | null;
}) {
  return (
    <Card padding="lg" radius="lg" className="vp-mob-row" style={{ minWidth: 0 }}>
      <button type="button" className="vp-mob-row-btn" onClick={onOpen}>
        <Icon name={icon} size={16} />
        <span className="vp-mob-row-texts">
          <span className="vp-mob-row-head">
            {row.head}
            {badge && (
              <span className="vp-mob-row-badge" title={badge.title}>
                {badge.label}
              </span>
            )}
          </span>
          {row.sub && <span className="vp-mob-row-sub">{row.sub}</span>}
        </span>
        <span className="vp-mob-row-link">
          {linkLabel}
          <Icon name="chevron-right" size={15} />
        </span>
      </button>
    </Card>
  );
}

/**
 * Die geschrumpfte Kopfzahl beim Scrollen: sie erscheint erst, wenn die
 * Geld-Karte aus dem Bild gescrollt ist, und traegt genau die zwei Anker
 * (Geld + Zustand). `shown=false` haelt sie ausserhalb des Bildes, statt sie
 * zu entfernen — so springt das Layout nie.
 */
export function MobileStickyHead({ head, shown }: { head: StickyHead; shown: boolean }) {
  return (
    <div className={`vp-mob-sticky${shown ? ' is-shown' : ''}`} aria-hidden={!shown}>
      {head.value && (
        <span className="vp-mob-sticky-money">
          <b>{head.value}</b>
          {head.label && <span className="vp-mob-sticky-label">{head.label}</span>}
        </span>
      )}
      {head.status && (
        <span className={`vp-mob-sticky-state tone-${head.tone}`}>{head.status}</span>
      )}
    </div>
  );
}
