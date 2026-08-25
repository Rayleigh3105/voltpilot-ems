import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AppShell } from './AppShell';
import { PortfolioTabs } from '../components/PortfolioTabs';
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

/** Die Hauptnavigation als Baustein — dort steht der Portfolio-Eintrag. */
function nav() {
  return screen.getByRole('navigation', { name: 'Hauptnavigation' });
}

/** Die Reiter der Flotten-Ebene als Baustein. */
function reiter() {
  return screen.getByRole('tablist');
}

/**
 * **Die Portfolio-Ebene ist seit dem Anwendungs-Programm Stufe 4 (E5) ein
 * Angebot der FLOTTEN-Ebene, nicht mehr der Betreiber-Schale.** Ein Endkunde
 * mit EINER Anlage sieht davon weiterhin nichts — seine Welt IST die eine
 * Anlage —, ein Endkunde ab ZWEI Anlagen bekommt dieselbe Ebene wie ein
 * Betreiber, nur in Karten-Dichte.
 *
 * **Seit der Navigations-Runde „zwei Ebenen" (E3) trägt die Seitenleiste dort
 * GENAU EINEN Eintrag** — die zwei Historie-Welten sind REITER der Seite
 * geworden (`PortfolioTabs`). Damit ist die Dopplung „Messwerte/Erlöse auf
 * zwei Ebenen" weg, die die Ist-Zählung als Befund N1 getragen hat.
 */
describe('Die Flotten-Ebene in der Schale: EIN Eintrag, keine Gruppe', () => {
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
      <AppShell {...baseProps} showPortfolio={false}>
        <div>content</div>
      </AppShell>,
    );
    expect(within(nav()).queryByRole('button', { name: 'Portfolio' })).toBeNull();
    expect(within(nav()).queryByRole('button', { name: 'Meine Anlagen' })).toBeNull();
  });

  it('Stufe 4: ein Endkunde ab ZWEI Anlagen bekommt die Flotten-Ebene — unter SEINEM Wort', () => {
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
      <AppShell {...baseProps} showPortfolio fleetLabel="Meine Anlagen">
        <div>content</div>
      </AppShell>,
    );
    expect(within(nav()).getByRole('button', { name: 'Meine Anlagen' })).toBeInTheDocument();
  });

  it('E3: die Gruppe „Alle Anlagen" ist ERSATZLOS entfallen', () => {
    render(
      <AppShell {...baseProps} showPortfolio fleetLabel="Portfolio">
        <div>content</div>
      </AppShell>,
    );
    const menue = nav();
    expect(within(menue).getByRole('button', { name: 'Portfolio' })).toBeInTheDocument();
    expect(within(menue).queryByText('Alle Anlagen')).toBeNull();
    // Die zwei Welten stehen NICHT mehr im Menü - sie sind Reiter der Seite.
    expect(within(menue).queryByRole('button', { name: 'Messwerte' })).toBeNull();
    expect(within(menue).queryByRole('button', { name: 'Erlöse' })).toBeNull();
    // Und die frühere Listen-Seite ist mit aufgegangen.
    expect(within(menue).queryByRole('button', { name: /^Meine Anlagen?$/ })).toBeNull();
  });

  it('führt die Flotten-Ebene an die Spitze der Leiste', () => {
    const onNavigate = vi.fn();
    render(
      <AppShell {...baseProps} onNavigate={onNavigate} showPortfolio fleetLabel="Portfolio">
        <div>content</div>
      </AppShell>,
    );
    expect([...nav().querySelectorAll('.vp-nav-lbl')][0].textContent).toBe('Portfolio');
    fireEvent.click(within(nav()).getByRole('button', { name: 'Portfolio' }));
    expect(onNavigate).toHaveBeenCalledWith('portfolio');
  });
});

/**
 * Die zwei Welten, jetzt als REITER: Übersicht · Messwerte · Erlöse. Sie
 * navigieren zwischen drei Seiten DERSELBEN Ebene.
 */
describe('PortfolioTabs: die Reiter der Flotten-Ebene', () => {
  it('trägt die drei Reiter und navigiert', () => {
    const onNavigate = vi.fn();
    render(
      <PortfolioTabs
        page="portfolio"
        showErloese
        fleetLabel="Portfolio"
        onNavigate={onNavigate}
      />,
    );
    expect([...reiter().querySelectorAll('[role=tab]')].map((n) => n.textContent)).toEqual([
      'Übersicht',
      'Messwerte',
      'Erlöse',
    ]);
    expect(reiter().getAttribute('aria-label')).toBe('Reiter der Ebene Portfolio');
    fireEvent.click(screen.getByRole('tab', { name: 'Messwerte' }));
    expect(onNavigate).toHaveBeenCalledWith('portfolio-messwerte');
    fireEvent.click(screen.getByRole('tab', { name: 'Erlöse' }));
    expect(onNavigate).toHaveBeenCalledWith('portfolio-erloese');
  });

  it('hebt die offene Welt hervor', () => {
    render(
      <PortfolioTabs
        page="portfolio-messwerte"
        showErloese
        fleetLabel="Meine Anlagen"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Messwerte' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Übersicht' }).getAttribute('aria-selected')).toBe(
      'false',
    );
  });

  it('lässt die Erlöse-Welt weg, solange keine Anlage einen Geld-Modus hat', () => {
    render(
      <PortfolioTabs
        page="portfolio"
        showErloese={false}
        fleetLabel="Portfolio"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Messwerte' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Erlöse' })).toBeNull();
  });

  it('zeigt sie trotzdem, wenn sie per Lesezeichen offen ist - nie eine Sackgasse', () => {
    render(
      <PortfolioTabs
        page="portfolio-erloese"
        showErloese={false}
        fleetLabel="Portfolio"
        onNavigate={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Erlöse' }).getAttribute('aria-selected')).toBe('true');
  });

  it('rendert AUSSERHALB der Flotten-Ebene gar nicht', () => {
    const { container } = render(
      <PortfolioTabs page="anlagen" showErloese fleetLabel="Portfolio" onNavigate={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
