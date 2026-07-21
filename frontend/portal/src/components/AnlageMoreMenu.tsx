import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import { DEEP_VIEW_ITEMS } from '../anlageNav';
import type { AnlagenSub } from '../nav';

/**
 * M1 (#529): the INTERIM access affordance for the Anlage deep views.
 *
 * The U1 per-Anlage tab bar is retired (F1) and the block drill-ins that will
 * own the deep views land in M3 — so until then this "Mehr ▾" menu keeps EVERY
 * deep view (Live · Fahrplan · Historie & Erlöse · Lastspitzen · Wetter ·
 * Einstellungen) one click away, on the cockpit AND on every deep view itself.
 * Nothing is ever orphaned; the cockpit's own drill-in links stay too.
 *
 * The popover portals to `document.body` (the RowMenu/InfoTip escape-the-clip
 * pattern) and is viewport-clamped, so a card's `overflow: hidden` or a phone
 * edge can never swallow it.
 */
export function AnlageMoreMenu({
  activeSub,
  onOpen,
}: {
  /** The currently open sub, so it can be marked in the menu. */
  activeSub: AnlagenSub | null;
  onOpen: (sub: AnlagenSub) => void;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

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
    const left = Math.max(margin, Math.min(rect.right - pw, vw - pw - margin));
    let top = rect.bottom + gap;
    if (top + ph > vh - margin && rect.top - gap - ph > margin) top = rect.top - gap - ph;
    top = Math.max(margin, Math.min(top, vh - ph - margin));
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
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
    <>
      <button
        ref={btnRef}
        type="button"
        className="vp-more-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>Mehr</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open &&
        createPortal(
          <>
            <div className="vp-rowmenu-scrim" onClick={() => setOpen(false)} />
            <div
              ref={popRef}
              className="vp-rowmenu-pop"
              role="menu"
              style={
                coords
                  ? { top: coords.top, left: coords.left, visibility: 'visible' }
                  : { top: 0, left: 0, visibility: 'hidden' }
              }
            >
              {DEEP_VIEW_ITEMS.map((item) => (
                <button
                  key={item.sub}
                  type="button"
                  role="menuitem"
                  className={item.sub === activeSub ? 'active' : undefined}
                  onClick={() => {
                    setOpen(false);
                    onOpen(item.sub);
                  }}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
