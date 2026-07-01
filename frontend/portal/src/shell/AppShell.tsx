import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import { Badge } from '../../designsystem/components/core/Badge';
import { Icon } from '../../designsystem/components/core/Icon';
import { NavItem } from '../../designsystem/components/shell/NavItem';
import logoUrl from '../../designsystem/assets/voltpilot-logo.png';
import { currentUser, logout } from '../auth';
import type { Tenant } from '../admin/adminApi';
import { MAIN_PAGES, PLATFORM_PAGES, pageLabel, type PageId } from '../nav';

/**
 * The unified dashboard shell: left sidebar (primary navigation, identical for
 * both roles; Portal-Admins additively get the "Plattform" group), top bar
 * (breadcrumb, tenant context, user menu) and the main content area.
 * Collapses to a hamburger drawer below 1024px.
 */
export function AppShell({
  page,
  onNavigate,
  isAdmin,
  counts,
  tenants,
  tenantOverride,
  onTenantChange,
  children,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
  isAdmin: boolean;
  counts: { sites: number | null; devices: number | null };
  /** Admin only: tenants for the context switcher. */
  tenants: Tenant[];
  /** Admin only: the selected tenant id ('' = Alle Mandanten). */
  tenantOverride: string | null;
  onTenantChange: (tenantId: string | null) => void;
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

  const sidebar = (
    <aside className={`vp-sidebar ${mobileNav ? 'mobile-open' : ''}`}>
      <div className="brand">
        <img src={logoUrl} alt="VoltPilot EMS" />
      </div>
      <nav aria-label="Hauptnavigation">
        {MAIN_PAGES.map((p) => (
          <NavItem
            key={p.id}
            icon={<Icon name={p.icon} size={18} />}
            label={p.label}
            active={page === p.id}
            count={
              p.id === 'standorte' && counts.sites != null
                ? counts.sites
                : p.id === 'geraete' && counts.devices != null
                  ? counts.devices
                  : null
            }
            onClick={() => navigate(p.id)}
          />
        ))}
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
            <span className="here">{pageLabel(page)}</span>
          </div>
          <div className="spacer" />

          {isAdmin && (
            // Admin: the context chip is a real tenant SWITCHER - picking a
            // tenant renders the customer pages for that tenant (RLS-scoped
            // via the X-Tenant-Id header, see api.ts). Customers get no chip:
            // their tenant is fixed by the login, a badge would add nothing.
            <span className="vp-context" title="Mandanten-Kontext wechseln">
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
              {user.email && <div className="e">{user.email}</div>}
            </div>
            <span className="vp-avatar" title={user.name}>
              {initials}
            </span>
            <Button variant="ghost" size="sm" onClick={logout}>
              Abmelden
            </Button>
          </div>
        </header>

        <main className="vp-main">{children}</main>
      </div>
    </div>
  );
}
