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
  PLATFORM_GROUPS,
  PORTFOLIO_PAGE,
  PORTFOLIO_WELT_PAGES,
  pageLabel,
  type PageId,
} from '../nav';
import {
  bottomBarSlots,
  fleetBarSlots,
  fleetSheetGroups,
  HELP_TEXT,
  moreSheetItems,
  type AnlageSidebar,
  type FleetNavInput,
  type NavTarget,
  type SidebarGroup,
  type SidebarItem,
} from '../anlageNav';
import type { HealthBadge } from '../health';
import type { AnlagenSub } from '../nav';
import { HealthBadgeButton } from './HealthBadgeButton';
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
  showPortfolioErloese = false,
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
   * Show the "Erlöse" entry of the Portfolio-Historie group (PR G): only when
   * at least one Anlage has a money mode - a purely private fleet gets no
   * Erlöse page instead of one that explains nothing. Ignored while
   * `showPortfolio` is false.
   */
  showPortfolioErloese?: boolean;
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Close the sheet whenever navigation happens.
  useEffect(() => {
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

  const initials = (user.name || 'VP')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  /**
   * ONE place that turns a nav target into navigation — the sidebar, both
   * bottom bars and the Mehr sheet all go through it, so they can never drift.
   */
  const openTarget = (target: NavTarget) => {
    switch (target.kind) {
      case 'sub':
        anlage?.onOpenSub(target.sub);
        setMoreOpen(false);
        return;
      case 'page':
        // Inside an Anlage the page jump keeps its Anlage context; at fleet
        // level there is none, so the plain shell navigation carries it.
        if (anlage) anlage.onOpenPage(target.page);
        else onNavigate(target.page);
        setMoreOpen(false);
        return;
      case 'help':
        setMoreOpen(false);
        setHelpOpen(true);
        return;
      case 'action':
        setMoreOpen(false);
        if (target.action === 'add-anlage') onAddAnlage();
        else logout();
        return;
      case 'more':
      default:
        setMoreOpen((v) => !v);
    }
  };

  /**
   * The phone bar + sheet of the level the customer is on: one Anlage, or the
   * fleet above it. Both are derived (`anlageNav.ts`) — the shell only renders.
   */
  const fleetNav: FleetNavInput = {
    showPortfolio,
    showPortfolioErloese,
    showOverview,
    siteCount: counts.sites,
  };
  const barSlots = anlage ? bottomBarSlots(anlage.sidebar) : fleetBarSlots(fleetNav);
  const sheetGroups = anlage
    ? moreSheetItems(anlage.sidebar, { isAdmin, showAddAnlage })
    : fleetSheetGroups(fleetNav, { isAdmin, showAddAnlage });
  const barLabel = anlage ? `Bereiche der Anlage ${anlage.siteName}` : 'Hauptbereiche';
  /** 2+ Anlagen or a fleet level to return to = there is something to switch. */
  const canSwitchAnlage = !!anlage && (anlage.sites.length > 1 || !!anlage.onOpenFleet);

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
    // Desktop (>=1024px) and the tablet icon rail (721-1023px) are unchanged.
    // The phone slide-over is GONE since Mobil-Umbau Stufe 1: the bottom bar
    // plus its Mehr sheet cover every destination, so a second menu (and its
    // hamburger) would only compete with the thumb pattern.
    <aside className="vp-sidebar">
      <div className="brand">
        <img src={logoUrl} alt="VoltPilot EMS" />
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
            onClick={() => onNavigate(PORTFOLIO_PAGE.id)}
          />
        )}
        {showPortfolio && (
          // PR G: die zwei Historie-Welten EINE EBENE HÖHER. Sie stehen als
          // eigene Gruppe unter der Portfolio-Landung, damit „Messwerte" hier
          // nie mit der gleichnamigen Ansicht EINER Anlage verwechselt wird -
          // die Gruppenüberschrift sagt, worüber sie sprechen.
          <div className="vp-navgroup">
            <div className="vp-nav-group-label">
              <span className="vp-nav-lbl">Alle Anlagen</span>
            </div>
            {PORTFOLIO_WELT_PAGES.filter(
              (p) => p.id !== 'portfolio-erloese' || showPortfolioErloese,
            ).map((p) => (
              <NavItem
                key={p.id}
                icon={<Icon name={p.icon} size={18} />}
                label={<span className="vp-nav-lbl">{p.label}</span>}
                title={p.label}
                active={page === p.id}
                onClick={() => onNavigate(p.id)}
              />
            ))}
          </div>
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
            onClick={() => onNavigate(p.id)}
          />
        ))}
        {anlageNav}
        {isAdmin && (
          // Admin-Umbau Stufe 1 „Ordnung": die elf flachen Punkte sind vier
          // benannte Gruppen hinter der LANDUNG (Plattform-Übersicht). Die
          // Gruppierung ist reine Präsentation - keine Route ändert sich, und
          // die Reihenfolge erzählt jetzt die Arbeit statt der Baugeschichte.
          <>
            <div className="vp-nav-group-label">
              <span className="vp-nav-lbl">Plattform</span>
            </div>
            {PLATFORM_GROUPS.map((group) => (
              <div className="vp-navgroup" key={group.key}>
                {/* Die Landung trägt keine eigene Überschrift - sie steht schon
                    unter „Plattform" und braucht keine zweite Zeile. */}
                {group.label && (
                  <div className="vp-nav-group-label vp-nav-sublabel">
                    <span className="vp-nav-lbl">{group.label}</span>
                  </div>
                )}
                {group.pages.map((p) => (
                  <NavItem
                    key={p.id}
                    icon={<Icon name={p.icon} size={18} />}
                    label={<span className="vp-nav-lbl">{p.label}</span>}
                    title={p.label}
                    active={page === p.id}
                    count={p.id === 'mandanten' && tenants.length ? tenants.length : null}
                    onClick={() => onNavigate(p.id)}
                  />
                ))}
              </div>
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

      <div className="vp-content">
        <header className="vp-topbar">
          {/* Breadcrumb + plant state. On a phone (Stufe 1) this block becomes
              the plant identity: name as a tappable SWITCHER with the state as
              its sub-line — on wider screens it stays the row it always was
              (name, then the health pill), so desktop is unchanged. */}
          <div className={anlage ? 'vp-topbar-anlage' : 'crumbs'}>
            {anlage ? (
              <div className="crumbs">
                {/* The breadcrumb names the ANLAGE, not the menu item ("Hof
                    Lindenberg", not "Meine Anlagen") - that is what the
                    customer is looking at (G1). The full text stays in the
                    title for a truncated phone width. */}
                <span className="here" title={anlage.siteName}>
                  {anlage.siteName}
                </span>
                {canSwitchAnlage && (
                  <>
                    <Icon name="chevron-down" size={16} className="vp-tb-caret" />
                    {/* Phone-only (CSS): the native picker is the best plant
                        switcher a thumb can get, and it covers the whole block
                        so the tap target is the full top-bar height. */}
                    <select
                      className="vp-tb-switch"
                      aria-label="Anlage wechseln"
                      value={anlage.siteId}
                      onChange={(e) => {
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
                  </>
                )}
              </div>
            ) : (
              <span className="here">{pageLabel(page, counts.sites)}</span>
            )}
            {anlage?.health && (
              // ONE aggregated plant state, always in sight (concept tab 2) —
              // and a REAL control: the worst cause is visible text, one click
              // lists every finding, and "Zur Anlage" leads to the plant's
              // Zustand card (a warning names its cause and is reachable in one
              // click). On a phone it renders as the switcher's sub-line.
              <HealthBadgeButton
                health={anlage.health}
                onOpenDetail={() => anlage.onOpenSub(null)}
              />
            )}
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

        <main className="vp-main has-bottombar">{children}</main>
      </div>

      {/* The app-like bottom bar on phones. Since Mobil-Umbau Stufe 1 BOTH
          levels carry one: inside an Anlage the derived daily areas
          (Cockpit · Fahrplan · Messwerte · Erlöse), above it the fleet entries
          (Übersicht · Anlagen) — the last slot always opens the sheet with
          everything else. Hidden above 720px by CSS. */}
      <nav
        className="vp-bottombar"
        aria-label={barLabel}
        style={{ ['--vp-bar-slots' as string]: String(barSlots.length) } as React.CSSProperties}
      >
        {barSlots.map((item) => {
          const active =
            item.target.kind === 'more'
              ? moreOpen
              : anlage
                ? anlage.activeKey === item.key
                : page === item.key;
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

      {moreOpen && (
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
            {sheetGroups.map((group) => (
              <div className="vp-sheet-group" key={group.key}>
                <div className={`vp-nav-group-label${group.tone ? ` tone-${group.tone}` : ''}`}>
                  {group.tone && <span className="vp-mode-dot" aria-hidden="true" />}
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const active = anlage ? anlage.activeKey === item.key : page === item.key;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`vp-sheet-item${active ? ' active' : ''}`}
                      onClick={() => openTarget(item.target)}
                    >
                      <Icon name={item.icon} size={18} />
                      {item.label}
                      {item.badge != null && (
                        <span className="vp-sheet-badge">{item.badge}</span>
                      )}
                    </button>
                  );
                })}
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
