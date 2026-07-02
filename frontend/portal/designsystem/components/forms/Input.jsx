import React from 'react';

/**
 * VoltPilot Input — white field, soft border, brand focus ring.
 * Forwards its ref to the native <input> so callers can focus fields.
 */
export const Input = React.forwardRef(function Input({
  label = null,
  hint = null,
  error = null,
  id,
  style = {},
  ...props
}, ref) {
  const [focused, setFocused] = React.useState(false);
  const inputId = id || React.useId();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontFamily: 'var(--vp-font-body)',
            fontSize: '0.9rem',
            fontWeight: 600,
            color: 'var(--vp-text-dark)',
          }}
        >
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        onFocus={(e) => { setFocused(true); props.onFocus && props.onFocus(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur && props.onBlur(e); }}
        style={{
          fontFamily: 'var(--vp-font-body)',
          fontSize: '1rem',
          color: 'var(--vp-text-dark)',
          background: 'var(--vp-surface)',
          border: `1px solid ${error ? 'var(--vp-industry)' : focused ? 'var(--vp-primary)' : 'var(--vp-border)'}`,
          borderRadius: 'var(--vp-radius-btn)',
          padding: '0.75rem 1rem',
          outline: 'none',
          boxShadow: focused ? '0 0 0 3px var(--vp-focus-ring)' : 'none',
          transition: 'var(--vp-transition-fast)',
          width: '100%',
          boxSizing: 'border-box',
          ...style,
        }}
        {...props}
      />
      {(hint || error) && (
        <span style={{
          fontFamily: 'var(--vp-font-body)',
          fontSize: '0.82rem',
          color: error ? 'var(--vp-industry)' : 'var(--vp-text-gray)',
        }}>
          {error || hint}
        </span>
      )}
    </div>
  );
});
