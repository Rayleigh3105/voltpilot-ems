import { Icon } from '../../designsystem/components/core/Icon';
import type { WidgetDef } from '../cockpitWidgets';
import './CockpitBlocks.css';

/**
 * Portal v3 · M2 — das **Widget-Raster** des Live-Cockpits.
 *
 * Render-only: jede Ableitung liegt im reinen, unit-getesteten
 * `src/cockpitWidgets.ts`. Eine Kachel ist kompakt (Label · große Zahl · ruhige
 * Unterzeile). **Eine Kachel ist ein Absprung** (Live-Daten-Redesign V2): ein
 * Tipp navigiert direkt zum `target` der Kachel — Fluss-Kacheln in den Verlauf-
 * Explorer, Geld-/Modus-Kacheln auf ihre Seite; es gibt kein Modal mehr. Bei
 * Hover/Fokus zeigen die Fluss-Kacheln eine „Verlauf →"-Andeutung. Der Akzent
 * kommt aus den `--vp-flow-*`-Kanalfarben, damit Kachel und Energiefluss
 * dieselbe Sprache sprechen. Es gibt **keine Platzhalter-Kacheln**: was keine
 * Quelle hat, kommt gar nicht erst hier an.
 */
export function WidgetGrid({
  widgets,
  onSelect,
}: {
  widgets: WidgetDef[];
  onSelect: (widget: WidgetDef) => void;
}) {
  if (widgets.length === 0) return null;
  return (
    <div className="vp-widgets" role="list">
      {widgets.map((w) => (
        <button
          key={w.id}
          type="button"
          role="listitem"
          className={`vp-widget vp-widget-${w.accent}${w.lead ? ' is-lead' : ''}`}
          onClick={() => onSelect(w)}
          aria-label={`${w.label} öffnen`}
        >
          <span className="vp-widget-label">{w.label}</span>
          <span className="vp-widget-value">{w.value}</span>
          {w.sub && <span className="vp-widget-sub">{w.sub}</span>}
          {w.target.kind === 'verlauf' && (
            <span className="vp-widget-jump" aria-hidden="true">
              Verlauf
              <Icon name="trending-up" size={12} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
