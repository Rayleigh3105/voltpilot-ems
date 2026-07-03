import React from 'react';

/**
 * VoltPilot Button — deep action-ink primary, white, outline and ghost variants.
 * Hover / press / focus affordance lives in CSS (core.css `.vp-btn*`) so touch
 * and keyboard users get it too; no inline onMouseEnter/Leave. The primary fill
 * uses the deep `--vp-action` ink so white text passes WCAG AA.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  className = '',
  style = {},
  ...props
}) {
  const classes = [
    'vp-btn',
    `vp-btn--${variant}`,
    `vp-btn--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      disabled={disabled}
      className={classes}
      style={{ width: fullWidth ? '100%' : 'auto', ...style }}
      {...props}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}
