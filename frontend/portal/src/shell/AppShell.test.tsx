import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';
import { anlageSidebar } from '../anlageNav';
import { anlageSurface } from '../surface';

// Avoid pulling in keycloak-js: the shell only needs a name for the avatar.
vi.mock('../auth', () => ({
  currentUser: () => ({ name: 'Erika Kaiser', email: 'erika@example.com', roles: [] }),
  logout: vi.fn(),
}));

const baseProps = {
  page: 'anlagen' as const,
  onNavigate: vi.fn(),
  isAdmin: false,
  showOverview: false,
  counts: { sites: 1, devices: 1 },
  tenants: [],
  tenantOverride: null,
  onTenantChange: vi.fn(),
};

describe('AppShell "＋ Anlage hinzufügen" header action', () => {
  it('renders the action and opens the flow when showAddAnlage is true', () => {
    const onAddAnlage = vi.fn();
    render(
      <AppShell {...baseProps} showAddAnlage onAddAnlage={onAddAnlage}>
        <div>content</div>
      </AppShell>,
    );
    const btn = screen.getByRole('button', { name: 'Anlage hinzufügen' });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onAddAnlage).toHaveBeenCalledTimes(1);
  });

  it('is absent when showAddAnlage is false (fleets/admins already have one)', () => {
    render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByRole('button', { name: 'Anlage hinzufügen' })).toBeNull();
  });
});

describe('AppShell admin tenant switcher', () => {
  const tenants = [
    { id: 't-1', name: 'Stadtwerke Musterstadt', segment: 'CI', plan: 'basic', betriebsart: null, betriebsartEffective: 'betreiber' as const, createdAt: '2026-01-01T00:00:00Z' },
    { id: 't-2', name: 'Familie Kaiser', segment: 'B2C', plan: 'basic', betriebsart: null, betriebsartEffective: 'endkunde' as const, createdAt: '2026-01-01T00:00:00Z' },
  ];

  it('renders the tenant switcher with an "Alle Mandanten" default for admins', () => {
    const onTenantChange = vi.fn();
    render(
      <AppShell
        {...baseProps}
        isAdmin
        showOverview
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        tenants={tenants}
        onTenantChange={onTenantChange}
      >
        <div>content</div>
      </AppShell>,
    );
    const select = screen.getByLabelText('Mandanten-Kontext');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Alle Mandanten' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Stadtwerke Musterstadt' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 't-2' } });
    expect(onTenantChange).toHaveBeenCalledWith('t-2');
  });

  it('shows no tenant switcher for a customer', () => {
    render(
      <AppShell {...baseProps} isAdmin={false} showAddAnlage={false} onAddAnlage={vi.fn()} tenants={[]}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByLabelText('Mandanten-Kontext')).toBeNull();
  });
});

