import type { EbenenBereichId, EbenenKachel } from '../ebenenNav';
import { useReiterRand } from '../reiterRand';
import type { Route } from '../nav';
import './BereichTabs.css';

/**
 * Die REITER der Standort-Ebene unter einem Unternehmen (UEMS AP-04 IP-5): die Bereiche MIT Seite aus
 * `ebenenNav.ebenenReiter`, ab zwei. Seit dem Konzept „Navigation aus einem Guss“ (N1) tragen Seitenleiste und
 * Telefon-Leiste dieselben Bereiche, sobald es drei sind — was sie tragen, steht hier kein zweites Mal, und dann bleibt
 * keine Reihe. Darunter (ohne Messfunktion: Übersicht · Gebäude) sind diese Reiter der Weg.
 *
 * Ist der Standort die OBERSTE Ebene, gibt es diese Reiter nicht: dort trägt `PortfolioTabs` die übrigen Seiten.
 */
export function EbenenTabs({
  reiter,
  aktiv,
  leiste = [],
  label,
  onOpen,
}: {
  reiter: EbenenKachel[];
  aktiv: EbenenBereichId | null;
  /** Die Bereiche, die Seitenleiste und Telefon-Leiste dieser Ebene tragen (leer = keine Leiste). */
  leiste?: readonly EbenenBereichId[];
  /** Zugänglicher Name („Reiter des Standorts Werk Ahrenberg“). */
  label: string;
  onOpen: (ziel: Route) => void;
}) {
  const reiterRand = useReiterRand<HTMLDivElement>();
  const uebrig = reiter.filter((r) => !leiste.includes(r.key));
  if (uebrig.length < 2) return null;
  return (
    <div ref={reiterRand} className="vp-bereich-tabs" role="tablist" aria-label={label}>
      {uebrig.map((r) => {
        const ist = r.key === aktiv;
        return (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={ist}
            className={`vp-bereich-tab${ist ? ' active' : ''}`}
            onClick={() => onOpen(r.ziel)}
          >
            {r.label}
            {/* Eigener Name wie in `PortfolioTabs`: zwei gleichnamige Übergangs-Elemente brächen den Übergang ab. */}
            {ist && <span className="vp-welt-strich" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
