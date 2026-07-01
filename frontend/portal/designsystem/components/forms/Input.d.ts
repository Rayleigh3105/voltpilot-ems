import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Field label rendered above the input. */
  label?: React.ReactNode;
  /** Helper text below the field. */
  hint?: React.ReactNode;
  /** Error message — turns border/text red and overrides hint. */
  error?: React.ReactNode;
}

/**
 * Text input with optional label, hint and error. White field, soft border,
 * brand-blue focus ring. Forwards its ref to the native input element.
 */
export const Input: React.ForwardRefExoticComponent<
  InputProps & React.RefAttributes<HTMLInputElement>
>;
