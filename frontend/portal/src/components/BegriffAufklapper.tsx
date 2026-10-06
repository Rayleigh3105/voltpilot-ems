import type { ReactNode } from 'react';
import { Icon } from '../../designsystem/components/core/Icon';
import { BEGRIFFE, type BegriffSchluessel } from '../begriffe';
import './BegriffAufklapper.css';

/**
 * „Was ist eine Messstelle?“ - Stufe 2 des Musters für Fachbegriffe (Konzept Messen m1, §7): ein leiser Verweis mit
 * Info-Zeichen unter dem Kopf; aufgeklappt Klartext, ein Beispiel aus der eigenen Firma und die Abgrenzung. Er bleibt
 * zu, bis jemand tippt, und geht mit einem Tipp wieder zu (natives `details`, Tastatur und Vorleser inklusive) - kein
 * Hinweis-Kasten, kein Ton von „Achtung“. Stufe 1 ist der Satz unter dem Titel, Stufe 3 das Alltagswort im Inhalt.
 *
 * Die Texte stehen in `begriffe.ts`; `beispiel` ersetzt das allgemeine Beispiel durch eines aus den eigenen Daten
 * („Bei Ihnen zum Beispiel Hauptzähler Halle 1 und Zähler Druckluft“), `mehr` ergänzt einen Satz der Fläche.
 */
export function BegriffAufklapper({
  begriff,
  beispiel,
  mehr,
}: {
  begriff: BegriffSchluessel;
  /** Das Beispiel aus der eigenen Firma; ohne: das allgemeine aus `begriffe.ts`. */
  beispiel?: ReactNode;
  /** Ein Satz der Fläche nach dem Beispiel (etwa, warum hier keine Summe steht). */
  mehr?: ReactNode;
}) {
  const b = BEGRIFFE[begriff];
  const frage = b.frage ?? `Was heißt „${b.wort}“?`;
  return (
    <details className="vp-begriff-auf" data-testid={`begriff-auf-${begriff}`}>
      <summary>
        <Icon name="info" size={15} />
        <span className="vp-begriff-auf-frage">{frage}</span>
        <span className="vp-begriff-auf-zu" aria-hidden="true">
          <Icon name="chevron-down" size={18} />
        </span>
      </summary>
      <div className="vp-begriff-auf-text">
        <p>{b.klartext}</p>
        {(beispiel ?? b.beispiel) && <p className="vp-begriff-auf-beispiel">{beispiel ?? b.beispiel}</p>}
        {b.mehr && <p>{b.mehr}</p>}
        {mehr && <p>{mehr}</p>}
        {b.abgrenzung && <p className="vp-begriff-auf-abgrenzung">{b.abgrenzung}</p>}
      </div>
    </details>
  );
}
