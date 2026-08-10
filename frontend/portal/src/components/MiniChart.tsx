import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  MINI_HEIGHT,
  SHARE_HEIGHT,
  miniBars,
  miniLine,
  type MiniBarsView,
  type MiniHeight,
  type MiniPoint,
  type ShareSize,
} from '../miniChart';
import './MiniChart.css';

/**
 * Das Mini-Chart-System (Chart-Redesign Stufe 5) — die RENDER-Hälfte.
 *
 * Die Geometrie und jede Ehrlichkeitsregel stehen in `src/miniChart.ts`; hier
 * wird nur gezeichnet. Drei Bausteine für die 16 Mini-Flächen, die vorher
 * jede ihre eigene Optik hatten:
 *
 *  - {@link MiniBarSpark}  — Balken-Spark mit ECHTER Nulllinie (Flotten-Geld,
 *    Monats-Chip, Cockpit-Ministreifen).
 *  - {@link MiniLineSpark} — Linien-Spark (Portfolio-Trend).
 *  - {@link MiniShareBar}  — Anteils-/Fortschrittsbalken in drei Höhen.
 *
 * Zwei Dinge macht die Render-Schicht selbst, weil sie ohne DOM nicht geht:
 *
 * **K6 · benannte Marken statt stummer Farbe.** Ein 18-px-Balken kann seine
 * Zahl nicht zeigen; die Mockups (`sparks.svg`) beantworten das nicht mit
 * einem Tooltip, sondern damit, dass die zwei bemerkenswerten Punkte ihren
 * NAMEN im Bild tragen („heute", „Verlusttag −0,40 €"). Höchstens drei, sonst
 * ist es Rauschen.
 *
 * **Ableseweg statt `title`.** Der bisherige `title`-Tooltip ist auf einem
 * Telefon nicht erreichbar — es gibt kein Hover. Hier ist jede Säule ein
 * echtes Ziel (volle Höhe, auch über einem 2-px-Strich): antippen oder mit
 * den Pfeiltasten wandern setzt die Ablese-Zeile unter dem Bild, die als
 * `aria-live` auch vorgelesen wird. Das ist zugleich K7 („Ablesen in
 * Sätzen"): die Zeile ist ein Satz, keine Zahlenkolonne.
 */

/* ---------------------------------------------------------------------------
 * Marken (K6)
 * ------------------------------------------------------------------------- */

/** Eine benannte Marke an EINEM Punkt der Reihe. Höchstens drei je Fläche. */
export interface MiniMark {
  /** Der Punkt, an dem sie hängt. */
  key: string;
  /** Der Text — Klartext, nie eine Kodierung, die erklärt werden muss (K10). */
  label: string;
  /** Über oder unter dem Bild (Vorgabe: über). */
  place?: 'above' | 'below';
  /** `warn` = der Ausreisser, der auffallen MUSS (Verlusttag). */
  tone?: 'calm' | 'warn';
}

/** Höchstens drei Marken — mehr ist Rauschen (K6). */
export const MAX_MARKS = 3;

/* ---------------------------------------------------------------------------
 * Balken-Spark
 * ------------------------------------------------------------------------- */

export interface MiniBarSparkProps {
  points: readonly MiniPoint[];
  /** Der betonte Punkt („heute", der gewählte Monat) — volle Deckkraft. */
  emphasisKey?: string | null;
  /** Ab hier ist Zukunft; alles davor wird gedimmt („schon vorbei"). */
  nowKey?: string | null;
  /** Eine der drei erlaubten Höhen. */
  size?: MiniHeight;
  /**
   * `gradient` für den Flotten-Held: er liegt auf dem Marken-Verlauf, dort
   * sind Weiss-Töne die richtige Farbe.
   */
  tone?: 'brand' | 'gradient';
  /**
   * Der Ablese-Satz eines Punktes. Ist er gesetzt, wird die Fläche bedienbar
   * (Tippen, Pfeiltasten) — sonst ist sie ein reines Bild.
   */
  readout?: (p: MiniPoint) => string;
  /** Was unter dem Bild steht, solange nichts angetippt ist. */
  caption?: ReactNode;
  /** Die Gesamt-Aussage für Screenreader — Pflicht (das Bild ist sonst stumm). */
  ariaLabel: string;
  marks?: readonly MiniMark[];
  className?: string;
}

