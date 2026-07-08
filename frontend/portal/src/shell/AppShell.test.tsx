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
