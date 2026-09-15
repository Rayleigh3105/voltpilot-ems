import type { EbenenBereichId, EbenenKachel } from '../ebenenNav';
import type { Route } from '../nav';
import './BereichTabs.css';

/**
 * Die REITER der Standort-Ebene unter einem Unternehmen (UEMS AP-04 IP-5):
 * Übersicht · Messstellen — die Bereiche MIT Seite aus `ebenenNav.ebenenReiter`,
 * ab zwei. Am Rechner sind sie der einzige Weg in „Standort › Messstellen“ (die
 * Ebene hat dort keine Seitenleisten-Bereiche); am Telefon trägt die Leiste,
 * sobald es drei Bereiche sind, dieselben Ziele — was dort Kachel ist, blendet
 * CSS hier aus (`vp-nur-rechner`).
 *
 * Ist der Standort die OBERSTE Ebene, gibt es diese Reiter nicht: dort trägt
 * `PortfolioTabs` den Reiter „Messstellen“.
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
  /** Die Bereiche, die die Telefon-Leiste dieser Ebene gerade trägt (leer = keine Leiste). */
  leiste?: readonly EbenenBereichId[];
  /** Zugänglicher Name („Reiter des Standorts Werk Ahrenberg“). */
  label: string;
  onOpen: (ziel: Route) => void;
}) {
  if (reiter.length < 2) return null;
  const alleInLeiste = reiter.every((r) => leiste.includes(r.key));
  return (
    <div className={`vp-bereich-tabs${alleInLeiste ? ' vp-nur-rechner' : ''}`} role="tablist" aria-label={label}>
      {reiter.map((r) => {
        const ist = r.key === aktiv;
        return (
          <button
            key={r.key}
            type="button"
            role="tab"
            aria-selected={ist}
            className={`vp-bereich-tab${ist ? ' active' : ''}${leiste.includes(r.key) ? ' vp-nur-rechner' : ''}`}
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
