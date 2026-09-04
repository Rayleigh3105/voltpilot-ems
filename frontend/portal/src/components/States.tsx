import type { ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import type { IconName } from '../../designsystem/components/core/Icon';
import './VerlaufZustaende.css';

/**
 * Shared loading / empty / error surfaces for the portal (design-system
 * foundation). A premium app never flashes bare "Lade …" text: while data is
 * in flight we render token'd Skeleton blocks shaped like the content that is
 * coming, a stalled/failed request shows a distinct ErrorState with a retry,
 * and "nothing here yet" reuses one polished EmptyState pattern.
 */

/** A single shimmering placeholder block. */
export function Skeleton({
  width = '100%',
  height = 16,
  radius,
  style = {},
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="vp-skeleton"
      aria-hidden="true"
      style={{ width, height, ...(radius != null ? { borderRadius: radius } : {}), ...style }}
    />
  );
}

/** A few stacked text lines (last one shorter), for list/paragraph loads. */
export function TextSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--vp-space-3)' }}
    >
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={14} width={i === lines - 1 ? '55%' : '100%'} />
      ))}
    </div>
  );
}

/**
 * The shape most data pages load into: a row of stat placeholders over a tall
 * chart placeholder. Matches the Stat-row + chart layout so there is no jump
 * when the real content arrives.
 */
/**
 * ⚠ Bewegung P6 (Konzept §6 Zeile „Fehler/Leer/Toast": „wie Inhalt, kein
 * Hüpfen/Blinken"): jede Zustands-Fläche dieses Moduls trägt `.vp-blende` und
 * erscheint damit in `--vp-motion-base` statt zu springen. Sie sind alle
 * höhen-reservierend gebaut, also bewegt sich dabei kein Layout — es ist
 * ausschliesslich Opazität.
 */
