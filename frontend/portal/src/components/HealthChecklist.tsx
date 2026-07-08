import type { HealthItem } from '../health';

/**
 * The Gesundheits-Checklist (desktop Zone C): the "ist sie gesund?" answer as a
 * compact list of ok/warn/off rows. Render-only; derivation is the pure
 * healthChecklist() in src/health.ts.
 */
export function HealthChecklist({ items }: { items: HealthItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="vp-health">
      <span className="vp-card-label">Gesundheit</span>
      <ul className="vp-health-list">
        {items.map((it) => (
          <li key={it.key} className={`vp-health-item tone-${it.state}`}>
            <span className="vp-health-mark" aria-hidden="true">
              {it.state === 'ok' ? '✓' : it.state === 'warn' ? '!' : '–'}
            </span>
            <span className="vp-health-label">{it.label}</span>
            <span className="vp-health-detail">{it.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
