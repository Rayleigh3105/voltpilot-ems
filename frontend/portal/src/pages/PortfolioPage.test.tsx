import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortfolioPage } from './PortfolioPage';
import { api, type Overview, type OverviewSite, type Site } from '../api';
import type { Route } from '../nav';

/**
 * M6 (#534) in der **Revision 2** vom 25.08.2026: die Zeile einer Anlage nennt
 * die MENGE ihrer Geschäfts-Anwendungen (die M0-Projektion) statt des
 * abgelösten AE7-Profil-Chips (F5) — und sie bleibt der Absprung in genau
 * diese Anlage.
 *
 * ⚠ Die eigene SPALTE „Anwendungen" ist mit Revision 2 entfallen: sie stand in
 * einer Tabelle, deren übrige Spalten Zahlen sind, und drängte die Zahlen an
 * den Rand. Die Anwendungen sind seither die UNTERZEILE der kompakten Dichte
 * — dieselbe Aussage, an dem Ort, an dem der Name steht.
 */

function site(over: Partial<Site> & { id: string; name: string }): Site {
  return {
    biddingZone: 'DE-LU',
    latitude: null,
    longitude: null,
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    tarifArt: 'ohne',
    tarifParamCtKwh: null,
    netzladenErlaubt: false,
    maxFeedInKw: null,
    ...over,
  } as Site;
}

function overviewSite(over: Partial<OverviewSite> & { id: string; name: string }): OverviewSite {
  return {
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: new Date().toISOString(),
    live: null,
    plannedSavingsTodayEur: null,
    ...over,
  } as OverviewSite;
}

/** Eine migrierte Gewerbe-Anlage (Peak + Markt) und eine Bestandsanlage. */
const SITES: Site[] = [
  site({ id: 'werk', name: 'Werk Nord', tarifArt: 'dynamisch', leistungspreisEurKw: 95 }),
  site({ id: 'alt', name: 'Bestandsanlage' }),
];

const OVERVIEW: Overview = {
  sites: [
    overviewSite({
      id: 'werk',
      name: 'Werk Nord',
      plantKind: 'direktvermarktung',
      usageProfile: 'peak',
      roleCounts: { pv: 2, storage: 1, consumer: 0, grid: 1 },
    }),
    overviewSite({ id: 'alt', name: 'Bestandsanlage' }),
  ],
  totals: { storageCapacityKwh: null, storagePowerKw: null } as never,
  dailySavings: [],
} as never;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'overview').mockResolvedValue(OVERVIEW);
  vi.spyOn(api, 'earnings').mockResolvedValue({
    range: 'month',
    from: '',
    to: '',
    sites: [],
    totals: {} as never,
  } as never);
  vi.spyOn(api, 'tenantCockpitLayout').mockResolvedValue({ vorgabe: null, eigen: null } as never);
  vi.spyOn(api, 'schedule').mockResolvedValue({ slots: [], deviceId: null } as never);
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
});

function renderPage(onNavigate: (r: Route) => void = () => {}) {
  return render(
    <PortfolioPage sites={SITES} onNavigate={onNavigate} onReload={() => {}} />,
  );
}

async function zeile(container: HTMLElement, name: string): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
  const rows = [...container.querySelectorAll('tbody tr')] as HTMLElement[];
  const treffer = rows.find((r) => r.textContent?.includes(name));
  expect(treffer, name).toBeTruthy();
  return treffer!;
}

describe('Portfolio: die Anwendungen der Anlage (M6, Revision 2)', () => {
  it('nennt die aktiven Anwendungen einer migrierten Anlage — mehrere, nicht ein Gesicht', async () => {
    const { container } = renderPage();
    const werk = await zeile(container, 'Werk Nord');
    const unter = werk.querySelector('.vp-at-sub')!;
    expect(unter.textContent).toBe('Direktvermarktung · Lastspitzenkappung · Marktoptimierung');
    // Der abgelöste Profil-Chip ist weg - und mit Revision 2 auch die eigene
    // Spalte, die die Zahlen an den Rand drängte.
    expect(container.querySelector('.vp-profile-chip')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Anwendungen' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Profil' })).toBeNull();
  });

  it('nennt bei einer nie migrierten Anlage nur, was sie belegen kann', async () => {
    // Ohne Signale bleibt die Veräußerungsform - eine erfundene Anwendung
    // wäre die schlimmere Auskunft.
    const { container } = renderPage();
    const alt = await zeile(container, 'Bestandsanlage');
    expect(alt.querySelector('.vp-at-sub')!.textContent).toBe('Eigenverbrauch');
  });

  it('führt KEINE Komponenten-Zähler mehr - die Spalten SIND die Komponenten', async () => {
    const { container } = renderPage();
    await zeile(container, 'Werk Nord');
    expect(container.querySelector('.vp-entity-badges')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Komponenten' })).toBeNull();
  });

  it('bleibt der Absprung in genau diese Anlage', async () => {
    const routes: Route[] = [];
    const { container } = renderPage((r) => routes.push(r));
    await zeile(container, 'Werk Nord');
    // Der Name klappt die Vorschau auf, der Absprung steht darin - ein Klick
    // auf die Zeile navigiert nicht mehr blind weg.
    fireEvent.click(screen.getByRole('button', { name: /Werk Nord/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Cockpit öffnen/ }));
    expect(routes).toEqual([{ page: 'anlagen', siteId: 'werk', sub: null }]);
  });
});
