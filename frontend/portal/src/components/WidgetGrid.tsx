import type { WidgetDef } from '../cockpitWidgets';
import { kachelDef, kachelGroesse, type KachelGroesse } from '../cockpitLayout';
import './CockpitBlocks.css';

/**
 * Portal v3 · M2 — das **Widget-Raster** des Live-Cockpits.
 *
 * Render-only: jede Ableitung liegt im reinen, unit-getesteten
 * `src/cockpitWidgets.ts`. Eine Kachel ist kompakt (Label · große Zahl · ruhige
 * Unterzeile). **Eine Kachel ist ein Absprung** (Live-Daten-Redesign V2): ein
 * Tipp navigiert direkt zum `target` der Kachel — ihre Seite; es gibt kein
 * Modal mehr. Der Akzent kommt aus den `--vp-flow-*`-Kanalfarben, damit Kachel
 * und Energiefluss dieselbe Sprache sprechen. Es gibt **keine
 * Platzhalter-Kacheln**: was keine Quelle hat, kommt gar nicht erst hier an.
 *
 * **Größen** (Konzept „Cockpit als Tagesfilm“): jede Kachel ist `klein` (eine
 * Spalte) oder `breit` (zwei), gewählt im Anpassen-Modus und gespeichert im
 * Layout-Dokument (`groessen`). Welche Größen eine Kachel tragen kann, sagt der
 * Katalog (`kacheln`).
 */
export function WidgetGrid({
  widgets,
  onSelect,
  groessen = null,
  onGroesse = null,
}: {
  widgets: WidgetDef[];
  onSelect: (widget: WidgetDef) => void;
  /** Die aufgelösten Größen; ohne Angabe gilt je Kachel ihr Standard. */
  groessen?: Record<string, KachelGroesse> | null;
  /** Nur im Anpassen-Modus: setzt die Größe einer Kachel. */
  onGroesse?: ((id: string, groesse: KachelGroesse) => void) | null;
}) {
  if (widgets.length === 0) return null;
  return (
    /* V8 (Audit, a11y): die Kacheln SIND Knöpfe. `role="listitem"` auf einem
       <button> überschreibt dessen implizite Rolle - Screenreader kündigten sie
       als Listenelement an und ließen sie aus der Bedienelement-Liste fallen.
       Also: keine Rollen-Überschreibung, stattdessen eine benannte Gruppe. */
    /* `data-count`: das Raster füllt seine Reihe (zwei Kacheln stehen halb-
       halb statt als zwei Drittel mit leerer dritter Spalte, vier als 2 × 2
       statt 3 + 1) - `CockpitBlocks.css`. */
    <div
      className="vp-widgets"
      role="group"
      aria-label="Kennzahlen Ihrer Anlage"
      data-count={widgets.length}
    >
      {widgets.map((w) => {
        const groesse = kachelGroesse(w.id, groessen);
        const def = kachelDef(w.id);
        const kachel = (
          <button
            type="button"
            className={`vp-widget vp-widget-${w.accent}${w.lead ? ' is-lead' : ''}`}
            onClick={() => onSelect(w)}
            aria-label={`${w.label} öffnen`}
          >
            <span className="vp-widget-label">{w.label}</span>
            <span className="vp-widget-value">{w.value}</span>
            {w.sub && <span className="vp-widget-sub">{w.sub}</span>}
          </button>
        );
        if (!onGroesse) {
          return (
            <div key={w.id} className={`vp-widget-platz is-${groesse}`}>
              {kachel}
            </div>
          );
        }
        return (
          <div key={w.id} className={`vp-widget-platz is-${groesse} is-anpassen`}>
            {kachel}
            {def && def.groessen.length > 1 ? (
              <div className="vp-seg vp-seg-compact vp-widget-groesse" role="group" aria-label={`Größe von ${w.label}`}>
                {def.groessen.map((g) => (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={groesse === g}
                    className={groesse === g ? 'active' : ''}
                    onClick={() => onGroesse(w.id, g)}
                  >
                    {g === 'klein' ? 'klein' : 'breit'}
                  </button>
                ))}
              </div>
            ) : (
              <p className="vp-widget-groesse-fest">immer {groesse}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
