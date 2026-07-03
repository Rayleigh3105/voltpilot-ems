import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import type { IconName } from '../../designsystem/components/core/Icon';

export type RowMenuItem = {
  label: string;
  icon?: IconName;
  onClick: () => void;
  /** Renders the item in the destructive style and after a separator. */
  danger?: boolean;
};

/**
 * A table-row overflow menu (⋯). Collapses dense per-row actions into a
 * popover so routine and destructive actions no longer wrap side by side in a
 * narrow cell; destructive items are visually separated. Closes on outside
 * click or Escape.
 *
 * The popover is rendered into document.body at fixed coordinates derived from
 * the button's getBoundingClientRect() and clamped to the viewport (the same
 * pattern InfoTip uses), so it is never clipped by the host card's
 * `overflow: hidden` - the last/only row's actions stay fully visible and
 * clickable. It flips upward when there is no room below.
 */
export function RowMenu({ items, label = 'Aktionen' }: { items: RowMenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const routine = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);

  const place = useCallback(() => {
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const margin = 12;
    const gap = 4;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Right-align the popover with the button's right edge, clamped horizontally.
    const left = Math.max(margin, Math.min(rect.right - pw, vw - pw - margin));

    // Below by default; flip above when there's no room and there is above.
    let top = rect.bottom + gap;
    if (top + ph > vh - margin && rect.top - gap - ph > margin) {
      top = rect.top - gap - ph;
    }
    top = Math.max(margin, Math.min(top, vh - ph - margin));
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  return (
    <span className="vp-rowmenu">
      <button
        ref={btnRef}
        type="button"
        className="vp-rowmenu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="more-horizontal" size={18} />
      </button>
      {open &&
        createPortal(
          <>
            <div
              className="vp-rowmenu-scrim"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            />
            <div
              ref={popRef}
              className="vp-rowmenu-pop"
              role="menu"
              style={
                coords
                  ? { top: coords.top, left: coords.left, visibility: 'visible' }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
              }}
            >
              {routine.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  {it.icon && <Icon name={it.icon} size={16} />}
                  {it.label}
                </button>
              ))}
              {danger.length > 0 && routine.length > 0 && <div className="vp-rowmenu-sep" />}
              {danger.map((it) => (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    it.onClick();
                  }}
                >
                  {it.icon && <Icon name={it.icon} size={16} />}
                  {it.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}
