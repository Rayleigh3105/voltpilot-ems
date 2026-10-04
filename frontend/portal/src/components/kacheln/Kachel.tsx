import type { ReactNode, Ref } from 'react';
import { Icon, type IconName } from '../../../designsystem/components/core/Icon';
import type { KachelGroesse } from '../../cockpitLayout';
import './Kacheln.css';

/** Der Farbkanal einer Kachel: die Rollen-Töne des Flusses bzw. Geld und Plan. */
export type KachelTon = 'pv' | 'batt' | 'grid' | 'load' | 'geld' | 'plan' | 'neutral';

/** Die Größen im Raster: `klein` (eine Spalte), `breit` (zwei), `hoch` (zwei, am Rechner zwei Reihen). */
export type RasterGroesse = KachelGroesse | 'hoch';

/**
 * **Die Hülle einer Kachel** (Konzept `docs/konzepte/cockpit-tagesfilm`,
 * „Kachelkatalog“): ein Kopf mit Symbol, Name und Pfeil - er ist der Absprung
 * auf die Seite der Kachel -, darunter der Inhalt. Die Leitkachel trägt den
 * Stern. Alle Kacheln des Cockpits teilen diese Hülle, damit Kopf, Abstände
 * und Rand überall gleich sind.
 */
export function Kachel({
  id,
  name,
  icon,
  ton,
  groesse = 'klein',
  lead = false,
  onOpen,
  ziel,
  platzRef,
  className,
  fuss,
  children,
}: {
  id: string;
  name: string;
  icon: IconName;
  ton: KachelTon;
  groesse?: RasterGroesse;
  lead?: boolean;
  /** Absprung auf die Seite der Kachel; ohne Ziel ist der Kopf kein Knopf. */
  onOpen?: (() => void) | null;
  /** Für Vorlesen: wohin der Kopf führt („Marktpreise“). */
  ziel?: string;
  platzRef?: Ref<HTMLDivElement>;
  className?: string;
  /** Unter der Kachel, außerhalb ihres Rahmens (Anpassen: die Größe). */
  fuss?: ReactNode;
  children: ReactNode;
}) {
  const kopfInhalt = (
    <>
      <span className="vp-k-ico" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="vp-k-name">{name}</span>
      {lead && (
        <span className="vp-k-stern" title="Leitkachel" aria-label="Leitkachel">
          <Icon name="star" size={14} />
        </span>
      )}
      {onOpen && (
        <span className="vp-k-chev" aria-hidden="true">
          <Icon name="chevron-right" size={16} />
        </span>
      )}
    </>
  );
  return (
    <div ref={platzRef} className={`vp-k-platz is-${groesse}`} data-kachel={id}>
      <article className={`vp-k ton-${ton}${lead ? ' is-lead' : ''}${className ? ` ${className}` : ''}`} aria-label={name}>
        {onOpen ? (
          <button type="button" className="vp-k-kopf" onClick={onOpen} aria-label={`${name}${ziel ? ` · ${ziel}` : ''} öffnen`}>
            {kopfInhalt}
          </button>
        ) : (
          <div className="vp-k-kopf">{kopfInhalt}</div>
        )}
        {children}
      </article>
      {fuss}
    </div>
  );
}

/** Die ruhige Marke unten in einer Kachel: gemessen, geplant, erwartet. */
export function Marke({ art = 'neutral', children }: { art?: 'neutral' | 'plan' | 'ok' | 'warn'; children: ReactNode }) {
  return <span className={`vp-k-marke is-${art}`}>{children}</span>;
}

/** Die große Zahl einer Kachel mit Einheit. */
export function Gross({ wert, einheit, xl = false }: { wert: string; einheit?: string; xl?: boolean }) {
  return (
    <span className={`vp-k-gross${xl ? ' is-xl' : ''}`}>
      {wert}
      {einheit && <span className="vp-k-einheit">{einheit}</span>}
    </span>
  );
}

/**
 * Im Anpassen-Modus unter einer Kachel: ihre Größe (`klein`/`breit`), soweit
 * der Katalog mehr als eine erlaubt; sonst ein ruhiger Satz.
 */
export function GroessenWahl({
  label,
  groessen,
  aktuell,
  onWahl,
}: {
  label: string;
  groessen: KachelGroesse[];
  aktuell: KachelGroesse;
  onWahl: (g: KachelGroesse) => void;
}) {
  if (groessen.length < 2) return <p className="vp-widget-groesse-fest">immer {aktuell}</p>;
  return (
    <div className="vp-seg vp-seg-compact vp-widget-groesse" role="group" aria-label={`Größe von ${label}`}>
      {groessen.map((g) => (
        <button key={g} type="button" aria-pressed={aktuell === g} className={aktuell === g ? 'active' : ''} onClick={() => onWahl(g)}>
          {g}
        </button>
      ))}
    </div>
  );
}
