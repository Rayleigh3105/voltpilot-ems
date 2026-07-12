import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppShell } from './AppShell';

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
    { id: 't-1', name: 'Stadtwerke Musterstadt', segment: 'CI', plan: 'basic', createdAt: '2026-01-01T00:00:00Z' },
    { id: 't-2', name: 'Familie Kaiser', segment: 'B2C', plan: 'basic', createdAt: '2026-01-01T00:00:00Z' },
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
