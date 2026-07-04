import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';

/**
 * Self-explaining chart chrome (captain's pain: "it takes me a while to
 * understand what the diagrams want from me"). Every portal chart pairs its
 * canvas with three plain-German pieces so a customer grasps it at a glance:
 *
 *  - ChartSubtitle  - one line under the title: "Was zeigt das?"
 *  - ChartLegend    - colour swatch + label + unit for each series (no field
 *                     names, no jargon); optionally a toggle (aria-pressed).
 *  - ChartInsight   - the takeaway in one sentence ("the story of the chart").
 *
 * The swatch colours are passed in from chartTheme() so the HTML legend matches
 * the canvas exactly. Keep these dumb + presentational; charts own the data.
 */

/** How a series is drawn on the canvas, mirrored by the legend swatch. */
export type SwatchShape = 'bar' | 'line' | 'dashed' | 'dotted' | 'area';

export interface LegendItem {
  /** Resolved hex (from chartTheme) so the swatch matches the canvas. */
  color: string;
  /** Plain-German series name. */
  label: string;
  /** Unit shown muted after the label (kW, kWh, %, ct/kWh, …). */
  unit?: string;
  /** Drawn shape - defaults to a bar swatch. */
  shape?: SwatchShape;
}

function Swatch({ color, shape = 'bar' }: { color: string; shape?: SwatchShape }) {
  return (
    <span
      className={`vp-swatch vp-swatch-${shape}`}
      style={{ '--sw': color } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

/** One-line "what does this chart show?" caption under a chart title. */
export function ChartSubtitle({ children }: { children: ReactNode }) {
  return <p className="vp-chart-sub">{children}</p>;
}

/**
 * A rich HTML legend below the section head: swatch + plain-German label +
 * unit for every series. When `onToggle` is given the rows become toggle
 * buttons (click to hide/show that series); hidden rows dim and strike through.
 */
export function ChartLegend({
  items,
  hidden,
  onToggle,
}: {
  items: LegendItem[];
  hidden?: Set<string>;
  onToggle?: (label: string) => void;
}) {
  return (
    <div className="vp-chart-legend" role={onToggle ? 'group' : undefined} aria-label="Legende">
      {items.map((it) => {
        const off = hidden?.has(it.label) ?? false;
        const body = (
          <>
            <Swatch color={it.color} shape={it.shape} />
            <span className="vp-cl-label">{it.label}</span>
            {it.unit && <span className="vp-cl-unit">{it.unit}</span>}
          </>
        );
        if (onToggle) {
          return (
            <button
              key={it.label}
              type="button"
              className={`vp-cl-item is-toggle${off ? ' is-off' : ''}`}
              aria-pressed={!off}
              onClick={() => onToggle(it.label)}
              title={off ? `„${it.label}“ einblenden` : `„${it.label}“ ausblenden`}
            >
              {body}
            </button>
          );
        }
        return (
          <span key={it.label} className="vp-cl-item">
            {body}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The chart's takeaway in one plain sentence ("die Aussage"). A calm accent
 * callout with a leading icon - the thing the customer should walk away with.
 */
export function ChartInsight({
  children,
  icon = 'zap',
}: {
  children: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="vp-insight" role="note">
      <span className="vp-insight-ico" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="vp-insight-txt">{children}</span>
    </div>
  );
}
