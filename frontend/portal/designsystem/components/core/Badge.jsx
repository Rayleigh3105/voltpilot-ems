import React from 'react';

/**
 * VoltPilot Badge / Pill — tinted or gradient label.
 */
export function Badge({
  children,
  variant = 'tint', // tint | gradient | solid
  style = {},
  ...props
}) {
  const variants = {
    tint: {
      background: 'var(--vp-tint)',
      color: 'var(--vp-primary-deep)',
    },
    gradient: {
      background: 'var(--vp-grad-badge)',
      color: 'var(--vp-primary-deep)',
    },
    solid: {
      background: 'var(--vp-primary-deep)',
      color: '#fff',
    },
  };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
        fontFamily: 'var(--vp-font-body)',
        fontSize: 'var(--vp-text-badge)',
        fontWeight: 600,
        lineHeight: 1,
        padding: '0.3rem 0.75rem',
        borderRadius: 'var(--vp-radius-pill)',
        ...variants[variant],
        ...style,
      }}
      {...props}
    >
      {children}
    </span>
  );
}
