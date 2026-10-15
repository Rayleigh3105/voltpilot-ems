import { Icon } from '../../designsystem/components/core/Icon';
import { WORT_UEBERWACHEN, WORT_UEBERWACHT } from '../meldungen';
import { RowMenu } from './RowMenu';
import './WertZeile.css';

/**
 * Der Baustein „Wert-Zeile" (Alerting Scheibe 2, Konzept `vp-alerting-konzept-m1` §6.3: „Die
 * gemeinsamen Bausteine, die Werte zeigen (Kachel, Wert-Zeile, Statuszeile, Diagrammkopf) …") -
 * das Menü ⋯ „Überwachen" und die Marke „überwacht" an einem Wert AUSSERHALB der Kachel
 * (`components/kacheln/Kachel.tsx`): die Aufbau-Tabelle (`AufbauTabelle.tsx`, Spalte „Wert") und
 * die Geräteseite (`GeraetBuehne.tsx`, Eigenbau-Kanäle). Dasselbe Muster wie `MomentWert` im
 * Cockpit (`EnergieBuehne.tsx`), hier für dichte Zeilen/Chips statt der vier Live-Kreise.
 *
 * Reines Anzeigen + Weiterreichen: diese Komponente kennt keine API, keinen Wertverweis-Bezug -
 * sie bekommt nur, OB der Wert schon überwacht wird (und ob er im Probelauf ist) und WAS beim
 * Antippen von „Überwachen" passiert. Die Fläche selbst hält den Bezug (Komponente+Kanal) und
 * öffnet das Blatt (`UeberwachenBlatt`).
 */
export function WertZeile({
  label,
  ueberwacht,
  onUeberwachen,
  className,
}: {
  /** Für das Menü-Label „Werkzeuge: …" und den Link-Text der Marke - der Name des Werts. */
  label: string;
  /**
   * `undefined` = nicht überwacht (keine Marke); `null` = überwacht, kein Probelauf (mehr);
   * ein ISO-Zeitpunkt = überwacht UND im Probelauf (bis dahin).
   */
  ueberwacht?: string | null;
  /** Öffnet das Blatt „Überwachen"; fehlt, wenn diese Fläche (noch) keinen Wertverweis kennt. */
  onUeberwachen?: () => void;
  className?: string;
}) {
  if (ueberwacht === undefined && !onUeberwachen) return null;
  return (
    <span className={`vp-wz${className ? ` ${className}` : ''}`}>
      {ueberwacht !== undefined && (
        <a className="vp-wz-marke" href="#/meldungen" aria-label={`${label}: ${WORT_UEBERWACHT}`}>
          <Icon name="bell" size={11} />
          {WORT_UEBERWACHT}
          {ueberwacht && <span className="vp-wz-probe"> · Probelauf</span>}
        </a>
      )}
      {onUeberwachen && (
        <RowMenu
          label={`Werkzeuge: ${label}`}
          items={[{ label: WORT_UEBERWACHEN, icon: 'bell', onClick: onUeberwachen, recht: 'ueberwachung.eigene' }]}
        />
      )}
    </span>
  );
}
