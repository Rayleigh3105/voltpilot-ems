import React from 'react';

export interface DrawerProps {
  /** Render the drawer (with scrim). */
  open: boolean;
  /** Called on scrim click, ✕ and Escape. */
  onClose: () => void;
  /** Header title. */
  title: React.ReactNode;
  /** Optional leading element in the header (e.g. an IconTile). */
  icon?: React.ReactNode;
  /** Optional footer (action buttons, right-aligned). */
  footer?: React.ReactNode;
  children?: React.ReactNode;
}

/**
 * Right-side drawer for the repeatable list + add + detail entity pattern.
 * Full-screen sheet below 720px.
 */
export function Drawer(props: DrawerProps): JSX.Element | null;
