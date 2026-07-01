import React from 'react';

export interface NavItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Glyph shown before the label (character or element). */
  icon: React.ReactNode;
  /** Navigation label (always shown - icons alone are ambiguous). */
  label: React.ReactNode;
  /** Optional trailing count badge (e.g. number of sites). */
  count?: React.ReactNode;
  /** Highlight as the current page. */
  active?: boolean;
}

/**
 * Sidebar navigation entry for the unified dashboard shell.
 */
export function NavItem(props: NavItemProps): JSX.Element;
