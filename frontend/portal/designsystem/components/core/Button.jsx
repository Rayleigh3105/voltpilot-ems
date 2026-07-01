import React from 'react';

/**
 * VoltPilot Button — gradient primary, white, outline and ghost variants.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  style = {},
  ...props
}) {
  const sizes = {
    sm: { padding: '0.55rem 1.1rem', fontSize: '0.9rem' },
    md: { padding: '0.85rem 1.75rem', fontSize: '1rem' },
    lg: { padding: '1rem 2.25rem', fontSize: '1.05rem' },
  };

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    fontFamily: 'var(--vp-font-heading)',
    fontWeight: 700,
    lineHeight: 1,
    border: '2px solid transparent',
    borderRadius: 'var(--vp-radius-btn)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    width: fullWidth ? '100%' : 'auto',
    transition: 'var(--vp-transition)',
    whiteSpace: 'nowrap',
    ...sizes[size],
  };

  const variants = {
    primary: {
      background: 'var(--vp-grad-button)',
      color: '#fff',
      boxShadow: 'var(--vp-shadow-btn)',
    },
    white: {
      background: 'var(--vp-surface)',
      color: 'var(--vp-primary-deep)',
      boxShadow: 'var(--vp-shadow-md)',
    },
    outline: {
      background: 'transparent',
      color: 'var(--vp-primary-deep)',
      borderColor: 'var(--vp-primary)',
    },
    'outline-light': {
      background: 'rgba(255,255,255,0.06)',
      color: '#fff',
      borderColor: 'rgba(255,255,255,0.5)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--vp-text-gray)',
    },
  };

  return (
    <button
      type="button"
      disabled={disabled}
      style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(-3px)';
        if (variant === 'primary') e.currentTarget.style.boxShadow = 'var(--vp-shadow-hover)';
        if (variant === 'outline') e.currentTarget.style.background = 'var(--vp-tint)';
        if (variant === 'outline-light') e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = variants[variant].boxShadow || 'none';
        if (variant === 'outline') e.currentTarget.style.background = 'transparent';
        if (variant === 'outline-light') e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
      }}
      {...props}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}
