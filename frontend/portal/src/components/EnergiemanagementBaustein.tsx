import { Icon } from '../../designsystem/components/core/Icon';
import { GrenzSatz } from './GrenzSatz';
import type { Route } from '../nav';
import {
  KALENDER_ABZUG,
  KALENDER_ABZUG_FEHLER,
  KALENDER_ABZUG_HINWEIS,
  WAS_STEHT_AN,
  ZUR_WIEDERVORLAGE,
  type EnergiemanagementBausteinBild,
} from '../wiedervorlage';
import './UebersichtBausteine.css';

/**
 * UEMS AP-19 IP-21 (WV5, E10 = A): der Übersichts-Baustein der Wiedervorlage am Unternehmen — „n fällig · m in den
 * nächsten 30 Tagen“ und der Kalender-Abzug zum Laden. Keine Nachricht, kein Läufer: die Fristen leitet der Server beim
 * Abruf ab. Alle Sätze kommen aus `wiedervorlage.ts`; hier wird nur gerendert. Grenz-Satz und Verantwortungs-Satz unten
 * (SP4).
 *
 * K8 (Konzept „Energiemanagement ohne Fachsprache“): der Titel ist die Frage „Was steht an“, darunter die ersten
 * Punkte der Wiedervorlage mit ihrem Sprung — am Telefon steht der Baustein zuerst.
 */
export function EnergiemanagementBaustein({
  bild,
  onOeffnen,
  onKalender,
  onSprung,
  kalenderLaeuft = false,
  kalenderFehler = false,
}: {
  bild: EnergiemanagementBausteinBild;
  onOeffnen: () => void;
  onKalender: () => void;
  /** Der Sprung einer Zeile (WV3); ohne ihn stehen die Zeilen als Text. */
  onSprung?: (ziel: Route) => void;
  kalenderLaeuft?: boolean;
  kalenderFehler?: boolean;
}) {
  return (
    <section className="vp-ub-baustein" aria-labelledby="vp-ub-energiemanagement" data-testid="baustein-energiemanagement">
      <div className="vp-ub-kopf">
        <h2 id="vp-ub-energiemanagement" className="vp-ub-titel">
          {WAS_STEHT_AN}
        </h2>
        <button type="button" className="vp-ub-alle" onClick={onOeffnen}>
          {ZUR_WIEDERVORLAGE}
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <p className={`vp-ub-summe${bild.faellig ? ' is-warn' : ''}`} data-testid="energiemanagement-summe">
        {bild.summe}
      </p>
      {bild.zeilen.length > 0 && (
        <ul className="vp-ub-zeilen" data-testid="was-steht-an">
          {bild.zeilen.map((z) => {
            const inhalt = (
              <>
                <span className="vp-ub-punkt" aria-hidden="true" />
                <span className="vp-ub-text">
                  <span className="vp-ub-name">{`${z.art} ${z.kennzeichen} · ${z.titel}`}</span>
                  <span className="vp-ub-satz">{z.satz}</span>
                </span>
              </>
            );
            return (
              <li key={z.key}>
                {z.ziel && onSprung ? (
                  <button type="button" className={`vp-ub-zeile${z.faellig ? ' is-warn' : ''}`} onClick={() => onSprung(z.ziel!)} data-testid={`was-steht-an-${z.kennzeichen}`}>
                    {inhalt}
                    <Icon name="chevron-right" size={16} />
                  </button>
                ) : (
                  <div className={`vp-ub-zeile vp-ub-zeile-text${z.faellig ? ' is-warn' : ''}`} data-testid={`was-steht-an-${z.kennzeichen}`}>
                    {inhalt}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
      <GrenzSatz className="vp-ub-hinweis" verantwortung />
    </section>
  );
}
