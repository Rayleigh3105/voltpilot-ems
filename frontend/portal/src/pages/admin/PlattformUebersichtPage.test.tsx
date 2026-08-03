import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tenant } from '../../admin/adminApi';

const overview = vi.fn();
const sites = vi.fn();
const edgeVersions = vi.fn();
const sources = vi.fn();
const controlStatus = vi.fn();
const curtailmentStatus = vi.fn();

vi.mock('../../admin/fleetApi', () => ({
  fleetApi: {
    overview: (...a: unknown[]) => overview(...a),
    sites: (...a: unknown[]) => sites(...a),
    edgeVersions: (...a: unknown[]) => edgeVersions(...a),
    sources: (...a: unknown[]) => sources(...a),
    controlStatus: (...a: unknown[]) => controlStatus(...a),
    curtailmentStatus: (...a: unknown[]) => curtailmentStatus(...a),
  },
}));

const { PlattformUebersichtPage } = await import('./PlattformUebersichtPage');

const TENANTS: Tenant[] = [
  {
    id: 't1',
    name: 'Demo C&I',
    segment: 'CI',
    plan: 'MVP',
    betriebsart: null,
    betriebsartEffective: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 't2',
    name: 'Energiehof P.',
    segment: 'CI',
    plan: 'MVP',
    betriebsart: null,
    betriebsartEffective: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

function site(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: new Date().toISOString(),
    live: null,
    plannedSavingsTodayEur: 1,
    lastPlanGeneratedAt: new Date().toISOString(),
    ...extra,
  };
}

function overviewFor(sitesList: unknown[]) {
  return {
    sites: sitesList,
    totals: {
      sites: sitesList.length,
      devices: 1,
      online: 1,
      plannedSavingsTodayEur: null,
      liveSitesCovered: 1,
    },
    dailySavings: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sites.mockResolvedValue([]);
  edgeVersions.mockResolvedValue([]);
  sources.mockResolvedValue([]);
  controlStatus.mockResolvedValue(null);
  curtailmentStatus.mockResolvedValue(null);
});

describe('PlattformUebersichtPage', () => {
  it('shows one row per site across ALL tenants', async () => {
    overview.mockImplementation((id: string) =>
      Promise.resolve(
        overviewFor([id === 't1' ? site('s1', 'Solarpark Dachau') : site('s2', 'PV-Park Pilsting')]),
      ),
    );
    render(<PlattformUebersichtPage tenants={TENANTS} onJumpToTenant={vi.fn()} />);

    expect(await screen.findByText('Solarpark Dachau')).toBeInTheDocument();
    expect(screen.getByText('PV-Park Pilsting')).toBeInTheDocument();
    expect(screen.getByText('Anlagen gesamt')).toBeInTheDocument();
  });

  it('carries NO money at all - a pure technical view (Captain Q2)', async () => {
    overview.mockImplementation((id: string) =>
      Promise.resolve(overviewFor(id === 't1' ? [site('s1', 'Anlage A')] : [])),
    );
    const { container } = render(
      <PlattformUebersichtPage tenants={TENANTS} onJumpToTenant={vi.fn()} />,
    );
    await screen.findByText('Anlage A');
    expect(container.textContent).not.toContain('€');
    expect(container.textContent).not.toMatch(/verdient|gespart|Erlös/i);
  });

  it('a dead tenant is NAMED and the other rows still render', async () => {
    overview.mockImplementation((id: string) =>
      id === 't1'
        ? Promise.reject(new Error('kaputt'))
        : Promise.resolve(overviewFor([site('s2', 'PV-Park Pilsting')])),
    );
    render(<PlattformUebersichtPage tenants={TENANTS} onJumpToTenant={vi.fn()} />);

    expect(await screen.findByText('PV-Park Pilsting')).toBeInTheDocument();
    expect(screen.getByText(/Demo C&I/)).toBeInTheDocument();
    expect(screen.getByText(/nicht geladen werden/)).toBeInTheDocument();
  });

  it('opens the Anlage in ITS tenant context', async () => {
    overview.mockImplementation((id: string) =>
      Promise.resolve(overviewFor(id === 't1' ? [site('s1', 'Solarpark Dachau')] : [])),
    );
    const jump = vi.fn();
    render(<PlattformUebersichtPage tenants={TENANTS} onJumpToTenant={jump} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Solarpark Dachau' }));
    expect(jump).toHaveBeenCalledWith('t1', { page: 'anlagen', siteId: 's1', sub: null });
  });

  it('loads the control matrix only when the section is opened (lazy)', async () => {
    overview.mockImplementation((id: string) =>
      Promise.resolve(
        overviewFor(
          id === 't1'
            ? [site('s1', 'Speicheranlage', { roleCounts: { pv: 1, storage: 1, consumer: 0, grid: 1 } })]
            : [],
        ),
      ),
    );
    curtailmentStatus.mockResolvedValue({
      deviceId: 'd1',
      units: 2,
      certifiedUnits: 0,
      controlEnabled: true,
      active: false,
      appliedCapKw: null,
      allMatch: null,
      possibleOverride: false,
      checkedAt: new Date().toISOString(),
    });
    render(<PlattformUebersichtPage tenants={TENANTS} onJumpToTenant={vi.fn()} />);

    const toggle = await screen.findByRole('button', { name: /Steuerung & Abregelung/ });
    expect(curtailmentStatus).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    await waitFor(() => expect(curtailmentStatus).toHaveBeenCalled());
    // Die Pilsting-Sicht steht prominent in der Zeile.
    expect(await screen.findByText('0 von 2 Wechselrichtern freigegeben')).toBeInTheDocument();
  });

  it('offers no control matrix at all when no plant has a battery', async () => {
    overview.mockImplementation((id: string) =>
      Promise.resolve(overviewFor(id === 't1' ? [site('s1', 'PV ohne Speicher')] : [])),
    );
    render(<PlattformUebersichtPage tenants={TENANTS} onJumpToTenant={vi.fn()} />);
    await screen.findByText('PV ohne Speicher');
    expect(screen.queryByRole('button', { name: /Steuerung & Abregelung/ })).toBeNull();
  });
});
