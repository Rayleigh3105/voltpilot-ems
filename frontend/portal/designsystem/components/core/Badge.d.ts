import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** 'tint' (soft blue bg), 'gradient' (blue gradient), 'solid' (deep blue, white text). Default 'tint'. */
  variant?: 'tint' | 'gradient' | 'solid';
}

/**
 * Small pill label for tags, statuses, and eyebrow text.
 */
export function Badge(props: BadgeProps): JSX.Element;
