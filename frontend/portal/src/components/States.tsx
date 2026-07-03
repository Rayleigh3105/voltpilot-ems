import type { ReactNode } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Icon } from '../../designsystem/components/core/Icon';
import { IconTile } from '../../designsystem/components/core/IconTile';
import type { IconName } from '../../designsystem/components/core/Icon';

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
export function ChartCardSkeleton({ stats = 4, chartHeight = 240 }: { stats?: number; chartHeight?: number }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
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
    <div role="status" aria-live="polite" aria-busy="true" style={{ padding: 'var(--vp-space-4)' }}>
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
    <div className="vp-alert vp-alert-err" role="alert" style={{ marginTop: 0, ...style }}>
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
    <div className="vp-empty">
      <IconTile category={category} size={48} style={{ margin: '0 auto var(--vp-space-4)' }}>
        <Icon name={icon} size={24} />
      </IconTile>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
