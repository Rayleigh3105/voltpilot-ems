import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * 'tint' (soft blue bg), 'gradient' (blue gradient), 'solid' (deep blue,
   * white text), plus status variants: 'ok' (green), 'warn' (amber),
   * 'off' (muted). Default 'tint'.
   */
  variant?: 'tint' | 'gradient' | 'solid' | 'ok' | 'warn' | 'off';
  /** Render a small status dot before the label (for online/offline states). */
  dot?: boolean;
}

/**
 * Small pill label for tags, statuses, and eyebrow text.
 */
export function Badge(props: BadgeProps): JSX.Element;
