import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AppShell } from './AppShell';
import { showPortfolioNav } from '../betriebsart';

// Avoid pulling in keycloak-js: the shell only needs a name for the avatar.
vi.mock('../auth', () => ({
  currentUser: () => ({ name: 'Erika Kaiser', email: 'erika@example.com', roles: [] }),
  logout: vi.fn(),
}));

const baseProps = {
  page: 'portfolio' as const,
  onNavigate: vi.fn(),
  isAdmin: false,
  showOverview: false,
  showAddAnlage: false,
  onAddAnlage: vi.fn(),
  counts: { sites: 3, devices: 3 },
  tenants: [],
  tenantOverride: null,
  onTenantChange: vi.fn(),
};

/** Die Hauptnavigation als Baustein — dort stehen die Portfolio-Einträge. */
function nav() {
  return screen.getByRole('navigation', { name: 'Hauptnavigation' });
}

/**
 * **Die Portfolio-Historie ist ein Angebot der BETREIBER-Schale** (PR G). Der
 * Endkunde — egal ob mit einer oder mit drei Anlagen — sieht davon nichts:
 * seine Historie lebt auf der Anlage, und ein Portfolio hat er nicht.
 */
describe('Sichtbarkeit der Portfolio-Welten in der Schale', () => {
  it('zeigt einem Endkunden NICHTS Neues', () => {
    const endkunde = {
      isAdmin: false,
      loaded: true,
      tenantReady: true,
      betriebsart: 'endkunde' as const,
      siteCount: 3,
    };
    expect(showPortfolioNav(endkunde)).toBe(false);

    render(
      <AppShell {...baseProps} showPortfolio={false} showPortfolioErloese>
        <div>content</div>
      </AppShell>,
    );
    expect(within(nav()).queryByText('Alle Anlagen')).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Messwerte' })).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Erlöse' })).toBeNull();
  });

  it('gibt dem Betreiber beide Welten unter der Portfolio-Landung', () => {
    const betreiber = {
      isAdmin: false,
      loaded: true,
      tenantReady: true,
      betriebsart: 'betreiber' as const,
      siteCount: 1,
    };
    expect(showPortfolioNav(betreiber)).toBe(true);

    const onNavigate = vi.fn();
    render(
      <AppShell {...baseProps} onNavigate={onNavigate} showPortfolio showPortfolioErloese>
        <div>content</div>
      </AppShell>,
    );
    // Die Gruppenüberschrift sagt, worüber die zwei Einträge sprechen - sonst
    // läse sich „Messwerte" wie die gleichnamige Ansicht EINER Anlage.
    expect(within(nav()).getByText('Alle Anlagen')).toBeInTheDocument();
    fireEvent.click(within(nav()).getByRole('button', { name: 'Messwerte' }));
    expect(onNavigate).toHaveBeenCalledWith('portfolio-messwerte');
    fireEvent.click(within(nav()).getByRole('button', { name: 'Erlöse' }));
    expect(onNavigate).toHaveBeenCalledWith('portfolio-erloese');
  });

  it('lässt die Erlöse-Welt weg, solange keine Anlage einen Geld-Modus hat', () => {
    render(
      <AppShell {...baseProps} showPortfolio showPortfolioErloese={false}>
        <div>content</div>
      </AppShell>,
    );
    expect(within(nav()).getByRole('button', { name: 'Messwerte' })).toBeInTheDocument();
    expect(within(nav()).queryByRole('button', { name: 'Erlöse' })).toBeNull();
  });
});