export function MiniBarSpark({
  points,
  emphasisKey = null,
  nowKey = null,
  size = 'spark',
  tone = 'brand',
  readout,
  caption,
  ariaLabel,
  marks = [],
  className,
}: MiniBarSparkProps) {
  const height = MINI_HEIGHT[size];
  const view = miniBars(points, { height, emphasisKey, nowKey });
  const [active, setActive] = useState<number | null>(null);
  const liveId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  // Ohne einen einzigen Wert gibt es nichts zu zeichnen. Eine leere Fläche mit
  // erfundener Skala wäre die schlechtere Antwort - die Fläche schweigt.
  if (!view) return null;

  const interactive = typeof readout === 'function';
  const activePoint = active != null ? points[active] : null;
  const line = activePoint && readout ? readout(activePoint) : null;

  const move = (delta: number) => {
    const next = Math.min(Math.max((active ?? 0) + delta, 0), points.length - 1);
    setActive(next);
  };

  return (
    <div className={cls('vp-mini-wrap', className)}>
      <MarkBand marks={marks} points={points} place="above" />
      <div
        ref={boxRef}
        className={cls(
          'vp-mini vp-mini-bars',
          tone === 'gradient' && 'vp-mini-on-gradient',
          view.hasNegative && 'has-neg',
        )}
        style={{ height }}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={line ? liveId : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'ArrowRight') move(1);
                else if (e.key === 'ArrowLeft') move(-1);
                else if (e.key === 'Home') setActive(0);
                else if (e.key === 'End') setActive(points.length - 1);
                else if (e.key === 'Escape') setActive(null);
                else return;
                e.preventDefault();
              }
            : undefined
        }
        onBlur={interactive ? () => setActive(null) : undefined}
        onMouseLeave={interactive ? () => setActive(null) : undefined}
      >
        {/* Die Nulllinie wird nur GEZEICHNET, wenn sie etwas trennt - auf einer
            reinen Plus-Reihe ist sie der Boden und damit stumme Dekoration. */}
        {view.hasNegative && (
          <span className="vp-mini-zero" style={{ top: view.zeroY }} aria-hidden="true" />
        )}
        {view.bars.map((b, i) => (
          <span
            key={b.key}
            className={cls('vp-mini-col', active === i && 'is-active')}
            data-testid="mini-col"
            onMouseEnter={interactive ? () => setActive(i) : undefined}
            onPointerDown={interactive ? () => setActive(i) : undefined}
          >
            {b.form !== 'gap' && (
              <i
                className={cls(
                  'vp-mini-bar',
                  `is-${b.form}`,
                  b.sign < 0 ? 'is-neg' : 'is-pos',
                  b.emphasis && 'is-on',
                  b.past && 'is-past',
                )}
                style={{ top: b.y, height: b.h }}
                data-form={b.form}
              />
            )}
          </span>
        ))}
      </div>
      <MarkBand marks={marks} points={points} place="below" />
      {(caption || interactive) && (
        <p className="vp-mini-cap" id={liveId} aria-live="polite">
          {line ?? caption}
        </p>
      )}
    </div>
  );
}

/**
 * Die Marken-Bänder über und unter dem Bild. Eine Marke sitzt über der MITTE
 * ihrer Säule und wird an den Rändern hereingezogen, damit sie die Fläche
 * nicht verlässt (der Baufehler, den die Revision-1-Mockups vorführten).
 */
function MarkBand({
  marks,
  points,
  place,
}: {
  marks: readonly MiniMark[];
  points: readonly MiniPoint[];
  place: 'above' | 'below';
}) {
  const mine = marks
    .filter((m) => (m.place ?? 'above') === place)
    .slice(0, MAX_MARKS)
    .map((m) => ({ mark: m, index: points.findIndex((p) => p.key === m.key) }))
    .filter((x) => x.index >= 0);
  if (mine.length === 0) return null;
  return (
    <div className={`vp-mini-marks is-${place}`} aria-hidden="true">
      {mine.map(({ mark, index }) => {
        const pct = ((index + 0.5) / points.length) * 100;
        return (
          <span
            key={mark.key}
            className={cls('vp-mini-mark', mark.tone === 'warn' && 'is-warn')}
            style={{ left: `${pct}%` }}
          >
            {mark.label}
          </span>
        );
      })}
    </div>
  );
}

