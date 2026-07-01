import React from 'react';

export type CardAccent = 'primary' | 'solar' | 'battery' | 'ev' | 'home' | 'industry' | 'dynamic';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Enable hover lift + brand glow + sliding top accent bar. */
  interactive?: boolean;
  /** Color of the top accent bar (shown when interactive). Default 'primary'. */
  accent?: CardAccent;
  /** Inner padding. 'md' = 2rem, 'lg' = 2.5rem. Default 'md'. */
  padding?: 'md' | 'lg';
  /** Corner radius. 'md' = 16px, 'lg' = 24px. Default 'md'. */
  radius?: 'md' | 'lg';
}

/**
 * Surface container for grouped content. White, soft border, small shadow.
 * @startingPoint section="Core" subtitle="Surface with hover accent bar" viewport="700x260"
 */
export function Card(props: CardProps): JSX.Element;