export function ChartCardSkeleton({ stats = 4, chartHeight = 240 }: { stats?: number; chartHeight?: number }) {
  return (
    <div className="vp-blende" role="status" aria-live="polite" aria-busy="true">
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${stats}, minmax(0, 1fr))`,
          gap: 'var(--vp-gap-lg)',
          marginBottom: 'var(--vp-space-6)',
        }}
      >
        {Array.from({ length: stats }).map((_, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--vp-space-2)' }}>
            <Skeleton height={28} width="70%" />
            <Skeleton height={12} width="90%" />
          </div>
        ))}
      </div>
      <Skeleton height={chartHeight} radius="var(--vp-radius-md)" />
    </div>
  );
}

/** Table-shaped skeleton (header-less): N rows of a few cells. */
export function TableSkeleton({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div
      className="vp-blende"
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{ padding: 'var(--vp-space-4)' }}
    >
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            gap: 'var(--vp-space-4)',
            padding: 'var(--vp-space-3) 0',
            borderBottom: r < rows - 1 ? '1px solid var(--vp-border)' : 'none',
          }}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} height={14} width={c === 0 ? '80%' : '60%'} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A failed load: distinct from an empty state, with a retry. Uses the shared
 * error-alert styling. `onRetry` is optional (some callers only surface copy).
 */
export function ErrorState({
  message,
  onRetry,
  style = {},
}: {
  message: string;
  onRetry?: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="vp-alert vp-alert-err vp-blende" role="alert" style={{ marginTop: 0, ...style }}>
      <div style={{ marginBottom: onRetry ? 'var(--vp-space-3)' : 0 }}>{message}</div>
      {onRetry && (
        <Button variant="outline" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} onClick={onRetry}>
          Erneut versuchen
        </Button>
      )}
    </div>
  );
}

/**
 * The polished "nothing here yet" pattern (IconTile + heading + copy + optional
 * CTA), promoted to one component so every page gets the same treatment.
 */
export function EmptyState({
  icon = 'info',
  category = 'home',
  title,
  description,
  action,
}: {
  icon?: IconName;
  category?: 'solar' | 'battery' | 'ev' | 'home' | 'industry' | 'dynamic' | 'primary';
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="vp-empty vp-blende">
      <IconTile category={category} size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
        <Icon name={icon} size={24} />
      </IconTile>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

/* ==========================================================================
   V10 · Die drei Zustände einer VERLAUF-Karte
   (Konzept `data/vp-verlauf-sprache-konzept-v5` §3.2 V10, Paket P2b)

   Der Bereich „Verlauf" spricht EINE Sprache — und die gilt auch dort, wo
   noch nichts, nichts mehr oder nichts Ganzes da ist. Die drei Zustände oben
   (`ChartCardSkeleton`, `EmptyState`, `ErrorState`) bleiben, was sie sind: sie
   tragen das ganze übrige Portal. Die drei hier sind ihre Verlauf-Fassung.

   Drei Unterschiede, jeder aus einem gemessenen Grund:

   1. **Der Ladezustand reserviert die Höhe des späteren Inhalts** (A10) —
      Label + Kernsatz + Diagramm + Legende, jedes in seiner echten Höhe. Der
      alte `ChartCardSkeleton` zeigte eine Kennzahlen-ZEILE, die diese Karten
      gar nicht haben, und ein 240-px-Bild, wo 260 kommen: die Seite sprang
      beim Zeitraumwechsel.
   2. **Der Leer-Zustand behauptet nichts Grosses** — kein 48-px-Symbol, keine
      1,25-rem-Überschrift. Label, ein Satz in Textgrösse, und der WEG als
      Textlink.
   3. **Der Fehler bleibt IN der Karte** und trägt seine eine Handlung als
      44-px-Knopf. Die alte `ErrorState`-Kachel stand mit eigenem Rahmen an
      der Stelle der Karte — die Überschrift, unter der die Zahl stand, war
      damit weg.
   ========================================================================== */

/**
 * V10 · Laden. Reserviert die Anatomie der Karte, damit nichts springt.
 *
 * ⚠ Die Höhe des Diagramm-Platzhalters ist ein ZWILLING von `.vp-chart`
 * (`index.css`) — `verlaufZustaende.test.ts` vergleicht beide Formeln.
 */
export function VerlaufKarteSkeleton({
  label = true,
  satz = true,
  chart = true,
  legende = true,
}: {
  /** Die Label-Zeile der Sektion (12/700). */
  label?: boolean;
  /** Der Kernsatz darunter (16). */
  satz?: boolean;
  /** Das Diagramm — dieselbe Höhe, die es später wirklich einnimmt. */
  chart?: boolean;
  /** Die Legenden-Zeile unter dem Bild (44 px). */
  legende?: boolean;
}) {
  return (
    <div className="vp-c-zst-lade vp-blende" role="status" aria-live="polite" aria-busy="true">
      <span className="vp-note vp-sr-only">Wird geladen…</span>
      {label && <div className="vp-skeleton vp-c-zst-label" aria-hidden="true" />}
      {satz && <div className="vp-skeleton vp-c-zst-satz" aria-hidden="true" />}
      {chart && <div className="vp-skeleton vp-c-zst-chart" aria-hidden="true" />}
      {legende && <div className="vp-skeleton vp-c-zst-legende" aria-hidden="true" />}
    </div>
  );
}

/**
 * V10 · Leer. Label, EIN Satz, und ein Weg — mehr behauptet die Fläche nicht.
 *
 * `weg` ist bewusst ein Textlink und kein Knopf: er führt woandershin
 * (anderer Zeitraum, andere Fläche), er wiederholt nicht dieselbe Handlung.
 * Ohne einen echten Weg bleibt er weg — ein toter Link ist schlimmer als
 * keiner.
 */
export function VerlaufLeer({
  label,
  satz,
  weg,
  onWeg,
}: {
  /** Die Sektions-Zeile, 12/700 — sie sagt, WAS hier leer ist. */
  label: string;
  /** Der eine Satz in Textgrösse. */
  satz: ReactNode;
  /** Die Beschriftung des Wegs; ohne `onWeg` wird er nicht gezeigt. */
  weg?: string;
  onWeg?: () => void;
}) {
  return (
    <div className="vp-c-zst-leer vp-blende">
      <span className="vp-c-zst-leer-label">{label}</span>
      <p className="vp-c-zst-text">{satz}</p>
      {weg && onWeg ? (
        <button type="button" className="vp-c-zst-weg" onClick={onWeg}>
          {weg}
        </button>
      ) : null}
    </div>
  );
}

/**
 * V10 · Fehler. `role="alert"`, ein Satz in Textgrösse, und die eine Handlung.
 *
 * ⚠ Er gehört IN die Karte. Der Aufrufer stellt sie — dieses Bauteil bringt
 * keinen eigenen Rahmen mit, damit die Fläche beim Fehlschlag nicht die
 * Überschrift verliert, unter der die Zahl stand.
 */
export function VerlaufFehler({
  satz,
  onRetry,
}: {
  satz: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="vp-c-zst-fehler vp-blende" role="alert">
      <p className="vp-c-zst-text">{satz}</p>
      {onRetry && (
        <Button
          variant="outline"
          className="vp-c-zst-knopf"
          iconLeft={<Icon name="refresh-cw" size={16} />}
          onClick={onRetry}
        >
          Erneut versuchen
        </Button>
      )}
    </div>
  );
}
