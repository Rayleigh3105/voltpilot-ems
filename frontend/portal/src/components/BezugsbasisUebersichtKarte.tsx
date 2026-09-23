import { Icon } from '../../designsystem/components/core/Icon';
import {
  BEZUGSBASIS_BAUSTEIN_OEFFNEN,
  BEZUGSBASIS_BAUSTEIN_TITEL,
  type BezugsbasisUebersichtBild,
} from '../bezugsbasisUebersicht';
import { UEMS_NORMGRENZE } from '../glossar';
import './UebersichtBausteine.css';

/**
 * UEMS AP-17 IP-17 (R13, §5.5): der Übersichts-Baustein „Bezugsbasen“ am Unternehmen — freigegeben · vorläufig ·
 * Anstoß liegt vor · Überprüfung fällig, darunter je fälliger Basis der Frist-Satz aus §5.8 mit Sprung zur Kennzahl.
 * Keine Nachricht, kein Läufer: die Frist leitet der Server beim Abruf ab. Alle Sätze kommen aus
 * `bezugsbasisUebersicht.ts`; hier wird nur gerendert. Der Grenz-Satz steht unten (SP3).
 */
export function BezugsbasisUebersichtKarte({
  bild,
  onOeffnen,
  onKennzahl,
}: {
  bild: BezugsbasisUebersichtBild;
  onOeffnen: () => void;
  onKennzahl: (kennzahlId: string) => void;
}) {
  return (
    <section className="vp-ub-baustein" aria-labelledby="vp-ub-bezugsbasen" data-testid="baustein-bezugsbasen">
      <div className="vp-ub-kopf">
        <h2 id="vp-ub-bezugsbasen" className="vp-ub-titel">
          {BEZUGSBASIS_BAUSTEIN_TITEL}
        </h2>
        <button type="button" className="vp-ub-alle" onClick={onOeffnen}>
          {BEZUGSBASIS_BAUSTEIN_OEFFNEN}
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      <p className={`vp-ub-summe${bild.faellig ? ' is-warn' : ''}`} data-testid="bezugsbasen-summe">
        {bild.summe}
      </p>
      <p className="vp-ub-unter" data-testid="bezugsbasen-zahlen">
        {bild.zahlen}
      </p>
      {bild.zeilen.length > 0 && (
        <ul className="vp-ub-zeilen" data-testid="bezugsbasen-faellig">
          {bild.zeilen.map((z) => (
            <li key={z.key}>
              <button type="button" className="vp-ub-zeile is-warn" onClick={() => onKennzahl(z.kennzahlId)} data-testid={`bezugsbasis-${z.key}`}>
                <span className="vp-ub-punkt" aria-hidden="true" />
                <span className="vp-ub-text">
                  <span className="vp-ub-satz">{z.satz}</span>
                </span>
                <Icon name="chevron-right" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="vp-ub-hinweis">{UEMS_NORMGRENZE}</p>
    </section>
  );
}
