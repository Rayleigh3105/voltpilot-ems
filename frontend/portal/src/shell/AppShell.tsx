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
  MODE_PAGES,
  PLATFORM_PAGES,
  PORTFOLIO_PAGE,
  pageLabel,
  type PageId,
} from '../nav';
import type { AnlageArea, AnlageAreaKey, ModeNavGroup } from '../anlageNav';
import type { AnlagenSub } from '../nav';

/**
 * The Anlage-scoped shell navigation (M1 #529): the context switcher + the
 * trio `Übersicht · Steuerung · Geräte` + the mode-tagged knowledge group.
 * Present whenever exactly one Anlage is in scope; null otherwise (fleet list,
 * Portfolio, Plattform pages) — the shell then renders as before.
 */
export interface AnlageNav {
  /** The Anlage in scope (the static label / the switcher's current value). */
  siteId: string;
  siteName: string;
  /** All Anlagen of the tenant; 2+ turn the label into a real switcher. */
  sites: { id: string; name: string }[];
  onSelectSite: (siteId: string) => void;
  /** The trio, with Steuerung's active-mode badge (see `anlageTrio`). */
  trio: AnlageArea[];
  /** Which trio entry is current; null while a deep view is open. */
  activeArea: AnlageAreaKey | null;
  onOpenArea: (sub: AnlagenSub | null) => void;
  /** Mode-scoped sidebar group (market mode only); null = hidden. */
  modeGroup: ModeNavGroup | null;
}

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

  // Close the mobile drawer whenever navigation happens.
  useEffect(() => {
    setMobileNav(false);
  }, [page]);

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

  const openArea = (sub: AnlagenSub | null) => {
    anlage?.onOpenArea(sub);
    setMobileNav(false);
  };

  /**
   * M1: the Anlage context + trio + the mode-tagged knowledge group. Rendered
   * INSIDE the sidebar nav, directly under the main pages, so the customer's
   * "where am I" (the Anlage) and "what can I do here" (the three areas) sit
   * together. Fleets get a real switcher; a single-Anlage customer a calm
   * static label (there is nothing to switch to).
   */
  const anlageNav = anlage && (
    <div className="vp-anlagenav">
      <div className="vp-anlagenav-ctx">
        {anlage.sites.length > 1 ? (
          <span className="vp-anlagenav-switch" title="Anlage wechseln">
            <Icon name="sun" size={16} className="vp-anlagenav-ic" />
            <select
              aria-label="Anlage wählen"
              value={anlage.siteId}
              onChange={(e) => {
                anlage.onSelectSite(e.target.value);
                setMobileNav(false);
              }}
            >
              {anlage.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" size={16} className="vp-anlagenav-caret" />
          </span>
        ) : (
          <span className="vp-anlagenav-label">
            <Icon name="sun" size={16} className="vp-anlagenav-ic" />
            <span className="t">{anlage.siteName}</span>
          </span>
        )}
      </div>
      {anlage.trio.map((a) => (
        <NavItem
          key={a.key}
          icon={<Icon name={a.icon} size={18} />}
          label={a.label}
          count={a.badge}
          active={anlage.activeArea === a.key}
          onClick={() => openArea(a.sub)}
        />
      ))}
      {anlage.modeGroup && (
        <>
          <div className="vp-nav-group-label">{anlage.modeGroup.title}</div>
          {anlage.modeGroup.pages.map((id) => {
            const def = MODE_PAGES.find((p) => p.id === id);
            if (!def) return null;
            return (
              <NavItem
                key={def.id}
                icon={<Icon name={def.icon} size={18} />}
                label={def.label}
                active={page === def.id}
                onClick={() => navigate(def.id)}
              />
            );
          })}
        </>
      )}
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
            label={PORTFOLIO_PAGE.label}
            active={page === PORTFOLIO_PAGE.id}
            onClick={() => navigate(PORTFOLIO_PAGE.id)}
          />
        )}
        {MAIN_PAGES.filter((p) => p.id !== 'uebersicht' || showOverview).map((p) => (
          <NavItem
            key={p.id}
            icon={<Icon name={p.icon} size={18} />}
            label={p.id === 'anlagen' ? anlagenLabel(counts.sites) : p.label}
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
            <div className="vp-nav-group-label">Plattform</div>
            {PLATFORM_PAGES.map((p) => (
              <NavItem
                key={p.id}
                icon={<Icon name={p.icon} size={18} />}
                label={p.label}
                active={page === p.id}
                count={p.id === 'mandanten' && tenants.length ? tenants.length : null}
                onClick={() => navigate(p.id)}
              />
            ))}
          </>
        )}
      </nav>
      <div className="side-foot">
        <p className="vp-note" style={{ margin: 0, padding: '0 var(--vp-space-3)' }}>
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
        // M1: the trio as an app-like bottom bar on phones (report §2.1) - the
        // three core areas of an Anlage must never hide behind the hamburger.
        // Hidden above 720px by CSS; the sidebar carries it there.
        <nav className="vp-bottombar" aria-label={`Bereiche der Anlage ${anlage.siteName}`}>
          {anlage.trio.map((a) => (
            <button
              key={a.key}
              type="button"
              className={`vp-bottombar-item${anlage.activeArea === a.key ? ' active' : ''}`}
              aria-current={anlage.activeArea === a.key ? 'page' : undefined}
              onClick={() => openArea(a.sub)}
            >
              <span className="ic" aria-hidden="true">
                <Icon name={a.icon} size={20} />
                {a.badge != null && <span className="vp-bottombar-badge">{a.badge}</span>}
              </span>
              <span className="lbl">{a.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
