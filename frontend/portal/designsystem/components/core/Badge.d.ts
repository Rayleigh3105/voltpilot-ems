import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * 'tint' (soft blue bg), 'gradient' (blue gradient), 'solid' (deep blue,
   * white text), plus status variants: 'ok' (green), 'warn' (amber),
   * 'offline' (orange, a step darker than 'warn'), 'off' (muted). Default
   * 'tint'.
   */
  variant?: 'tint' | 'gradient' | 'solid' | 'ok' | 'warn' | 'offline' | 'off';
  /** Render a small status dot before the label (for online/offline states). */
  dot?: boolean;
  /** One-shot pulse on the dot (proof of a fresh heartbeat) - never a looping animation. */
  pulse?: boolean;
}

/**
 * Small pill label for tags, statuses, and eyebrow text.
 */
export function Badge(props: BadgeProps): JSX.Element;
