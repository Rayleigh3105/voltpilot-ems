import { Icon } from '../../../designsystem/components/core/Icon';
import type { AnlagenBalken } from '../../portfolioSeite';
import './PortfolioSeite.css';

/**
 * **Der Anlagen-Vergleich** der Portfolio-Seiten: je Anlage eine Zeile mit
 * Name, Hauptwert und Balken (relativ zur größten Anlage), darunter eine
 * kurze zweite Zeile. Die ganze Zeile ist ein Link in DIESELBE Seite DIESER
 * Anlage im gleichen Zeitraum — am Telefon ein großes Tippziel.
 */
export function AnlagenListe({
  zeilen,
  farbe,
  hrefFor,
  label,
}: {
  zeilen: readonly AnlagenBalken[];
  /** Die Rollenfarbe des Balkens (dieselbe wie im Diagramm der Anlage). */
  farbe: string;
  hrefFor: (id: string) => string;
  label: string;
}) {
  return (
    <ul className="vp-vr-anl" aria-label={label}>
      {zeilen.map((z) => (
        <li key={z.id}>
          <a className="vp-vr-anl-zeile" href={hrefFor(z.id)}>
            <span className="vp-vr-anl-kopf">
              <span className="vp-vr-anl-name">{z.name}</span>
              <span className={`vp-vr-anl-wert${z.ton ? ` ${z.ton}` : ''}`}>{z.wert}</span>
              <Icon name="chevron-right" size={16} />
            </span>
            {z.anteilPct != null && (
              <span className="vp-vr-anl-spur" aria-hidden="true">
                <i
                  className={z.ton === 'minus' ? 'minus' : undefined}
                  style={{ width: `${Math.max(z.anteilPct, 1.5)}%`, background: farbe }}
                />
              </span>
            )}
            {(z.hinweis || z.unter) && (
              <span className={`vp-vr-anl-unter${z.hinweis ? ' hinweis' : ''}`}>{z.hinweis ?? z.unter}</span>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
