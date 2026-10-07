import type { CSSProperties } from 'react';
import { folgenLegende, folgenSatz, type ZustandArt } from './nwBild';
import './NwZeilen.css';

/**
 * Der Folgen-Balken einer Managementbewertung (Konzept n1 Runde 2, `.segbar`/`.seglg`): ein Segment je Beschluss in der
 * Reihenfolge der Beschlüsse, darunter die Legende in Zahl und Wort („3 erledigt · 2 laufen · 1 ohne Folge“). Er ersetzt
 * den Satz „drei sind erledigt, zwei laufen noch …“; er urteilt nicht über das Ganze (G4) - er zählt nur Zustände.
 * Nur `span`, damit er auch in einer Zeile stehen kann, die ein Knopf oder Link ist (Karte im Reiter).
 */
export function FolgenBalken({ zustaende, testId }: { zustaende: ZustandArt[]; testId?: string }) {
  if (!zustaende.length) return null;
  return (
    <span className="vp-nw-folgen" data-testid={testId}>
      <span className="vp-nw-segbar" style={{ '--n': zustaende.length } as CSSProperties} role="img" aria-label={`Folgen der Beschlüsse: ${folgenSatz(zustaende)}`}>
        {zustaende.map((z, i) => (
          <i key={i} className={`is-${z}`} />
        ))}
      </span>
      <span className="vp-nw-seglg" aria-hidden="true">
        {folgenLegende(zustaende).map((t) => (
          <span key={t.art}>
            <i className={`is-${t.art}`} />
            <b>{t.zahl}</b>
            {t.wort}
          </span>
        ))}
      </span>
    </span>
  );
}
