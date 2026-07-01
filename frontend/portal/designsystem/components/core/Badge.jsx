import React from 'react';

/**
 * VoltPilot Badge / Pill — tinted or gradient label, plus the status variants
 * ok / warn / off (green / amber / muted) used for device and user states.
 * `dot` renders a small status dot before the label.
 */
export function Badge({
  children,
  variant = 'tint', // tint | gradient | solid | ok | warn | off
  dot = false,
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
    ok: {
      background: 'var(--vp-mint-start)',
      color: '#2e7d32',
    },
    warn: {
      background: '#FFF3E0',
      color: '#B45309',
    },
    off: {
      background: 'var(--vp-bg-light)',
      color: '#57606A',
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
      {dot && (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 'var(--vp-radius-full)',
            background: 'currentColor',
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}
