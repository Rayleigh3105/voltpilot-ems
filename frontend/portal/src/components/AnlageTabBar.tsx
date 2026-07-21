import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../designsystem/components/core/Icon';
import { api, type Betriebsart } from '../api';
import { navFor } from '../adaptiveNav';
import { hasTopology } from '../adaptiveLive';
import type { AnlagenSub } from '../nav';

/**
 * U1: the persistent per-Anlage tab bar (design vp-ems-ui-overhaul §5.1/§5.2).
 * Sits directly under the Anlage header and hosts the SAME AnlagenSub routes
 * (no route change - it just navigates), so Geräte + Steuerung become
 * first-class tabs instead of scroll-down cards. The tab ORDER is derived from
 * the site's usage profile via `navFor` (the AE7-consumer pattern); overflow
 * subs live behind a "Mehr ▾" menu but stay one click away.
 *
 * The bar is rendered ABOVE the cockpit/subpage switch in AnlagenPage, so it
 * does NOT remount when the customer moves between subpages of the same Anlage:
 * the profile is fetched once per site visit and the order never re-flickers
 * mid-session. On a real site switch the effect refetches.
 *
 * Sticky + horizontally scrollable on phone; the "Mehr ▾" menu portals to
 * document.body so the bar's own `overflow-x` never clips it.
 */
export function AnlageTabBar({
  siteId,
  siteName,
  activeSub,
  betriebsart,
  onOpen,
}: {
  siteId: string;
  siteName?: string;
  /** The currently open sub (null = the cockpit / Übersicht). */
  activeSub: AnlagenSub | null;
  betriebsart: Betriebsart | null;
  onOpen: (sub: AnlagenSub | null) => void;
}) {
  const [profile, setProfile] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(false);

  // Fetch the effective usage profile + the migration signal once per site
  // (fail-soft → the v1-safe default order). Not re-polled: the order must be
  // stable per visit. The profile deriver never returns null, so the per-face
  // orders are gated on the site ACTUALLY carrying v2 entities (MEDIUM-3) -
  // otherwise a v1 site would lead with an empty "Geräte" tab.
  useEffect(() => {
    let active = true;
    setProfile(null);
    setMigrated(false);
    api.usageProfile(siteId).then(
      (p) => {
        if (active) setProfile(p.usageProfile);
      },
      () => {
        /* no profile (un-migrated site / error) → default order */
      },
    );
    api.topology(siteId).then(
      (t) => {
        if (active) setMigrated(hasTopology(t));
      },
      () => {
        /* no topology (v1 site / error) → default order */
      },
    );
    return () => {
      active = false;
    };
  }, [siteId]);

  const tabs = navFor(profile, betriebsart, migrated);
  const visible = tabs.filter((t) => !t.overflow);
  const overflow = tabs.filter((t) => t.overflow);
  const activeInOverflow = overflow.some((t) => t.sub === activeSub);

  const [menuOpen, setMenuOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const btn = moreRef.current;
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
    if (menuOpen) place();
  }, [menuOpen, place]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const reposition = () => place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, place]);

  const open = (sub: AnlagenSub | null) => {
    setMenuOpen(false);
    onOpen(sub);
  };

  return (
    <nav
      className="vp-anlage-tabs"
      aria-label={siteName ? `Bereiche der Anlage ${siteName}` : 'Anlagen-Bereiche'}
    >
      <div className="vp-anlage-tabs-scroll">
        {visible.map((t) => (
          <button
            key={t.sub ?? 'uebersicht'}
            type="button"
            className={`vp-anlage-tab${t.sub === activeSub ? ' active' : ''}`}
            aria-current={t.sub === activeSub ? 'page' : undefined}
            onClick={() => open(t.sub)}
          >
            <Icon name={t.icon} size={16} />
            <span>{t.label}</span>
          </button>
        ))}
        {overflow.length > 0 && (
          <button
            ref={moreRef}
            type="button"
            className={`vp-anlage-tab vp-anlage-more${activeInOverflow ? ' active' : ''}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span>Mehr</span>
            <Icon name="chevron-down" size={16} />
          </button>
        )}
      </div>

      {menuOpen &&
        createPortal(
          <>
            <div className="vp-rowmenu-scrim" onClick={() => setMenuOpen(false)} />
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
              {overflow.map((t) => (
                <button
                  key={t.sub ?? 'uebersicht'}
                  type="button"
                  role="menuitem"
                  className={t.sub === activeSub ? 'active' : undefined}
                  onClick={() => open(t.sub)}
                >
                  <Icon name={t.icon} size={16} />
                  {t.label}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </nav>
  );
}
