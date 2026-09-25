import { Icon } from '../../designsystem/components/core/Icon';
import { UEMS_NORMGRENZE, UEMS_VERANTWORTUNG } from '../glossar';
import {
  ENERGIEMANAGEMENT_OEFFNEN,
  ENERGIEMANAGEMENT_TITEL,
  KALENDER_ABZUG,
  KALENDER_ABZUG_FEHLER,
  KALENDER_ABZUG_HINWEIS,
  type EnergiemanagementBausteinBild,
} from '../wiedervorlage';
import './UebersichtBausteine.css';

/**
 * UEMS AP-19 IP-21 (WV5, E10 = A): der Übersichts-Baustein „Energiemanagement“ am Unternehmen — „n fällig · m in den
 * nächsten 30 Tagen“ aus der Wiedervorlage und der Kalender-Abzug zum Laden. Keine Nachricht, kein Läufer: die Fristen
 * leitet der Server beim Abruf ab. Alle Sätze kommen aus `wiedervorlage.ts`; hier wird nur gerendert. Grenz-Satz und
 * Verantwortungs-Satz unten (SP4).
 */
export function EnergiemanagementBaustein({
  bild,
  onOeffnen,
  onKalender,
  kalenderLaeuft = false,
  kalenderFehler = false,
}: {
  bild: EnergiemanagementBausteinBild;
  onOeffnen: () => void;
  onKalender: () => void;
  kalenderLaeuft?: boolean;
  kalenderFehler?: boolean;
}) {
  return (
    <section className="vp-ub-baustein" aria-labelledby="vp-ub-energiemanagement" data-testid="baustein-energiemanagement">
      <div className="vp-ub-kopf">
        <h2 id="vp-ub-energiemanagement" className="vp-ub-titel">
          {ENERGIEMANAGEMENT_TITEL}
        </h2>
        <button type="button" className="vp-ub-alle" onClick={onOeffnen}>
          {ENERGIEMANAGEMENT_OEFFNEN}
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <p className={`vp-ub-summe${bild.faellig ? ' is-warn' : ''}`} data-testid="energiemanagement-summe">
        {bild.summe}
      </p>
      <button
        type="button"
        className="vp-ub-alle vp-ub-kalender"
        onClick={onKalender}
        disabled={kalenderLaeuft}
        data-testid="energiemanagement-kalender"
      >
        <Icon name="calendar" size={16} />
        {KALENDER_ABZUG}
      </button>
      {kalenderFehler && (
        <p className="vp-ub-hinweis is-warn" role="alert" data-testid="energiemanagement-kalender-fehler">
          {KALENDER_ABZUG_FEHLER}
        </p>
      )}
      <p className="vp-ub-hinweis">{KALENDER_ABZUG_HINWEIS}</p>
      <p className="vp-ub-hinweis">{UEMS_VERANTWORTUNG}</p>
      <p className="vp-ub-hinweis">{UEMS_NORMGRENZE}</p>
    </section>
  );
}
