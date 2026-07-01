import React from 'react';
import { Icon } from '../core/Icon';

/**
 * VoltPilot Drawer — right-side panel used for BOTH "anlegen" forms and row
 * detail views (the repeatable entity pattern). Scrim click, ✕ and Escape all
 * close it; body scroll is locked and focus moves into the panel while open;
 * on phones it becomes a full-screen sheet (shell.css).
 */
export function Drawer({
  open,
  onClose,
  title,
  icon = null,
  footer = null,
  children,
  ...props
}) {
  const panelRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement;
    panelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="vp-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="vp-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        {...props}
      >
        <div className="dhead">
          {icon}
          <h2>{title}</h2>
          <button type="button" className="x" aria-label="Schließen" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="dbody">{children}</div>
        {footer && <div className="dfoot">{footer}</div>}
      </aside>
    </>
  );
}
