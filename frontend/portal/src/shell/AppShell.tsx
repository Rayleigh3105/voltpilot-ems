import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { NavItem } from '../../designsystem/components/shell/NavItem';
import logoUrl from '../../designsystem/assets/voltpilot-logo.png';
import { currentUser, logout } from '../auth';
import type { Tenant } from '../admin/adminApi';
import {
  anlagenLabel,
  MAIN_PAGES,
  PLATFORM_PAGES,
  PORTFOLIO_PAGE,
  pageLabel,
  type PageId,
} from '../nav';
import {
  bottomBarSlots,
  HELP_TEXT,
  moreSheetItems,
  type AnlageSidebar,
  type NavTarget,
  type SidebarGroup,
  type SidebarItem,
} from '../anlageNav';
import type { HealthBadge } from '../health';
import type { AnlagenSub } from '../nav';
import './Shell.css';

/**
 * Portal v3 · M1 — the Anlage-scoped shell navigation: the Anlage context card
 * (name + health line, tap = switcher, "Alle Anlagen" → the fleet), the grouped
 * sidebar (base group + one coloured group per active mode), the foot
 * (Einstellungen · Hilfe & Kontakt), the phone 5-slot bottom bar with its Mehr
 * sheet — and the aggregated health badge in the top bar.
 * Present whenever exactly one Anlage is in scope; null otherwise (fleet list,
 * Portfolio, Plattform pages) — the shell then renders as before.
 */
export interface AnlageNav {
  /** The Anlage in scope (the switcher's current value). */
  siteId: string;
  siteName: string;
  /** All Anlagen of the tenant; 2+ turn the label into a real switcher. */
  sites: { id: string; name: string }[];
  onSelectSite: (siteId: string) => void;
  /** The grouped sidebar model (`anlageSidebar`), never re-derived here. */
  sidebar: AnlageSidebar;
  /** Which entry is current (`activeAreaKey` / `activeKeyForPage`). */
  activeKey: string | null;
  onOpenSub: (sub: AnlagenSub | null) => void;
  onOpenPage: (page: PageId) => void;
  /** "Alle Anlagen" — back to the fleet/portfolio landing; null = hidden. */
  onOpenFleet: (() => void) | null;
  /** The aggregated plant state; null = not known yet (no badge is shown). */
  health: HealthBadge | null;
}

/** The value the Anlage switcher uses for its "Alle Anlagen" option. */
const ALL_SITES = '__all__';

/**
 * The unified dashboard shell: left sidebar (primary navigation, identical for
 * both roles; Portal-Admins additively get the "Plattform" group), top bar
 * (breadcrumb, tenant context, user menu) and the main content area.
 * Collapses to a hamburger drawer below 1024px — EXCEPT the Anlage trio, which
 * becomes an app-like bottom bar on phones (M1): the three core areas never
 * hide behind a hamburger.
 */
