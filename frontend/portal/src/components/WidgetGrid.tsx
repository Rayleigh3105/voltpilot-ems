import type { WidgetDef } from '../cockpitWidgets';
import './CockpitBlocks.css';

/**
 * Portal v3 · M2 — das **Widget-Raster** des Live-Cockpits.
 *
 * Render-only: jede Ableitung liegt im reinen, unit-getesteten
 * `src/cockpitWidgets.ts`. Eine Kachel ist kompakt (Label · große Zahl · ruhige
 * Unterzeile). **Eine Kachel ist ein Absprung** (Live-Daten-Redesign V2): ein
 * Tipp navigiert direkt zum `target` der Kachel — ihre Seite; es gibt kein
 * Modal mehr. Die vier Fluss-Kacheln sind seit dem Cockpit+Live-Merge (R2)
 * durch das Komponenten-Board ersetzt. Der Akzent kommt aus den
 * `--vp-flow-*`-Kanalfarben, damit Kachel und Energiefluss dieselbe Sprache
 * sprechen. Es gibt **keine Platzhalter-Kacheln**: was keine Quelle hat, kommt
 * gar nicht erst hier an.
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
        </button>
      ))}
    </div>
  );
}
