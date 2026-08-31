import React from 'react';
import { Icon } from '../core/Icon';

/*
 * Drawers may be stacked (for example the measurement library plus its
 * confirmation). A saved `body.style.overflow` per instance is not enough:
 * if two drawers unmount in one commit, the later cleanup can restore the
 * other drawer's `hidden` value permanently. Keep one shared lock count and
 * restore the page value only after the last drawer has gone.
 */
let scrollLocks = 0;
let pageOverflow = '';
const drawerStack = [];

function lockBodyScroll() {
  if (scrollLocks === 0) pageOverflow = document.body.style.overflow;
  scrollLocks += 1;
  document.body.style.overflow = 'hidden';

  return () => {
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) {
      document.body.style.overflow = pageOverflow;
      pageOverflow = '';
    }
  };
}

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
  const closeRef = React.useRef(onClose);
  const tokenRef = React.useRef(null);
  closeRef.current = onClose;
  if (tokenRef.current === null) tokenRef.current = { panelRef };

  React.useEffect(() => {
    if (!open) return undefined;
    const token = tokenRef.current;
    const unlockBodyScroll = lockBodyScroll();
    const prevFocus = document.activeElement;
    drawerStack.push(token);
    panelRef.current?.focus();
    const onKey = (e) => {
      if (e.key !== 'Escape' || drawerStack.at(-1) !== token) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      const wasTopmost = drawerStack.at(-1) === token;
      const index = drawerStack.lastIndexOf(token);
      if (index >= 0) drawerStack.splice(index, 1);
      unlockBodyScroll();
      if (wasTopmost && prevFocus?.isConnected && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      } else if (wasTopmost) {
        drawerStack.at(-1)?.panelRef.current?.focus();
      }
    };
    // `onClose` deliberately lives in `closeRef`: controlled fields inside a
    // drawer commonly rerender their owner on every key. An inline callback
    // must not tear down the modal effect, steal focus, and re-lock scrolling
    // after each character.
  }, [open]);

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
