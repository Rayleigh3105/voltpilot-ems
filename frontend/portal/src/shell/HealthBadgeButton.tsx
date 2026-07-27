import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import type { HealthBadge } from '../health';

/**
 * The top bar's aggregated plant state — a REAL control, not a hover tooltip.
 *
 * The rule this implements: **a warning must always name its cause and be
 * reachable in one click.** Before this the badge was a plain `<span>` whose
 * only channel for the cause was a `title=` attribute — undiscoverable, and
 * effectively invisible on touch, which the shell explicitly targets. So:
 *
 *  - the worst cause renders as VISIBLE text next to the label (`title` stays
 *    as a bonus for a truncated width, never as the only channel);
 *  - the badge is a `<button>` opening a popover that lists EVERY current
 *    finding — one tap on a phone, Enter/Space + Escape on a keyboard;
 *  - the popover is rendered into `document.body` at fixed, viewport-clamped
 *    coordinates (the documented InfoTip/RowMenu escape-the-clip pattern), so
 *    it is never cut off by the top bar or a card.
 *
 * It invents nothing: the findings come from `healthBadge()`, which drops
 * every row whose fact the caller did not supply.
 */
export function HealthBadgeButton({
  health,
  onOpenDetail,
}: {
  health: HealthBadge;
  /** Opens the plant's health surface (its cockpit); null = no drill target. */
  onOpenDetail?: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const pop = popRef.current;
    if (!trigger || !pop) return;
    const rect = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const margin = 12;
    const gap = 8;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - pw / 2, vw - pw - margin));
    let top = rect.bottom + gap;
    if (top + ph > vh - margin && rect.top - gap - ph > margin) top = rect.top - gap - ph;
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popRef.current?.contains(target)) return;
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

  const cause = health.detail;
  // The accessible name carries state AND cause, so a screen reader hears what
  // the sighted customer reads — never just the word "Warnung".
  const ariaLabel = `Zustand der Anlage: ${health.label}${cause ? ` – ${cause}` : ''}. Details anzeigen`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`vp-healthbadge state-${health.state}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        title={cause ?? health.label}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="vp-health-dot" aria-hidden="true" />
        <span className="vp-healthbadge-lbl">{health.label}</span>
        {cause && <span className="vp-healthbadge-cause">{cause}</span>}
        <Icon name="chevron-down" size={14} className="vp-healthbadge-caret" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={id}
            role="dialog"
            aria-label="Zustand der Anlage"
            className="vp-healthpop"
            style={
              coords
                ? { top: coords.top, left: coords.left, visibility: 'visible' }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
          >
            <span className="vp-healthpop-title">Zustand der Anlage</span>
            {health.findings.length === 0 ? (
              <p className="vp-healthpop-ok">Alles in Ordnung – nichts zu melden.</p>
            ) : (
              <ul className="vp-healthpop-list">
                {health.findings.map((f) => (
                  <li key={f.text} className={`vp-healthpop-item tone-${f.state}`}>
                    <span className="vp-healthpop-mark" aria-hidden="true">
                      {f.state === 'warn' ? '!' : '–'}
                    </span>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ul>
            )}
            {onOpenDetail && (
              <button
                type="button"
                className="vp-healthpop-link"
                onClick={() => {
                  setOpen(false);
                  onOpenDetail();
                }}
              >
                Zur Anlage
                <Icon name="chevron-right" size={14} />
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
