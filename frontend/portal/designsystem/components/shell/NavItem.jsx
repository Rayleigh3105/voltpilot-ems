import React from 'react';

/**
 * VoltPilot NavItem — sidebar navigation entry: icon + label (+ count),
 * active state with the brand tint, ≥44px touch target.
 * Styles in shell.css (import once at the app root).
 */
export function NavItem({
  icon,
  label,
  count = null,
  active = false,
  className = '',
  ...props
}) {
  return (
    <button
      type="button"
      className={`vp-navitem ${active ? 'active' : ''} ${className}`.trim()}
      aria-current={active ? 'page' : undefined}
      {...props}
    >
      <span className="ic" aria-hidden="true">{icon}</span>
      {label}
      {count != null && <span className="count">{count}</span>}
    </button>
  );
}
