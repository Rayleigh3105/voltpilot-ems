import React from 'react';

/**
 * VoltPilot IconTile — rounded square or circle filled with a category
 * gradient, white glyph centered. Used in solution cards and energy nodes.
 */
export function IconTile({
  children,
  category = 'home', // solar | battery | ev | home | industry | dynamic | primary
  size = 56,
  shape = 'rounded', // rounded | circle
  style = {},
  ...props
}) {
  const grad = category === 'primary'
    ? 'var(--vp-grad-button)'
    : `var(--vp-grad-${category})`;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        background: grad,
        color: '#fff',
        borderRadius: shape === 'circle' ? '50%' : 'var(--vp-radius-md)',
        fontSize: size * 0.46,
        lineHeight: 1,
        boxShadow: 'var(--vp-shadow-sm)',
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
