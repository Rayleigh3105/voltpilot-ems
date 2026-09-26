import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { Button } from '../../designsystem/components/core/Button';
import { Modal } from '../../designsystem/components/shell/Modal';
import type { AufbauKategorie } from '../aufbauBaum';
import { AufbauSymbol } from './AufbauTabelle';
import { Recht } from './Recht';
import './Einrichten.css';

/**
 * Die EINRICHTEN-SEITE (Konzept „Aufbau und Gerätekatalog", Runde 2): nach der
 * Wahl im Katalog EINE Seite statt eines Schritt-Assistenten. Die Abschnitte
 * stehen untereinander; die Leiste links zeigt, was fertig ist, was jetzt dran
 * ist und was danach kommt. Jeder Weg endet gleich: erst echte Werte, dann der
 * Name, dann „Speichern".
 *
 * Nur die Hülle - was ein Abschnitt fragt und wann er fertig ist, entscheidet
 * der jeweilige Weg (Katalog-Gerät, Ladesäule, Batterie, Modbus-Gerät). Das
 * Fenster ist das Haus-`Modal`: zentriert am Rechner, bildschirmfüllend am
 * Telefon, mit Fokusfalle, Escape und Rückkehr zum Auslöser.
 */
export function EinrichtenSeite({
  open = true,
  titel,
  onClose,
  onZurueck,
  kopf,
  fuss,
  children,
}: {
  open?: boolean;
  titel: string;
  onClose: () => void;
  /** Zurück in den Katalog; null = die Seite wurde nicht aus dem Katalog geöffnet. */
  onZurueck?: (() => void) | null;
  kopf?: ReactNode;
  fuss: ReactNode;
  children: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titel}
      icon={
        onZurueck ? (
          <button type="button" className="vp-ein-zurueck" onClick={onZurueck} aria-label="Zurück zum Katalog">
            <Icon name="chevron-left" size={20} />
          </button>
        ) : undefined
      }
      footer={fuss}
    >
      <div className="vp-ein">
        {kopf}
        {children}
      </div>
    </Modal>
  );
}

/** Der Kopf: welches Gerät, wie es angebunden wird, und was man dafür braucht. */
export function EinrichtenKopf({
  titel,
  unterzeile,
  kategorie,
  icon,
  brauchen,
  hinweis,
}: {
  titel: string;
  unterzeile: string;
  kategorie: AufbauKategorie;
  icon: IconName;
  /** „Sie brauchen: …" - die Pflichtangaben, bevor man anfängt. */
  brauchen: string[];
  hinweis?: ReactNode;
}) {
  return (
    <div className="vp-ein-kopf">
      <AufbauSymbol kategorie={kategorie} icon={icon} />
      <span className="vp-ein-kopf-text">
        <b>{titel}</b>
        <small>{unterzeile}</small>
      </span>
      {brauchen.length > 0 && (
        <p className="vp-ein-brauchen">
          Sie brauchen:
          {brauchen.map((b) => (
            <span key={b}>{b}</span>
          ))}
        </p>
      )}
      {hinweis && <p className="vp-ein-kopf-hinweis">{hinweis}</p>}
    </div>
  );
}

export type AbschnittZustand = 'aktiv' | 'fertig' | 'spaeter' | 'fehler';

export function Abschnitte({ children }: { children: ReactNode }) {
  return <ol className="vp-ein-liste">{children}</ol>;
}

/**
 * EIN Abschnitt der Seite. `spaeter` zeigt nur Titel und den Satz, wann er dran
 * ist - ein Formular, das noch nichts tun kann, wird nicht schon ausgebreitet.
 */
export function Abschnitt({
  nummer,
  zustand,
  titel,
  stand,
  spaeter,
  id,
  children,
}: {
  nummer: number;
  zustand: AbschnittZustand;
  titel: string;
  /** Eine leise Angabe rechts im Titel („vollständig", „läuft …"). */
  stand?: string | null;
  /** Der Satz eines späteren Abschnitts („Startet von selbst, sobald …"). */
  spaeter?: string;
  id?: string;
  children?: ReactNode;
}) {
  return (
    <li className={`vp-ein-abschnitt is-${zustand}`} id={id} aria-current={zustand === 'aktiv' ? 'step' : undefined}>
      <span className="vp-ein-marke" aria-hidden="true">
        {zustand === 'fertig' ? <Icon name="check" size={14} /> : zustand === 'fehler' ? '!' : nummer}
      </span>
      <div className="vp-ein-rumpf">
        <h3>
          <span>{titel}</span>
          {stand && <small>{stand}</small>}
        </h3>
        {zustand === 'spaeter' ? spaeter && <p className="vp-ein-spaeter">{spaeter}</p> : children}
      </div>
    </li>
  );
}

/** Der Fuß: warum „Speichern" noch nicht geht (nie ein stummer grauer Knopf), Abbrechen, Speichern. */
export function EinrichtenFuss({
  grund,
  onAbbrechen,
  primaer,
  zweit,
}: {
  grund: string | null;
  /** Ohne = es gibt nichts abzubrechen (die Ladesäule legt nichts an). */
  onAbbrechen?: () => void;
  /** `aktion`: die Rechte-Weiche (AP-03 IP-12) für einen schreibenden Knopf; ohne = kein Schreibweg. */
  primaer: { label: string; onClick: () => void; disabled?: boolean; testId?: string; aktion?: string };
  /** Eine zweite Handlung neben „Abbrechen" (selten). */
  zweit?: ReactNode;
}) {
  const knopf = (
    <Button onClick={primaer.onClick} disabled={primaer.disabled} data-testid={primaer.testId}>
      {primaer.label}
    </Button>
  );
  return (
    <div className="vp-ein-fuss">
      {grund && (
        <p className="vp-ein-grund" role="status">
          {grund}
        </p>
      )}
      <div className="vp-ein-knoepfe">
        {onAbbrechen && (
          <Button variant="ghost" onClick={onAbbrechen}>
            Abbrechen
          </Button>
        )}
        {zweit}
        {primaer.aktion ? <Recht aktion={primaer.aktion}>{knopf}</Recht> : knopf}
      </div>
    </div>
  );
}
