import type { ReactNode } from 'react';
import { Icon } from '../../../designsystem/components/core/Icon';
import { ErklaerKnopf } from './ErklaerKnopf';
import type { Erklaerung } from './erklaerung';
import './Nachweisen.css';

/**
 * Der Seitenkopf von Nachweisen (Konzept n1, Runde 2, `.pkopf`): Titel mit i-Knopf, darunter höchstens eine Kurzzeile
 * mit vier Wörtern („Stand 30.04.2029“, „Selbstprüfung, jährlich“) und, wo die Seite eine hat, die Status-Zeile. Das
 * Menü „…“ steht rechts. Den Klartext-Satz der Familie (Messen m1 §7) ersetzt hier das Erklär-Blatt (Entscheid 24).
 *
 * Der Titel ist der Name der Fläche oder der Name, den die Person vergeben hat - nie ein Kennzeichen (Entscheid 25).
 */
export function NwKopf({
  titel,
  erklaerung,
  kurzzeile,
  status,
  menue,
  zurueck,
  testId,
}: {
  titel: string;
  /** Der i-Knopf am Titel; ohne Erklärung steht kein Knopf. */
  erklaerung?: Erklaerung;
  /** Höchstens vier Wörter, leise unter dem Titel. */
  kurzzeile?: ReactNode;
  /** Die Status-Zeile einer Seite (Zeichen, zwei bis fünf Wörter). */
  status?: ReactNode;
  /** Das Menü „…“ (RowMenu) rechts im Kopf. */
  menue?: ReactNode;
  /** Der Weg eine Ebene höher („‹ Überblick“) über dem Titel. */
  zurueck?: { label: string; onClick: () => void };
  testId?: string;
}) {
  return (
    <header className="vp-nw-kopf" data-testid={testId}>
      {zurueck && (
        <button type="button" className="vp-nw-zurueck" onClick={zurueck.onClick}>
          <Icon name="chevron-left" size={16} />
          {zurueck.label}
        </button>
      )}
      <div className="vp-nw-kopf-zeile">
        <div className="vp-nw-kopf-text">
          <div className="vp-nw-titel">
            <h1>{titel}</h1>
            {erklaerung && <ErklaerKnopf erklaerung={erklaerung} testId="kopf-erklaeren" />}
          </div>
          {kurzzeile && <p className="vp-nw-kurz">{kurzzeile}</p>}
          {status && <div className="vp-nw-kopf-status">{status}</div>}
        </div>
        {menue && <div className="vp-nw-kopf-menue">{menue}</div>}
      </div>
    </header>
  );
}