/**
 * EIN Balken eines GETEILTEN Balkensatzes, gerendert an einer anderen Stelle.
 *
 * Der Monats-Streifen ist eine Reihe eigenständiger Knöpfe, kann also keinen
 * zusammenhängenden Spark enthalten — die Balken müssen trotzdem EINE Skala
 * teilen, sonst wäre der Vergleich zwischen den Monaten wertlos. Der Aufrufer
 * rechnet deshalb EINEN {@link miniBars}-Satz über alle Punkte und rendert je
 * Zelle den Balken mit seinem Index; Form, Farbe und Nulllinie kommen von hier,
 * damit die Optik nicht neben dem Baustein herläuft.
 */
export function MiniBarCell({
  view,
  index,
  className,
}: {
  view: MiniBarsView;
  index: number;
  className?: string;
}) {
  const bar = view.bars[index];
  if (!bar) return null;
  return (
    <span className={cls('vp-mini-cell', className)} aria-hidden="true">
      {view.hasNegative && (
        <span className="vp-mini-zero" style={{ top: view.zeroY }} />
      )}
      {bar.form !== 'gap' && (
        <i
          className={cls(
            'vp-mini-bar',
            `is-${bar.form}`,
            bar.sign < 0 ? 'is-neg' : 'is-pos',
            bar.emphasis && 'is-on',
          )}
          style={{ top: bar.y, height: bar.h }}
          data-form={bar.form}
        />
      )}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Linien-Spark
 * ------------------------------------------------------------------------- */

export function MiniLineSpark({
  points,
  width = 80,
  size = 'spark',
  ariaLabel,
  className,
  style,
}: {
  points: readonly MiniPoint[];
  width?: number;
  size?: MiniHeight;
  ariaLabel: string;
  className?: string;
  /** Für `--mini-line`, wenn eine Fläche ihre eigene Linienfarbe führt. */
  style?: CSSProperties;
}) {
  const height = MINI_HEIGHT[size];
  const view = miniLine(points, { width, height });
  if (!view) return null;
  return (
    <svg
      className={cls('vp-mini-line', className)}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={ariaLabel}
      style={style}
    >
      {/* Dieselbe Regel wie beim Balken: die Nulllinie erscheint, wenn sie
          etwas trennt. */}
      {view.hasNegative && (
        <line
          className="vp-mini-line-zero"
          x1={0}
          x2={width}
          y1={view.zeroY}
          y2={view.zeroY}
        />
      )}
      {view.segments.map((seg, i) => (
        <polyline key={i} className="vp-mini-line-path" points={seg} fill="none" />
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Anteils-/Fortschrittsbalken
 * ------------------------------------------------------------------------- */

export interface ShareSegment {
  key: string;
  /** Das GEWICHT des Segments (Anteil, Anzahl — beliebige Einheit). */
  weight: number;
  /** Die Farbe. Ein Token oder ein aus `chartTheme()` aufgelöster Wert. */
  color?: string;
  /** Eine Klasse statt einer Farbe (die Admin-Zustands-Paletten). */
  className?: string;
  /** Klartext für den `title` — was dieses Segment IST. */
  title?: string;
}

/**
 * Der EINE Anteils-/Fortschrittsbalken. Vorher vier unabhängige Stile
 * (10 / 18 / 8 / 5 px) plus zwei fast identische Kompositions-Balken
 * (7 px r4 gegen 6 px r3 α 0,75) für dieselbe Idee.
 *
 * `fraction` ist der Fortschritts-Fall (ein Wert 0..1), `segments` der
 * Anteils-Fall (n Teile eines Ganzen). Beide teilen Bahn, Radius und Höhe.
 */
export function MiniShareBar({
  fraction,
  segments,
  size = 'md',
  color,
  ariaLabel,
  className,
}: {
  fraction?: number;
  segments?: readonly ShareSegment[];
  size?: ShareSize;
  color?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const height = SHARE_HEIGHT[size];
  const parts = segments ?? [];
  return (
    <span
      className={cls('vp-share', `is-${size}`, className)}
      style={{ height }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {segments
        ? parts.map((s) => (
            <i
              key={s.key}
              className={cls('vp-share-seg', s.className)}
              style={{ flexGrow: Math.max(s.weight, 0), background: s.color }}
              title={s.title}
            />
          ))
        : fraction != null && (
            <i
              className="vp-share-fill"
              style={{ width: `${clampPct(fraction)}%`, background: color }}
            />
          )}
    </span>
  );
}

function clampPct(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(100, Math.max(0, fraction * 100));
}

function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type { MiniBarsView, MiniPoint };