describe('AppShell Anlage nav (v3 M1: grouped sidebar + health badge + bottom bar)', () => {
  // Ein DV-Park OHNE Speicher: dort trägt der Markt-Modus den Fahrplan + die
  // Prognose selbst, es gibt also eine echte Modus-Gruppe zu rendern. Auf einer
  // SPEICHER-Anlage sind beide inzwischen Basis-Ansichten (Captain 2026-07-29),
  // dann entfällt die Gruppe - das prüft `anlageNav.test.ts`.
  const MARKT = anlageSurface({
    entities: [{ id: 'e1', entityType: 'producer', capabilities: { measure: [{ channel: 'pv_power_kw' }] } }],
    config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
  });

  const anlage = {
    siteId: 's-1',
    siteName: 'Hof Lindenberg',
    sites: [{ id: 's-1', name: 'Hof Lindenberg' }],
    onSelectSite: vi.fn(),
    sidebar: anlageSidebar(null, 3),
    activeKey: 'cockpit',
    onOpenSub: vi.fn(),
    onOpenPage: vi.fn(),
    onOpenFleet: null,
    health: { state: 'ok' as const, label: 'Alles in Ordnung', detail: null, findings: [] },
  };

  const renderShell = (over: Partial<typeof anlage> = {}) =>
    render(
      <AppShell
        {...baseProps}
        showAddAnlage={false}
        onAddAnlage={vi.fn()}
        anlage={{ ...anlage, ...over }}
      >
        <div>content</div>
      </AppShell>,
    );

  it('renders the base group with its four areas, labelled "Anlage"', () => {
    // Cockpit+Live merge (Option A): no "Live-Daten" nav item any more.
    const { container } = renderShell();
    expect(container.querySelector('.vp-anlagenav .vp-nav-group-label')?.textContent).toBe(
      'Anlage',
    );
    for (const label of ['Cockpit', 'Historie', 'Steuerung', 'Anlagen-Modell']) {
      expect(screen.getAllByRole('button', { name: new RegExp(label) }).length).toBeGreaterThanOrEqual(1);
    }
    expect(screen.queryByRole('button', { name: /Live-Daten/ })).toBeNull();
  });

  it('renders the 5-slot bottom bar for the Anlage', () => {
    renderShell();
    const bar = screen.getByLabelText('Bereiche der Anlage Hof Lindenberg');
    expect(bar.querySelectorAll('.vp-bottombar-item')).toHaveLength(5);
    expect(bar.textContent).toContain('Mehr');
  });

  it('has NO "Mehr ▾" popover trigger anywhere', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-more-btn')).toBeNull();
  });

  it('carries the active-mode count as the Steuerung badge', () => {
    renderShell();
    // Sidebar count + bottom-bar badge both read the same number.
    expect(screen.getAllByText('3').length).toBe(2);
  });

  const WARN_HEALTH = {
    state: 'warnung' as const,
    label: 'Warnung',
    detail: 'Gerät: meldet sich nicht',
    findings: [
      { state: 'warn' as const, text: 'Gerät: meldet sich nicht' },
      { state: 'off' as const, text: 'Steuerung: noch nicht freigegeben' },
    ],
  };

  it('renders the health badge with its state and names the worst finding', () => {
    const { container } = renderShell({ health: WARN_HEALTH });
    const badge = container.querySelector('.vp-topbar .vp-healthbadge');
    expect(badge).not.toBeNull();
    expect(badge?.className).toContain('state-warnung');
    expect(badge?.getAttribute('title')).toBe('Gerät: meldet sich nicht');
    expect(badge?.textContent).toContain('Warnung');
  });

  it('shows the CAUSE as visible text, not only in a hover title', () => {
    const { container } = renderShell({ health: WARN_HEALTH });
    const cause = container.querySelector('.vp-topbar .vp-healthbadge-cause');
    // The cause must be real text in the DOM - a `title=` alone is invisible
    // on touch and undiscoverable everywhere else.
    expect(cause?.textContent).toBe('Gerät: meldet sich nicht');
  });

  it('is a real, keyboard-reachable control with a cause-carrying accessible name', () => {
    renderShell({ health: WARN_HEALTH });
    const badge = screen.getByRole('button', {
      name: /Zustand der Anlage: Warnung – Gerät: meldet sich nicht/,
    });
    expect(badge.tagName).toBe('BUTTON');
    expect(badge.getAttribute('aria-expanded')).toBe('false');
  });

  it('one click opens a popover listing EVERY finding, and drills into the Anlage', () => {
    const onOpenSub = vi.fn();
    renderShell({ health: WARN_HEALTH, onOpenSub });
    fireEvent.click(screen.getByRole('button', { name: /Zustand der Anlage/ }));
    const pop = screen.getByRole('dialog', { name: 'Zustand der Anlage' });
    expect(pop.textContent).toContain('Gerät: meldet sich nicht');
    expect(pop.textContent).toContain('Steuerung: noch nicht freigegeben');
    // The drill target: the plant's own Zustand card on its cockpit.
    fireEvent.click(screen.getByRole('button', { name: /Zur Anlage/ }));
    expect(onOpenSub).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('dialog', { name: 'Zustand der Anlage' })).toBeNull();
  });

  it('a healthy plant opens an honest "nichts zu melden" popover', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Zustand der Anlage/ }));
    expect(screen.getByRole('dialog', { name: 'Zustand der Anlage' }).textContent).toContain(
      'nichts zu melden',
    );
  });

  it('renders no health badge when the state is not known yet', () => {
    const { container } = renderShell({ health: null });
    expect(container.querySelector('.vp-healthbadge')).toBeNull();
  });

  it('shows a static Anlage label with its health line for a single-Anlage customer', () => {
    const { container } = renderShell();
    expect(container.querySelector('.vp-anlagenav-label .t')?.textContent).toBe('Hof Lindenberg');
    expect(container.querySelector('.vp-anlagenav-health')?.textContent).toContain(
      'Alles in Ordnung',
    );
    expect(container.querySelector('.vp-topbar .here')?.textContent).toBe('Hof Lindenberg');
    expect(screen.queryByLabelText('Anlage wählen')).toBeNull();
  });

  it('turns the label into a real switcher with "Alle Anlagen" for a fleet', () => {
    const onSelectSite = vi.fn();
    const onOpenFleet = vi.fn();
    renderShell({
      sites: [
        { id: 's-1', name: 'Hof Lindenberg' },
        { id: 's-2', name: 'Halle Nord' },
      ],
      onSelectSite,
      onOpenFleet,
    });
    const select = screen.getByLabelText('Anlage wählen');
    expect(screen.getByRole('option', { name: 'Halle Nord' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 's-2' } });
    expect(onSelectSite).toHaveBeenCalledWith('s-2');
    fireEvent.change(select, { target: { value: '__all__' } });
    expect(onOpenFleet).toHaveBeenCalledTimes(1);
  });

  it('opens an area on click', () => {
    const onOpenSub = vi.fn();
    renderShell({ onOpenSub });
    fireEvent.click(screen.getAllByRole('button', { name: /Steuerung/ })[0]);
    expect(onOpenSub).toHaveBeenCalledWith('steuerung');
  });

  it('renders the market mode group ONLY while that mode is active', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: /Marktpreise/ })).toBeNull();

    const onOpenPage = vi.fn();
    renderShell({ sidebar: anlageSidebar(MARKT), onOpenPage });
    expect(screen.getByText('Modus · Marktvermarktung')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fahrplan/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Marktpreise/ }));
    expect(onOpenPage).toHaveBeenCalledWith('marktpreise');
  });

  it('the Mehr slot opens a sheet with the remaining areas, colour-tagged', () => {
    renderShell({ sidebar: anlageSidebar(MARKT) });
    const bar = screen.getByLabelText('Bereiche der Anlage Hof Lindenberg');
    fireEvent.click(bar.querySelectorAll('.vp-bottombar-item')[4]);
    const sheet = screen.getByRole('dialog', { name: 'Weitere Bereiche' });
    // Historie sits in the bottom bar since the merge (owner Q3), so the sheet
    // leads with the mode groups.
    expect(sheet.textContent).toContain('Modus · Marktvermarktung');
    expect(sheet.textContent).toContain('Wetter');
    expect(sheet.textContent).toContain('Einstellungen');
    expect(sheet.textContent).toContain('Hilfe & Kontakt');
    expect(sheet.querySelector('.tone-markt')).not.toBeNull();
  });

  it('the foot Hilfe entry opens an honest help panel, never a dead link', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: /Hilfe & Kontakt/ }));
    const panel = screen.getByRole('dialog', { name: 'Hilfe & Kontakt' });
    expect(panel.textContent).toContain('VoltPilot');
  });

  it('renders no Anlage nav and no bottom bar without an Anlage in scope', () => {
    render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()} anlage={null}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByLabelText(/Bereiche der Anlage/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Anlagen-Modell/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Hilfe/ })).toBeNull();
  });
});
