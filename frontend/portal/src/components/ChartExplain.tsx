import { useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '../../designsystem/components/core/Icon';
import { kopfView, type Kernaussage } from '../chartKopf';
import { fokusGriff, zeigerSchwebt } from '../chartMotion';

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

/**
 * How a series is drawn on the canvas, mirrored by the legend swatch.
 * `outline` bleibt für neutrale Vergleichs-/Baseline-Marken verfügbar; die
 * Speicherzustände selbst verwenden gefüllte, getrennte Farben.
 */
export type SwatchShape = 'bar' | 'line' | 'dashed' | 'dotted' | 'area' | 'outline';

export interface LegendItem {
  /** Resolved hex (from chartTheme) so the swatch matches the canvas. */
  color: string;
  /** Plain-German series name. */
  label: string;
  /** Unit shown muted after the label (kW, kWh, %, ct/kWh, …). */
  unit?: string;
  /** Drawn shape - defaults to a bar swatch. */
  shape?: SwatchShape;
  /**
   * Whether THIS row is a toggle when the legend has an `onToggle` (default
   * true, so legends that toggle everything are unchanged). Set `false` for a
   * row that does not map to one switchable series - e.g. the Fahrplan's three
   * bar colours, which are per-slot states of ONE series.
   */
  toggleable?: boolean;
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
 * K1/M11 · Der Kernaussage-Kopf: die Zahl, die zählt, und ihr abgeleiteter
 * Satz — ÜBER dem Diagramm, damit das Bild zum Beleg wird statt zur Aufgabe.
 *
 * ⚠ Der Satz kommt IMMER aus einer Ableitung (`planSentence`, `idleReason`,
 * `proofLine`, `erloesErgebnis`, …), nie aus dieser Datei. Ohne belegbare
 * Aussage rendert der Kopf den ehrlichen GRUND, und ohne Grund gar nichts —
 * ein nacktes „—" erklärt nichts (r2 §10, die Regel mit dem größten Risiko).
 */
export function ChartHeadline({ kern }: { kern: Kernaussage | null | undefined }) {
  const v = kopfView(kern);
  if (v.modus === 'nichts') return null;
  if (v.modus === 'grund') {
    return (
      <p className="vp-chart-kern is-grund" role="note">
        {v.text}
      </p>
    );
  }
  return (
    <>
      <p className={`vp-chart-kern is-${v.ton}`}>
        {v.wert && <strong className="vp-chart-kern-wert">{v.wert}</strong>}
        <span className="vp-chart-kern-satz">{v.text}</span>
        {v.anker && <span className="vp-chart-kern-anker">{v.anker}</span>}
      </p>
      {/* Das BESTANDSKONTO steht NEBEN der Zahl, nie darin: die Zahl ist die
          gemessene Kasse, der Bestand ist nach dem Plan bewertet und sagt das
          selbst (Diagnose vp-tagesbild-minus-f3 §6). */}
      {v.bestand && (
        <p className="vp-chart-kern-bestand" title={v.bestand.titel ?? undefined}>
          <span>{v.bestand.text}</span>
          {v.bestand.badge && (
            <span className="vp-chart-kern-badge">{v.bestand.badge}</span>
          )}
        </p>
      )}
    </>
  );
}

/**
 * K3/M13 · „Mehr anzeigen ▾" — der Umschalter der Detailtiefe.
 *
 * Er nennt, WAS dahinter liegt („Ladestand, Prognosen"), statt nur „mehr":
 * ein Umschalter ohne Inhaltsangabe ist eine Wundertüte. Der Zustand kommt von
 * `useChartDetail` (pro Fläche, pro Tab-Sitzung).
 */
export function ChartDetailToggle({
  open,
  onToggle,
  was,
}: {
  open: boolean;
  onToggle: () => void;
  /** Die Reihen dahinter, als Aufzählung („Ladestand, Prognosen"). */
  was: string;
}) {
  return (
    <button
      type="button"
      className={`vp-chart-more${open ? ' is-open' : ''}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span>{open ? 'Weniger anzeigen' : 'Mehr anzeigen'}</span>
      <span className="vp-chart-more-was">{was}</span>
      <Icon name="chevron-down" size={14} />
    </button>
  );
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
  hidden?: ReadonlySet<string>;
  onToggle?: (label: string) => void;
}) {
  const wurzel = useRef<HTMLDivElement>(null);
  // ## ⚠ FOKUS NUR, WO EIN ZEIGER SCHWEBEN KANN (Bewegung P2)
  //
  // Auf einem Beruehrungs-Bildschirm gibt es kein verlaessliches „Zeiger weg":
  // ein Tipp auf eine Legenden-Zeile liesse die anderen Serien auf einem
  // Viertel stehen. Am Telefon ist die Legende deshalb nur Beschriftung (und
  // ggf. Umschalter), nie ein Fokus — dieselbe Regel, die `chartMotion` den
  // Serien selbst gibt.
  const schwebt = useRef<boolean | null>(null);
  if (schwebt.current === null) schwebt.current = zeigerSchwebt();
  const fokus = (label: string | null) => {
    if (!schwebt.current) return;
    fokusGriff(wurzel.current)?.(label);
  };
  // Die Zeilen sind Geschwister EINES Diagramms: `mouseleave` einer Zeile und
  // `mouseenter` der naechsten folgen unmittelbar aufeinander, das Ergebnis
  // ist trotzdem eindeutig (die letzte Meldung gewinnt).
  const zeigen = (label: string) => ({
    onMouseEnter: () => fokus(label),
    onMouseLeave: () => fokus(null),
    onFocus: () => fokus(label),
    onBlur: () => fokus(null),
  });
  return (
    <div
      className="vp-chart-legend"
      role={onToggle ? 'group' : undefined}
      aria-label="Legende"
      ref={wurzel}
    >
      {items.map((it) => {
        const off = hidden?.has(it.label) ?? false;
        const body = (
          <>
            <Swatch color={it.color} shape={it.shape} />
            <span className="vp-cl-label">{it.label}</span>
            {it.unit && <span className="vp-cl-unit">{it.unit}</span>}
          </>
        );
        if (onToggle && it.toggleable !== false) {
          return (
            <button
              key={it.label}
              type="button"
              className={`vp-cl-item is-toggle${off ? ' is-off' : ''}`}
              aria-pressed={!off}
              onClick={() => onToggle(it.label)}
              title={off ? `„${it.label}“ einblenden` : `„${it.label}“ ausblenden`}
              {...(off ? {} : zeigen(it.label))}
            >
              {body}
            </button>
          );
        }
        return (
          <span key={it.label} className="vp-cl-item" {...zeigen(it.label)}>
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
