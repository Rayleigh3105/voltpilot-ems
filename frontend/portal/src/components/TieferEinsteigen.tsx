import { Icon } from '../../designsystem/components/core/Icon';
import type { EbenenLeistenKachel } from '../ebenenNav';
import type { Route } from '../nav';
import './TieferEinsteigen.css';

/**
 * §5.1 „Tiefer einsteigen": der Weg von der Übersicht in die Arbeitsbereiche des
 * Unternehmens (Messen · Auswerten · Verbessern · Nachweisen). Er erfindet keine
 * eigene Liste, sondern zeigt die GRUPPEN der Navigation
 * ({@link unternehmensGruppen}) als Karten — nur die, die wirklich eine Seite
 * haben, und ohne die „Übersicht" selbst, auf der man schon steht. Unter drei
 * messenden Standorten gibt es keine Gruppen; dann steht hier nichts.
 */
export function TieferEinsteigen({
  gruppen,
  onNavigate,
}: {
  gruppen: readonly EbenenLeistenKachel[];
  onNavigate: (route: Route) => void;
}) {
  const ziele = gruppen.filter((g) => g.key !== 'uebersicht');
  if (ziele.length === 0) return null;
  return (
    <section className="vp-tiefer" aria-label="Tiefer einsteigen">
      <h2 className="vp-tiefer-titel">Tiefer einsteigen</h2>
      <div className="vp-tiefer-raster">
        {ziele.map((g) => (
          <button
            key={g.key}
            type="button"
            className="vp-tiefer-karte"
            onClick={() => onNavigate(g.ziel)}
          >
            <span className="vp-tiefer-icon" aria-hidden="true">
              <Icon name={g.icon} size={20} />
            </span>
            <span className="vp-tiefer-wort">
              <span className="vp-tiefer-label">{g.label}</span>
              {g.frage && <span className="vp-tiefer-frage">{g.frage}</span>}
            </span>
            <span className="vp-tiefer-pfeil" aria-hidden="true">
              <Icon name="chevron-right" size={18} />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
