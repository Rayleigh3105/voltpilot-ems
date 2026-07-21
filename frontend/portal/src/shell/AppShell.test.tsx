import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';
import { anlageTrio } from '../anlageNav';

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

describe('AppShell Anlage nav (M1: trio + context + mode group + bottom bar)', () => {
  const trio = anlageTrio(3);
  const anlage = {
    siteId: 's-1',
    siteName: 'Hof Lindenberg',
    sites: [{ id: 's-1', name: 'Hof Lindenberg' }],
    onSelectSite: vi.fn(),
    trio,
    activeArea: 'uebersicht' as const,
    onOpenArea: vi.fn(),
    modeGroup: null,
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

  it('renders the trio in the sidebar AND in the phone bottom bar', () => {
    renderShell();
    // One sidebar NavItem + one bottom-bar item per area.
    for (const label of ['Übersicht', 'Steuerung', 'Geräte']) {
      expect(screen.getAllByRole('button', { name: new RegExp(label) }).length).toBeGreaterThanOrEqual(2);
    }
    expect(screen.getByLabelText('Bereiche der Anlage Hof Lindenberg')).toBeInTheDocument();
  });

  it('carries the active-mode count as the Steuerung badge', () => {
    renderShell();
    // Sidebar count + bottom-bar badge both read the same number.
    expect(screen.getAllByText('3').length).toBe(2);
  });

  it('shows a static Anlage label for a single-Anlage customer', () => {
    renderShell();
    expect(screen.getByText('Hof Lindenberg')).toBeInTheDocument();
    expect(screen.queryByLabelText('Anlage wählen')).toBeNull();
  });

  it('turns the label into a real switcher for a fleet', () => {
    const onSelectSite = vi.fn();
    renderShell({
      sites: [
        { id: 's-1', name: 'Hof Lindenberg' },
        { id: 's-2', name: 'Halle Nord' },
      ],
      onSelectSite,
    });
    const select = screen.getByLabelText('Anlage wählen');
    expect(screen.getByRole('option', { name: 'Halle Nord' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 's-2' } });
    expect(onSelectSite).toHaveBeenCalledWith('s-2');
  });

  it('opens an area on click', () => {
    const onOpenArea = vi.fn();
    renderShell({ onOpenArea });
    fireEvent.click(screen.getAllByRole('button', { name: /Steuerung/ })[0]);
    expect(onOpenArea).toHaveBeenCalledWith('steuerung');
  });

  it('renders Marktpreise/Prognose ONLY as the market mode group', () => {
    renderShell();
    expect(screen.queryByRole('button', { name: /Marktpreise/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Prognosequalität/ })).toBeNull();

    renderShell({ modeGroup: { title: 'Aus Modus: Marktvermarktung', pages: ['marktpreise', 'prognose'] } });
    expect(screen.getByText('Aus Modus: Marktvermarktung')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Marktpreise/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Prognosequalität/ })).toBeInTheDocument();
  });

  it('renders no Anlage nav and no bottom bar without an Anlage in scope', () => {
    render(
      <AppShell {...baseProps} showAddAnlage={false} onAddAnlage={vi.fn()} anlage={null}>
        <div>content</div>
      </AppShell>,
    );
    expect(screen.queryByLabelText(/Bereiche der Anlage/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Geräte/ })).toBeNull();
  });
});
