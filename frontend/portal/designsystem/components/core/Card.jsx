import React from 'react';

/**
 * VoltPilot Card — white surface, soft border, small shadow.
 * On hover (when `interactive`): lifts + brand-glow shadow + a colored
 * gradient bar slides across the top. Hover/press affordance lives in CSS
 * (core.css `.vp-card*`) so it works on touch + keyboard, not just a mouse.
 */
export function Card({
  children,
  interactive = false,
  accent = 'primary', // primary | solar | battery | ev | home | industry | dynamic
  padding = 'md',     // md (2rem) | lg (2.5rem)
  radius = 'md',      // md (16px) | lg (24px)
  className = '',
  style = {},
  ...props
}) {
  const accentGrad = accent === 'primary'
    ? 'var(--vp-grad-bar)'
    : `var(--vp-grad-${accent})`;

  const pad = padding === 'lg' ? 'var(--vp-card-pad-lg)' : 'var(--vp-card-pad)';
  const rad = radius === 'lg' ? 'var(--vp-radius-lg)' : 'var(--vp-radius-md)';

  const classes = ['vp-card', interactive && 'vp-card--interactive', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      style={{ padding: pad, borderRadius: rad, ...style }}
      {...props}
    >
      {interactive && (
        <span className="vp-card__accent" style={{ background: accentGrad }} />
      )}
      {children}
    </div>
  );
}
