import React from 'react';

/**
 * VoltPilot Input — white field, --vp-field-border, brand focus ring.
 * Forwards its ref to the native <input> so callers can focus fields.
 *
 * Der RUHENDE Rand ist --vp-field-border (3,2:1), nicht --vp-border (1,19:1):
 * der Rand ist die einzige Angabe, wo das Feld anfaengt (WCAG 1.4.11). Der
 * FOKUS-Rand ist --vp-primary-deep (3,28:1) statt --vp-primary (1,97:1) —
 * sonst wuerde das Feld beim Fokussieren HELLER umrandet als im Ruhezustand.
 * Der VpPicker-Ausloeser (src/components/VpPicker.css) traegt dieselbe
 * Feld-Optik und wandert mit; beide zusammen aendern.
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
          border: `1px solid ${error ? 'var(--vp-industry)' : focused ? 'var(--vp-primary-deep)' : 'var(--vp-field-border)'}`,
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
