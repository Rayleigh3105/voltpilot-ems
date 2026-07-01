import React from 'react';

/**
 * VoltPilot Switch — pill toggle, blue gradient when on.
 */
export function Switch({
  checked = false,
  onChange,
  disabled = false,
  label = null,
  id,
  style = {},
  ...props
}) {
  const switchId = id || React.useId();
  return (
    <label
      htmlFor={switchId}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.65rem',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        fontFamily: 'var(--vp-font-body)',
        fontSize: '0.95rem',
        color: 'var(--vp-text-dark)',
        ...style,
      }}
    >
      <span
        style={{
          position: 'relative',
          width: 46,
          height: 26,
          flexShrink: 0,
          borderRadius: 'var(--vp-radius-pill)',
          background: checked ? 'var(--vp-grad-button)' : 'var(--vp-gray)',
          transition: 'var(--vp-transition-fast)',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: checked ? 23 : 3,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: 'var(--vp-shadow-sm)',
            transition: 'var(--vp-transition-fast)',
          }}
        />
      </span>
      <input
        id={switchId}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
        {...props}
      />
      {label}
    </label>
  );
}
