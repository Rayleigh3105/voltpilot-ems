import { BEGRIFFE, BEGRIFFE_LABEL, begriffFrage, fachwortZeile, type BegriffSchluessel } from '../begriffe';
import { InfoTip } from './InfoTip';
import './BegriffeZeile.css';

/**
 * „Begriffe: Kennzahl ⓘ · Bezugsbasis ⓘ“ — unter dem Kopf einer Seite des Energiemanagements (Konzept
 * „Energiemanagement ohne Fachsprache“ K3). Jedes ⓘ erklärt sein Wort in Alltagssprache, mit Beispiel und dem
 * Fachwort, unter dem Berater dasselbe kennen. Die Texte stehen in `begriffe.ts`; hier wird nur gezeigt.
 */
export function BegriffeZeile({ begriffe }: { begriffe: readonly BegriffSchluessel[] }) {
  if (begriffe.length === 0) return null;
  return (
    <p className="vp-begriffe" data-testid="begriffe">
      <span className="vp-begriffe-label">{BEGRIFFE_LABEL}:</span>
      {begriffe.map((schluessel) => {
        const b = BEGRIFFE[schluessel];
        return (
          <span key={schluessel} className="vp-begriff" data-testid={`begriff-${schluessel}`}>
            {b.wort}
            <InfoTip title={b.wort} label={begriffFrage(b.wort)}>
              <span className="vp-begriff-klartext">{b.klartext}</span>
              {b.beispiel && <span className="vp-begriff-beispiel">{b.beispiel}</span>}
              {b.fachwort && <span className="vp-begriff-fachwort">{fachwortZeile(b.fachwort)}</span>}
            </InfoTip>
          </span>
        );
      })}
    </p>
  );
}
