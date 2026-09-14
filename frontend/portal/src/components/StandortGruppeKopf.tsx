import { Icon } from '../../designsystem/components/core/Icon';
import {
  FUNKTIONEN_UNBEKANNT,
  OHNE_STANDORT_SATZ,
  type FunktionsZeile,
  type StandortGruppe,
} from '../uebersicht';
import './StandortGruppeKopf.css';

/**
 * Beide Funktionen eines Standorts, je eine Zeile: Punkt · Name · Satz des
 * Servers (UEMS AP-01 IP-6, E6 = C). Immer beide — ein Standort ohne
 * eingerichtete Funktion trägt den benannten Zustand, nie eine leere Zelle.
 *
 * Render-only: Zustand, Ton und Satz entstehen in `uebersicht.funktionsZeilen`.
 */
export function FunktionsZustaende({
  zeilen,
  laedt = false,
}: {
  /** `null` = nicht abrufbar. */
  zeilen: FunktionsZeile[] | null;
  /** Die Funktionen sind noch unterwegs — Laden ist nicht „nicht abrufbar". */
  laedt?: boolean;
}) {
  if (laedt) return <p className="vp-ueb-funktion-hinweis">Wird geladen …</p>;
  if (zeilen == null) return <p className="vp-ueb-funktion-hinweis">{FUNKTIONEN_UNBEKANNT}</p>;
  return (
    <ul className="vp-ueb-funktionen" aria-label="Funktionen">
      {zeilen.map((z) => (
        <li key={z.funktion} className={`is-${z.ton}`} data-zustand={z.zustand}>
          <span className="vp-ueb-funktion-name">{z.label}</span>
          <span className="vp-ueb-funktion-satz">{z.satz}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Der Kopf einer Standort-Gruppe der Anlagen-Tabelle — die STANDORT-KARTE der
 * Unternehmens-Übersicht: Name (führt zur Standort-Übersicht), die Zahlen mit
 * der Datenlage, darunter beide Funktionen.
 *
 * ⚠ Er steht am Rechner in einem `<th scope="rowgroup">` — dort sind keine
 * Überschriften erlaubt; der Name ist deshalb ein Knopf, keine `h2`.
 */
export function StandortGruppeKopf({
  gruppe,
  laedt = false,
  onOeffnen,
  onZuordnen,
}: {
  gruppe: StandortGruppe;
  laedt?: boolean;
  onOeffnen: (standortId: string) => void;
  /** Der Weg für Anlagen ohne Standort: die Liste „Standorte". */
  onZuordnen: () => void;
}) {
  const { standortId } = gruppe;
  return (
    <div className="vp-ueb-standort" data-testid="standort-gruppe">
      <div className="vp-ueb-standort-kopf">
        {standortId ? (
          <button
            type="button"
            className="vp-ueb-standort-name"
            aria-label={`Standort ${gruppe.name} öffnen`}
            onClick={() => onOeffnen(standortId)}
          >
            <span className="vp-ueb-standort-text">{gruppe.name}</span>
            {gruppe.kurzzeichen && <span className="vp-ueb-kz">{gruppe.kurzzeichen}</span>}
            <Icon name="chevron-right" size={16} />
          </button>
        ) : (
          <span className="vp-ueb-standort-name is-ohne">
            <span className="vp-ueb-standort-text">{gruppe.name}</span>
          </span>
        )}
        <span className={`vp-ueb-zahlen is-${gruppe.ton}`}>
          <span className="vp-ueb-punkt" aria-hidden="true" />
          {gruppe.zahlen}
        </span>
      </div>
      {standortId ? (
        <FunktionsZustaende zeilen={gruppe.funktionen} laedt={laedt} />
      ) : (
        <p className="vp-ueb-funktion-hinweis">
          {OHNE_STANDORT_SATZ}{' '}
          <button type="button" className="vp-ueb-weg" onClick={onZuordnen}>
            Zu den Standorten
          </button>
        </p>
      )}
    </div>
  );
}