export function AppShell({
  page,
  onNavigate,
  isAdmin,
  showOverview,
  showPortfolio,
  showAddAnlage,
  onAddAnlage,
  counts,
  tenants,
  tenantOverride,
  onTenantChange,
  anlage = null,
  children,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  isAdmin: boolean;
  /** Show the "Übersicht" nav item (fleet customers + admins only). */
  showOverview: boolean;
  /**
   * Show the "Portfolio" nav item + land on it (Betreiber shell, U5). Replaces
   * "Übersicht" for a betreiber frame (showOverview is then false).
   */
  showPortfolio: boolean;
  /**
   * Show the always-visible "＋ Anlage hinzufügen" header action. Scoped to a
   * single-Anlage customer (see `showAddAnlageButton`) - their only obvious way
   * to a second Anlage, reachable from every page.
   */
  showAddAnlage: boolean;
  /** Open the "Anlage anlegen" one-flow drawer (hosted by the caller). */
  onAddAnlage: () => void;
  counts: { sites: number | null; devices: number | null };
  /** Admin only: tenants for the context switcher. */
  tenants: Tenant[];
  /** Admin only: the selected tenant id ('' = Alle Mandanten). */
  tenantOverride: string | null;
  onTenantChange: (tenantId: string | null) => void;
  /** M1: the Anlage-scoped nav (trio + context + mode group); null = none. */
  anlage?: AnlageNav | null;
  children: React.ReactNode;
}) {
  const user = currentUser();
  const [mobileNav, setMobileNav] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Close the mobile drawer + sheets whenever navigation happens.
  useEffect(() => {
    setMobileNav(false);
    setMoreOpen(false);
  }, [page]);

  // Escape closes the phone sheet / the Hilfe panel.
  useEffect(() => {
    if (!moreOpen && !helpOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMoreOpen(false);
      setHelpOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [moreOpen, helpOpen]);

  // While the mobile nav is open: lock body scroll and close on Escape.
  useEffect(() => {
    if (!mobileNav) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNav(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileNav]);

  const initials = (user.name || 'VP')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const navigate = (id: PageId) => {
    onNavigate(id);
    setMobileNav(false);
  };

  /**
   * ONE place that turns a nav target into navigation — the sidebar, the
   * bottom bar and the Mehr sheet all go through it, so they can never drift.
   */
  const openTarget = (target: NavTarget) => {
    setMobileNav(false);
    switch (target.kind) {
      case 'sub':
        anlage?.onOpenSub(target.sub);
        setMoreOpen(false);
        return;
      case 'page':
        anlage?.onOpenPage(target.page);
        setMoreOpen(false);
        return;
      case 'help':
        setMoreOpen(false);
        setHelpOpen(true);
        return;
      case 'more':
      default:
        setMoreOpen((v) => !v);
    }
  };

  const navEntry = (item: SidebarItem) => (
    <NavItem
      key={item.key}
      icon={<Icon name={item.icon} size={18} />}
      // The label is wrapped so the tablet icon rail can hide it in CSS while
      // the accessible name (and the tooltip) stay intact.
      label={<span className="vp-nav-lbl">{item.label}</span>}
      count={item.badge}
      active={anlage?.activeKey === item.key}
      title={item.label}
      onClick={() => openTarget(item.target)}
    />
  );

  const navGroup = (group: SidebarGroup) => (
    <div className="vp-navgroup" key={group.key}>
      <div className={`vp-nav-group-label${group.tone ? ` tone-${group.tone}` : ''}`}>
        {group.tone && <span className="vp-mode-dot" aria-hidden="true" />}
        <span className="vp-nav-lbl">{group.label}</span>
      </div>
      {group.items.map(navEntry)}
    </div>
  );

  /**
   * The Anlage context card: which plant am I looking at, and is it healthy.
   * A fleet gets a real switcher (plus "Alle Anlagen" back to the fleet
   * landing); a single-Anlage customer a calm static label.
   */
  const anlageNav = anlage && (
    <div className="vp-anlagenav">
      <div className="vp-anlagenav-ctx">
        {anlage.sites.length > 1 || anlage.onOpenFleet ? (
          <span className="vp-anlagenav-switch" title="Anlage wechseln">
            <Icon name="sun" size={16} className="vp-anlagenav-ic" />
            <span className="vp-anlagenav-body">
              <select
                aria-label="Anlage wählen"
                value={anlage.siteId}
                onChange={(e) => {
                  setMobileNav(false);
                  if (e.target.value === ALL_SITES) anlage.onOpenFleet?.();
                  else anlage.onSelectSite(e.target.value);
                }}
              >
                {anlage.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {anlage.onOpenFleet && <option value={ALL_SITES}>Alle Anlagen</option>}
              </select>
              {anlage.health && (
                <span className={`vp-anlagenav-health state-${anlage.health.state}`}>
                  <span className="vp-health-dot" aria-hidden="true" />
                  {anlage.health.label}
                </span>
              )}
            </span>
            <Icon name="chevron-down" size={16} className="vp-anlagenav-caret" />
          </span>
        ) : (
          <span className="vp-anlagenav-label">
            <Icon name="sun" size={16} className="vp-anlagenav-ic" />
            <span className="vp-anlagenav-body">
              <span className="t">{anlage.siteName}</span>
              {anlage.health && (
                <span className={`vp-anlagenav-health state-${anlage.health.state}`}>
                  <span className="vp-health-dot" aria-hidden="true" />
                  {anlage.health.label}
                </span>
              )}
            </span>
          </span>
        )}
      </div>
      {anlage.sidebar.groups.map(navGroup)}
    </div>
  );

  const sidebar = (
    <aside className={`vp-sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <div className="brand">
        <img src={logoUrl} alt="VoltPilot EMS" />
        {/* A slide-over needs a visible way out - the veil tap and the
            hamburger stay, but neither is discoverable (G10). Phone-only
            (CSS hides it once the sidebar is permanent). */}
        <button
          type="button"
          className="vp-sidebar-close"
          aria-label="Menü schließen"
          onClick={() => setMobileNav(false)}
        >
          <Icon name="x" size={22} />
        </button>
      </div>
      <nav aria-label="Hauptnavigation">
        {showPortfolio && (
          // Betreiber shell (U5): Portfolio leads the sidebar, in place of the
          // (hidden) Übersicht item.
          <NavItem
            icon={<Icon name={PORTFOLIO_PAGE.icon} size={18} />}
            label={<span className="vp-nav-lbl">{PORTFOLIO_PAGE.label}</span>}
            title={PORTFOLIO_PAGE.label}
            active={page === PORTFOLIO_PAGE.id}
            onClick={() => navigate(PORTFOLIO_PAGE.id)}
          />
        )}
        {MAIN_PAGES.filter((p) => p.id !== 'uebersicht' || showOverview).map((p) => (
          <NavItem
            key={p.id}
            icon={<Icon name={p.icon} size={18} />}
            label={
              <span className="vp-nav-lbl">
                {p.id === 'anlagen' ? anlagenLabel(counts.sites) : p.label}
              </span>
            }
            title={p.id === 'anlagen' ? anlagenLabel(counts.sites) : p.label}
            active={page === p.id}
            count={
              // "Meine Anlagen" carries the fleet size; a single Anlage needs
              // no number - it IS the page.
              p.id === 'anlagen' && counts.sites != null && counts.sites > 1
                ? counts.sites
                : null
            }
            onClick={() => navigate(p.id)}
          />
        ))}
        {anlageNav}
        {isAdmin && (
          <>
            <div className="vp-nav-group-label">
              <span className="vp-nav-lbl">Plattform</span>
            </div>
            {PLATFORM_PAGES.map((p) => (
              <NavItem
                key={p.id}
                icon={<Icon name={p.icon} size={18} />}
                label={<span className="vp-nav-lbl">{p.label}</span>}
                title={p.label}
                active={page === p.id}
                count={p.id === 'mandanten' && tenants.length ? tenants.length : null}
                onClick={() => navigate(p.id)}
              />
            ))}
          </>
        )}
      </nav>
      <div className="side-foot">
        {anlage && anlage.sidebar.foot.map(navEntry)}
        <p className="vp-note vp-nav-lbl" style={{ margin: 0, padding: '0 var(--vp-space-3)' }}>
          VoltPilot EMS
        </p>
      </div>
    </aside>
  );

  return (
    <div className="vp-app">
      {sidebar}
      {mobileNav && (
        <div className="vp-mobilenav-scrim" onClick={() => setMobileNav(false)} aria-hidden="true" />
      )}

      <div className="vp-content">
        <header className="vp-topbar">
          <button
            type="button"
            className="vp-hamburger"
            aria-label={mobileNav ? 'Menü schließen' : 'Menü öffnen'}
            aria-expanded={mobileNav}
            onClick={() => setMobileNav((v) => !v)}
          >
            <Icon name={mobileNav ? 'x' : 'menu'} size={22} />
          </button>
          <div className="crumbs">
            {/* On an Anlage page the breadcrumb names the ANLAGE, not the menu
                item ("Hof Lindenberg", not "Meine Anlagen") - that is what the
                customer is looking at, and it is usually shorter (G1). The
                full text stays in the title for a truncated phone width. */}
            <span className="here" title={anlage ? anlage.siteName : undefined}>
              {anlage ? anlage.siteName : pageLabel(page, counts.sites)}
            </span>
          </div>
          {anlage?.health && (
            // ONE aggregated plant state, always in sight (concept tab 2). The
            // title names the worst finding, so it says WHAT is wrong.
            <span
              className={`vp-healthbadge state-${anlage.health.state}`}
              title={anlage.health.detail ?? anlage.health.label}
            >
              <span className="vp-health-dot" aria-hidden="true" />
              <span className="vp-healthbadge-lbl">{anlage.health.label}</span>
            </span>
          )}
          <div className="spacer" />

          {showAddAnlage && (
            // The single-Anlage customer's always-visible way to a second
            // Anlage. Icon + label on wider screens, icon-only on phones (the
            // aria-label keeps it accessible). Opens the same one-flow drawer.
            <Button
              variant="primary"
              size="sm"
              className="vp-add-anlage-btn"
              iconLeft={<Icon name="plus" size={18} />}
              onClick={onAddAnlage}
              aria-label="Anlage hinzufügen"
            >
              <span className="vp-add-anlage-label">Anlage hinzufügen</span>
            </Button>
          )}

          {isAdmin && (
            // Admin: the context chip is a real tenant SWITCHER - the operator's
            // core cross-tenant tool. Picking a tenant renders the customer
            // pages for that tenant (RLS-scoped via the X-Tenant-Id header, see
            // api.ts). The leading building icon + trailing caret make it
            // unmistakably THE Mandanten control and clearly a dropdown.
            // Customers get no chip: their tenant is fixed by the login.
            <span className="vp-context" title="Mandanten-Kontext wechseln">
              <Icon name="building" size={16} className="vp-context-ic" />
              <select
                aria-label="Mandanten-Kontext"
                value={tenantOverride ?? ''}
                onChange={(e) => onTenantChange(e.target.value || null)}
              >
                <option value="">Alle Mandanten</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={16} className="vp-context-caret" />
            </span>
          )}

          <div className="vp-usermenu">
            <div className="meta">
              <div className="n">
                {user.name}{' '}
                {isAdmin && (
                  <Badge variant="solid" style={{ fontSize: '0.62rem', verticalAlign: 'middle' }}>
                    ADMIN
                  </Badge>
                )}
              </div>
              {user.email && user.email !== user.name && <div className="e">{user.email}</div>}
            </div>
            <span className="vp-avatar" title={user.name}>
              {initials}
            </span>
            {/* Icon + word on wider screens, icon-only on a phone so the
                breadcrumb keeps its room (G1). The aria-label keeps it
                accessible either way. */}
            <Button
              variant="ghost"
              size="sm"
              className="vp-logout-btn"
              onClick={logout}
              aria-label="Abmelden"
              title="Abmelden"
              iconLeft={<Icon name="log-out" size={18} />}
            >
              <span className="vp-logout-label">Abmelden</span>
            </Button>
          </div>
        </header>

        <main className={`vp-main${anlage ? ' has-bottombar' : ''}`}>{children}</main>
      </div>

      {anlage && (
        // v3 M1: the app-like 5-slot bottom bar on phones (concept tab 2) -
        // Cockpit · Live · Steuerung · Anlage · Mehr. The core areas of an
        // Anlage must never hide behind a hamburger; "Mehr" opens the sheet
        // with everything else. Hidden above 720px by CSS.
        <nav className="vp-bottombar" aria-label={`Bereiche der Anlage ${anlage.siteName}`}>
          {bottomBarSlots(anlage.sidebar).map((item) => {
            const active =
              item.target.kind === 'more' ? moreOpen : anlage.activeKey === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`vp-bottombar-item${active ? ' active' : ''}`}
                aria-current={item.target.kind !== 'more' && active ? 'page' : undefined}
                aria-expanded={item.target.kind === 'more' ? moreOpen : undefined}
                onClick={() => openTarget(item.target)}
              >
                <span className="ic" aria-hidden="true">
                  <Icon name={item.icon} size={20} />
                  {item.badge != null && <span className="vp-bottombar-badge">{item.badge}</span>}
                </span>
                <span className="lbl">{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {anlage && moreOpen && (
        // The "Mehr" sheet: every remaining area, grouped and colour-tagged
        // exactly like the sidebar - nothing is hidden, only folded away.
        <>
          <div className="vp-sheet-scrim" onClick={() => setMoreOpen(false)} aria-hidden="true" />
          <div className="vp-sheet" role="dialog" aria-label="Weitere Bereiche">
            <div className="vp-sheet-head">
              <span>Weitere Bereiche</span>
              <button type="button" aria-label="Schließen" onClick={() => setMoreOpen(false)}>
                <Icon name="x" size={20} />
              </button>
            </div>
            {moreSheetItems(anlage.sidebar).map((group) => (
              <div className="vp-sheet-group" key={group.key}>
                <div className={`vp-nav-group-label${group.tone ? ` tone-${group.tone}` : ''}`}>
                  {group.tone && <span className="vp-mode-dot" aria-hidden="true" />}
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`vp-sheet-item${anlage.activeKey === item.key ? ' active' : ''}`}
                    onClick={() => openTarget(item.target)}
                  >
                    <Icon name={item.icon} size={18} />
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {helpOpen && (
        // Hilfe & Kontakt: an honest sentence, not an invented support address
        // (the platform has no self-service channel - see HELP_TEXT).
        <>
          <div className="vp-sheet-scrim" onClick={() => setHelpOpen(false)} aria-hidden="true" />
          <div className="vp-helppanel" role="dialog" aria-label="Hilfe & Kontakt">
            <div className="vp-sheet-head">
              <span>Hilfe &amp; Kontakt</span>
              <button type="button" aria-label="Schließen" onClick={() => setHelpOpen(false)}>
                <Icon name="x" size={20} />
              </button>
            </div>
            <p>{HELP_TEXT}</p>
          </div>
        </>
      )}
    </div>
  );
}
