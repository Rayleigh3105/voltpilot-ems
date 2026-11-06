import type { VerlaufZeile } from '../../geraeteUpdates';
import { SatzText } from './GeraeteUpdates';

/**
 * Ein Verlauf als Zeitleiste - geteilt von der Geräteakte (Reiter Software
 * und Verlauf, Scheibe S2) und der Release-Seite. Die frühere Box-Seite
 * (ein Modal mit denselben Fakten) ist mit S2 aufgelöst - ihre Inhalte leben
 * jetzt inline in der Akte (`GeraeteAktePage.tsx`).
 */
export function Zeitleiste({ zeilen, testId }: { zeilen: VerlaufZeile[]; testId?: string }) {
  return (
    <ol className="vp-gu-verlauf" data-testid={testId}>
      {zeilen.map((z, i) => (
        <li key={i} className="vp-gu-ereignis">
          <span className="wann">{z.wann}</span>
          <span className="linie" aria-hidden="true"><i className={z.ton} /></span>
          <span className="was">
            <b><SatzText satz={z.titel} /></b>
            {z.text && <small>{z.text}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}
