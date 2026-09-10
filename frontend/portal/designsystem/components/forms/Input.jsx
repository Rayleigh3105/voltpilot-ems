import React from 'react';

/**
 * VoltPilot Input — white field, --vp-field-border, brand focus ring.
 * Forwards its ref to the native <input> so callers can focus fields.
 *
 * Der RUHENDE Rand ist --vp-field-border (3,35:1), nicht --vp-border (1,19:1):
 * der Rand ist die einzige Angabe, wo das Feld anfaengt (WCAG 1.4.11). Der
 * FOKUS-Rand ist --vp-action (7,97:1) — das Interaktions-Blau des Hauses, das
 * auch --vp-focus-ring-color traegt. Er MUSS staerker sein als der Ruhe-Rand,
 * sonst laese sich Fokussieren als Ruecknahme.
 * ⚠ Er war bis 08/2026 --vp-primary-deep (3,28:1) und lag damit nur 0,07
 * ueber dem Ruhe-Rand; als --vp-text-gray fuer AA auf --vp-surface-alt
 * nachgedunkelt wurde, kippte das Verhaeltnis. Der Fokus-Ton haengt deshalb
 * nicht mehr an einer Marken-Nuance, die eine Neutral-Korrektur ueberholen
 * kann.
 * Der VpPicker-Ausloeser (src/components/VpPicker.css) traegt dieselbe
 * Feld-Optik und DASSELBE Fokus-Token; beide zusammen aendern.
 */
export const Input = React.forwardRef(function Input({
  label = null,
  hint = null,
  error = null,
  id,
  style = {},
  onFocus,
  onBlur,
  'aria-describedby': describedBy,
  ...props
}, ref) {
  const [focused, setFocused] = React.useState(false);
  const generatedId = React.useId();
  const inputId = id || generatedId;
  const feedbackId = `${inputId}-feedback`;

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
        aria-invalid={error ? true : undefined}
        aria-describedby={[describedBy, (hint || error) && feedbackId].filter(Boolean).join(' ') || undefined}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        style={{
          fontFamily: 'var(--vp-font-body)',
          fontSize: '1rem',
          color: 'var(--vp-text-dark)',
          background: 'var(--vp-surface)',
          border: `1px solid ${error ? 'var(--vp-industry)' : focused ? 'var(--vp-action)' : 'var(--vp-field-border)'}`,
          borderRadius: 'var(--vp-radius-btn)',
          padding: '0.75rem 1rem',
          outline: 'none',
          boxShadow: focused ? '0 0 0 3px var(--vp-focus-ring)' : 'none',
          transition: 'var(--vp-motion-chrome)',
          width: '100%',
          boxSizing: 'border-box',
          ...style,
        }}
        {...props}
      />
      {(hint || error) && (
        <span id={feedbackId} style={{
          fontFamily: 'var(--vp-font-body)',
          fontSize: '0.82rem',
          color: error ? 'var(--vp-industry-end)' : 'var(--vp-text-gray)',
        }}>
          {error || hint}
        </span>
      )}
    </div>
  );
});
