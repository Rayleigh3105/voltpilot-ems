import React from 'react';

/**
 * VoltPilot Card — white surface, soft border, small shadow.
 * On hover (when `interactive`): lifts + brand-glow shadow + a colored
 * gradient bar slides across the top.
 */
export function Card({
  children,
  interactive = false,
  accent = 'primary', // primary | solar | battery | ev | home | industry | dynamic
  padding = 'md',     // md (2rem) | lg (2.5rem)
  radius = 'md',      // md (16px) | lg (24px)
  style = {},
  ...props
}) {
  const accentGrad = accent === 'primary'
    ? 'var(--vp-grad-bar)'
    : `var(--vp-grad-${accent})`;

  const pad = padding === 'lg' ? 'var(--vp-card-pad-lg)' : 'var(--vp-card-pad)';
  const rad = radius === 'lg' ? 'var(--vp-radius-lg)' : 'var(--vp-radius-md)';

  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--vp-surface)',
        border: '1px solid var(--vp-border)',
        borderRadius: rad,
        padding: pad,
        boxShadow: 'var(--vp-shadow-sm)',
        overflow: 'hidden',
        transition: 'var(--vp-transition)',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!interactive) return;
        e.currentTarget.style.transform = 'translateY(-8px)';
        e.currentTarget.style.boxShadow = 'var(--vp-shadow-hover)';
        const bar = e.currentTarget.querySelector('[data-accent-bar]');
        if (bar) bar.style.transform = 'scaleX(1)';
      }}
      onMouseLeave={(e) => {
        if (!interactive) return;
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'var(--vp-shadow-sm)';
        const bar = e.currentTarget.querySelector('[data-accent-bar]');
        if (bar) bar.style.transform = 'scaleX(0)';
      }}
      {...props}
    >
      {interactive && (
        <span
          data-accent-bar
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: '4px',
            background: accentGrad,
            transform: 'scaleX(0)',
            transformOrigin: 'left',
            transition: 'var(--vp-transition)',
          }}
        />
      )}
      {children}
    </div>
  );
}
