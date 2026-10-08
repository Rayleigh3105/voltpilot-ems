import type { ReactNode } from 'react';
import { Button } from '../../../designsystem/components/core/Button';
import type { FristBild } from '../../wiedervorlage';
import { FristDatum } from '../FristDatum';
import './Nachweisen.css';

export const ALS_NAECHSTES = 'Als Nächstes';
export const KANN_NOCH_NICHT_BEGINNEN = 'Kann noch nicht beginnen';

/**
 * „Als Nächstes“ (Konzept n1, Runde 2, `.naechst.r2`): genau ein nächster Schritt mit Datumsblock, Titel mit Verb und
 * einem Knopf. Die Variante „Kann noch nicht beginnen“ (`kannNochNicht`) ist gestrichelt, ohne Knopf, mit dem Tag, ab
 * dem es geht („ab Januar 2030“) - so steht das Warum ohne Satz da.
 */
export function AlsNaechstes({
  frist,
  titel,
  warum,
  knopf,
  kannNochNicht = false,
  testId,
}: {
  /** Der Datumsblock; ohne Frist steht nur der Titel. */
  frist?: (Pick<FristBild, 'wort' | 'tag' | 'jahr' | 'satz'> & { ton: 'ueber' | 'bald' | 'erledigt' | 'plan' }) | null;
  titel: ReactNode;
  /** Höchstens ein Fakt: wer, ab wann. */
  warum?: ReactNode;
  knopf?: { label: string; onClick: () => void } | null;
  kannNochNicht?: boolean;
  testId?: string;
}) {
  return (
    <section
      className={kannNochNicht ? 'vp-nw-naechst is-kann-nicht' : 'vp-nw-naechst'}
      aria-label={kannNochNicht ? KANN_NOCH_NICHT_BEGINNEN : ALS_NAECHSTES}
      data-testid={testId}
    >
      <span className="vp-nw-naechst-nl" aria-hidden="true">
        {kannNochNicht ? KANN_NOCH_NICHT_BEGINNEN : ALS_NAECHSTES}
      </span>
      {frist && <FristDatum {...frist} />}
      <span className="vp-nw-naechst-nt">
        <b>{titel}</b>
        {warum && <span className="vp-nw-naechst-why">{warum}</span>}
        {knopf && !kannNochNicht && (
          <Button size="sm" onClick={knopf.onClick}>
            {knopf.label}
          </Button>
        )}
      </span>
    </section>
  );
}
