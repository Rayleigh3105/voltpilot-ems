import React from 'react';

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The big number, e.g. "30%" or "1.200+". */
  value: React.ReactNode;
  /** Small muted caption below. */
  label: React.ReactNode;
  /** Text alignment. Default 'left'. */
  align?: 'left' | 'center';
}

/**
 * Headline metric — large extrabold blue number over a small gray label.
 */
export function Stat(props: StatProps): JSX.Element;
