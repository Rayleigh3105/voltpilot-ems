import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';

/**
 * InfoTip - the portal's inline "erklär mir das" info icon. A small info button
 * that reveals a short explanation on hover/focus (desktop + keyboard) or tap
 * (touch). The bubble is rendered into document.body and positioned with
 * fixed coordinates clamped to the viewport, so it never clips inside a card
 * or gets cut off on a phone. Used to make metrics self-explanatory in place
 * (e.g. Prognosequalität), matching the design-system tokens.
 */
export function InfoTip({
  title,
  children,
  label = 'Erklärung anzeigen',
}: {
  title?: string;
  children: ReactNode;
  /** Accessible label for the trigger button. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    placement: 'top' | 'bottom';
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const id = useId();
  // Fine pointers (mouse) get hover/focus; coarse pointers (touch) get tap.
  const [hoverCapable] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover)').matches,
  );

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const rect = trigger.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const margin = 12;
    const gap = 8;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    const centerX = rect.left + rect.width / 2;
    const left = Math.max(margin, Math.min(centerX - bw / 2, vw - bw - margin));

    let placement: 'top' | 'bottom' = 'bottom';
    let top = rect.bottom + gap;
    if (top + bh > vh - margin && rect.top - gap - bh > margin) {
      placement = 'top';
      top = rect.top - gap - bh;
    }
    setCoords({ top, left, placement });
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
    const onPointerDown = (e: PointerEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, place]);

  const triggerHandlers = hoverCapable
    ? {
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
      }
    : {
        onClick: () => setOpen((v) => !v),
      };

  return (
    <span className="vp-infotip">
      <button
        ref={triggerRef}
        type="button"
        className="vp-infotip-btn"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        {...triggerHandlers}
      >
        <Icon name="info" size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={`vp-infotip-bubble${coords ? ` is-${coords.placement}` : ''}`}
            style={
              coords
                ? { top: coords.top, left: coords.left, visibility: 'visible' }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
          >
            {title && <span className="vp-infotip-title">{title}</span>}
            <span className="vp-infotip-body">{children}</span>
          </div>,
          document.body,
        )}
    </span>
  );
}
