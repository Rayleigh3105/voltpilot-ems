import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { AppShell, type PfadEintrag } from './AppShell';
import { anlageSidebar } from '../anlageNav';
import { anlageSurface, type AnlageSurfaceInput } from '../surface';

// Die Schale braucht nur einen Namen am Avatar (wie `PortfolioNav.test.tsx`).
vi.mock('../auth', () => ({
  currentUser: () => ({ name: 'Jonas Wendlinger', email: 'jonas@example.test', roles: [] }),
  logout: vi.fn(),
}));

const surface = anlageSurface({
  entities: [],
  config: { plantKind: 'eigenverbrauch', tarifArt: 'dynamisch' },
} as unknown as AnlageSurfaceInput);

const basis = {
  onNavigate: vi.fn(),
  isAdmin: false,
  showOverview: false,
  showPortfolio: true,
  fleetLabel: 'Meine Anlagen',
  showAddAnlage: false,
  onAddAnlage: vi.fn(),
  counts: { sites: 3, devices: 3 },
  tenants: [],
  tenantOverride: null,
  onTenantChange: vi.fn(),
};

const ahrenberg = [
  { id: 'an1', name: 'Werk Ahrenberg – Halle 1' },
  { id: 'an2', name: 'Werk Ahrenberg – Halle 2' },
  { id: 'an3', name: 'Werk Lindach' },
];

function kopf() {
  return screen.getByRole('banner');
}

/**
 * UEMS AP-01 IP-5 — der Pfad im Seitenkopf „Unternehmen › Standort › Anlage".
 * Die Glieder kommen fertig aus `betriebsart.kopfPfad` (dort geprüft in
 * `startansicht.test.ts`); hier steht, dass die Schale sie in dieser Reihenfolge
 * zeigt, jedes Glied zurückführt und eine Seite ohne Pfad bleibt, wie sie war.
 */
describe('UEMS AP-01 IP-5 · der Pfad im Seitenkopf', () => {
  it('eine Anlage unter zwei Standorten: „Ahrenberg › Werk Ahrenberg › Werk Ahrenberg – Halle 1 ▾"', () => {
    const zumUnternehmen = vi.fn();
    const zumStandort = vi.fn();
    const pfad: PfadEintrag[] = [
      { wert: '__unternehmen__', label: 'Ahrenberg', onOpen: zumUnternehmen },
      { wert: '__standort__', label: 'Werk Ahrenberg', onOpen: zumStandort },
    ];
    render(
      <AppShell
        {...basis}
        page="anlagen"
        anlage={{
          siteId: 'an1',
          siteName: 'Werk Ahrenberg – Halle 1',
          sites: ahrenberg,
          onSelectSite: vi.fn(),
          sidebar: anlageSidebar(surface, 0),
          activeKey: 'cockpit',
          onOpenSub: vi.fn(),
          onOpenPage: vi.fn(),
          onOpenFleet: vi.fn(),
          health: null,
          pfad,
        }}
      >
        <p>Cockpit</p>
      </AppShell>,
    );
    const k = kopf();
    expect(k.querySelector('.vp-topbar-anlage .crumbs')?.textContent).toMatch(
      /^Ahrenberg›Werk Ahrenberg›Werk Ahrenberg – Halle 1/,
    );
    // Das Unternehmen ERSETZT den Rückweg von heute — „Meine Anlagen" steht nicht davor.
    expect(within(k).queryByRole('button', { name: 'Meine Anlagen' })).toBeNull();
    fireEvent.click(within(k).getByRole('button', { name: 'Ahrenberg' }));
    expect(zumUnternehmen).toHaveBeenCalledTimes(1);
    fireEvent.click(within(k).getByRole('button', { name: 'Werk Ahrenberg' }));
    expect(zumStandort).toHaveBeenCalledTimes(1);
  });

  it('die Standort-Übersicht nennt ihren Ort und den Weg zum Unternehmen', () => {
    const zumUnternehmen = vi.fn();
    render(
      <AppShell
        {...basis}
        page="standort"
        ortsPfad={{ vor: [{ wert: '__unternehmen__', label: 'Ahrenberg', onOpen: zumUnternehmen }], hier: 'Werk Lindach' }}
      >
        <p>Standort</p>
      </AppShell>,
    );
    const crumbs = kopf().querySelector('.crumbs.vp-crumbs-ort');
    expect(crumbs?.textContent).toBe('Ahrenberg›Werk Lindach');
    expect(crumbs?.querySelector('.here')?.textContent).toBe('Werk Lindach');
    fireEvent.click(within(kopf()).getByRole('button', { name: 'Ahrenberg' }));
    expect(zumUnternehmen).toHaveBeenCalledTimes(1);
  });

  it('ohne Pfad bleibt die Kopfzeile einer Seite der Seitenname von heute', () => {
    render(
      <AppShell {...basis} page="portfolio">
        <p>Portfolio</p>
      </AppShell>,
    );
    const crumbs = kopf().querySelector('.crumbs');
    expect(crumbs?.className).toBe('crumbs');
    expect(crumbs?.textContent).toBe('Portfolio');
  });
});
