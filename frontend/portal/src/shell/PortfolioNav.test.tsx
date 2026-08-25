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
 * **Die Portfolio-Ebene ist seit dem Anwendungs-Programm Stufe 4 (E5) ein
 * Angebot der FLOTTEN-Ebene, nicht mehr der Betreiber-Schale** (PR G war das
 * Vorher). Ein Endkunde mit EINER Anlage sieht davon weiterhin nichts — seine
 * Welt IST die eine Anlage —, ein Endkunde ab ZWEI Anlagen bekommt dieselbe
 * Ebene wie ein Betreiber, nur in Karten-Dichte.
 */
describe('Sichtbarkeit der Portfolio-Welten in der Schale', () => {
  it('zeigt einem Endkunden mit EINER Anlage nichts davon', () => {
    const einzel = {
      isAdmin: false,
      loaded: true,
      tenantReady: true,
      betriebsart: 'endkunde' as const,
      siteCount: 1,
    };
    expect(showPortfolioNav(einzel)).toBe(false);

    render(
      <AppShell {...baseProps} showPortfolio={false} showPortfolioErloese>
        <div>content</div>
      </AppShell>,
    );
    expect(within(nav()).queryByText('Alle Anlagen')).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Messwerte' })).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Erlöse' })).toBeNull();
  });

  it('Stufe 4: ein Endkunde ab ZWEI Anlagen bekommt die Portfolio-Ebene', () => {
    // Die sichtbare U0/U5-Änderung, hier an der Schale festgenagelt: bis
    // Stufe 3 stand hier `false` und der Kunde sah die `FleetUebersicht`.
    const flotte = {
      isAdmin: false,
      loaded: true,
      tenantReady: true,
      betriebsart: 'endkunde' as const,
      siteCount: 3,
    };
    expect(showPortfolioNav(flotte)).toBe(true);

    render(
      <AppShell {...baseProps} showPortfolio showPortfolioErloese>
        <div>content</div>
      </AppShell>,
    );
    expect(within(nav()).queryByText('Alle Anlagen')).not.toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Messwerte' })).not.toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Erlöse' })).not.toBeNull();
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
