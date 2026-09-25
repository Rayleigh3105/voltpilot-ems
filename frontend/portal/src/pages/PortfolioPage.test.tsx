import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PortfolioPage } from './PortfolioPage';
import { api, type Overview, type OverviewSite, type Site } from '../api';

/**
 * Die Landung `#/portfolio` zeigt seit dem Entscheid vom 25.09.2026 für JEDE
 * Betriebsart dieselbe Übersicht in vier Blöcken — die frühere
 * Betreiber-Tabelle (mit den Anwendungen als Unterzeile, M6) ist aus dieser
 * Fläche entfallen. Die Seite liefert nur noch den Titel; die Reiter über ihr
 * nennen die Ebene schon, also bleibt die Überschrift ein Sprungziel.
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
  vi.spyOn(api, 'history').mockRejectedValue(new Error('keine Historie im Test'));
});

function renderPage() {
  return render(<PortfolioPage sites={SITES} onReload={() => {}} />);
}

describe('Portfolio-Landung: dieselbe Übersicht für jede Betriebsart', () => {
  it('zeigt die vier Blöcke statt Kennzahlen-Leiste und Anlagen-Tabelle', async () => {
    renderPage();
    expect(await screen.findByRole('region', { name: 'Ihre Anlagen' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Kennzahlen Ihrer Anlagen' })).toBeNull();
  });

  it('macht die Überschrift zum Sprungziel - die Reiter nennen die Ebene schon', async () => {
    renderPage();
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Portfolio' });
    expect(h1.className).toContain('vp-sr-only');
  });

  it('bleibt der Absprung in genau diese Anlage', async () => {
    renderPage();
    const anlagen = await screen.findByRole('region', { name: 'Ihre Anlagen' });
    const werk = within(anlagen).getByText('Werk Nord').closest('a') as HTMLAnchorElement;
    expect(werk.getAttribute('href')).toBe('#/anlage/werk');
    const alt = within(anlagen).getByText('Bestandsanlage').closest('a') as HTMLAnchorElement;
    expect(alt.getAttribute('href')).toBe('#/anlage/alt');
  });
});
