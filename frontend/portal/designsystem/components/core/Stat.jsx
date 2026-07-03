import React from 'react';

/**
 * VoltPilot Stat — large extrabold number over a small muted label.
 */
export function Stat({
  value,
  label,
  align = 'left', // left | center
  style = {},
  ...props
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.25rem',
        textAlign: align,
        alignItems: align === 'center' ? 'center' : 'flex-start',
        ...style,
      }}
      {...props}
    >
      <span style={{
        fontFamily: 'var(--vp-font-heading)',
        fontSize: 'var(--vp-text-stat-sm, var(--vp-text-stat))',
        fontWeight: 800,
        lineHeight: 1.1,
        color: 'var(--vp-stat-ink, var(--vp-action))',
        letterSpacing: '-0.5px',
      }}>
        {value}
      </span>
      <span style={{
        fontFamily: 'var(--vp-font-body)',
        fontSize: '0.9rem',
        fontWeight: 500,
        color: 'var(--vp-text-gray)',
      }}>
        {label}
      </span>
    </div>
  );
}
