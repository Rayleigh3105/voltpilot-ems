import type { ReactNode } from 'react';
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
          {view.isBase ? view.fromTag : `Modus: ${view.fromTag}`}
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
