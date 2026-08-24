import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PortfolioPage } from './PortfolioPage';
import { api, type Overview, type OverviewSite, type Site } from '../api';
import type { Route } from '../nav';

/**
 * M6 (#534): die Betreiber-Portfolio-Tabelle trägt pro Anlage die MODUS-CHIPS
 * (die M0-Projektion) statt des abgelösten AE7-Profil-Chips (F5) — und die
 * Zeile bleibt der Absprung in genau diese Anlage.
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
});

function renderPage(onNavigate: (r: Route) => void = () => {}) {
  return render(
    <PortfolioPage sites={SITES} onNavigate={onNavigate} onReload={() => {}} />,
  );
}

describe('Portfolio: die Anwendungs-Spalte (M6)', () => {
  it('nennt die aktiven Anwendungen einer migrierten Anlage — mehrere, nicht ein Gesicht', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('Werk Nord')).toBeInTheDocument());

    expect(screen.getByRole('columnheader', { name: 'Anwendungen' })).toBeInTheDocument();
    // Der abgelöste Profil-Chip ist weg.
    expect(screen.queryByRole('columnheader', { name: 'Profil' })).toBeNull();
    expect(container.querySelector('.vp-profile-chip')).toBeNull();

    const chips = [...container.querySelectorAll('.vp-mode-chip')].map((n) => n.textContent);
    expect(chips).toEqual(['Lastspitzenkappung', 'Marktoptimierung']);
  });

  it('lässt die Zelle einer nie migrierten Anlage leer („—"), statt eine Face zu erfinden', async () => {
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText('Bestandsanlage')).toBeInTheDocument());
    const rows = [...container.querySelectorAll('tbody tr')];
    const altRow = rows.find((r) => r.textContent?.includes('Bestandsanlage'));
    expect(altRow?.querySelector('.vp-mode-chip')).toBeNull();
    expect(altRow?.querySelector('td[data-label="Anwendungen"]')?.textContent).toBe('—');
  });

  it('bleibt der Absprung in genau diese Anlage', async () => {
    const routes: Route[] = [];
    renderPage((r) => routes.push(r));
    await waitFor(() => expect(screen.getByText('Werk Nord')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Werk Nord'));
    expect(routes).toEqual([{ page: 'anlagen', siteId: 'werk', sub: null }]);
  });
});
