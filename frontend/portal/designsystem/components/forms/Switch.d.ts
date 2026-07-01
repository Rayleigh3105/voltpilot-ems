import React from 'react';

export interface SwitchProps {
  /** On/off state. */
  checked?: boolean;
  /** Change handler. */
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Disable interaction. */
  disabled?: boolean;
  /** Optional text label rendered to the right. */
  label?: React.ReactNode;
  id?: string;
}

/**
 * Pill toggle switch — blue gradient track when on.
 */
export function Switch(props: SwitchProps): JSX.Element;
