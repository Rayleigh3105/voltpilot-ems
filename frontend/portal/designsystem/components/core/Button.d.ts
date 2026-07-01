import React from 'react';

export type ButtonVariant = 'primary' | 'white' | 'outline' | 'outline-light' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Default 'primary'. Use 'white' / 'outline-light' on dark/hero backgrounds. */
  variant?: ButtonVariant;
  /** Size. Default 'md'. */
  size?: ButtonSize;
  /** Stretch to container width. */
  fullWidth?: boolean;
  /** Optional element rendered before the label. */
  iconLeft?: React.ReactNode;
  /** Optional element rendered after the label. */
  iconRight?: React.ReactNode;
}

/**
 * Primary call-to-action button. Gradient fill with brand glow; lifts on hover.
 * @startingPoint section="Core" subtitle="Gradient & outline buttons" viewport="700x180"
 */
export function Button(props: ButtonProps): JSX.Element;
