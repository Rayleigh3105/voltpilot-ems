import React from 'react';

/**
 * VoltPilot Drawer — right-side panel used for BOTH "anlegen" forms and row
 * detail views (the repeatable entity pattern). Scrim click, ✕ and Escape all
 * close it; on phones it becomes a full-screen sheet (shell.css).
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
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="vp-drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="vp-drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} {...props}>
        <div className="dhead">
          {icon}
          <h2>{title}</h2>
          <button type="button" className="x" aria-label="Schließen" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dbody">{children}</div>
        {footer && <div className="dfoot">{footer}</div>}
      </aside>
    </>
  );
}
