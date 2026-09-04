import React from 'react';

export interface ModalProps {
  /** Render the modal (with scrim). */
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
 * Centred modal for the repeatable list + add + detail entity pattern.
 * Rendered into `document.body`; full-screen sheet below 720px.
 */
export function Modal(props: ModalProps): JSX.Element | null;
