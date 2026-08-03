import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminFleetSite } from '../../admin/fleetApi';

const fleet = vi.fn();

vi.mock('../../admin/fleetApi', () => ({
  fleetApi: { fleet: (...a: unknown[]) => fleet(...a) },
}));

const { PlattformUebersichtPage } = await import('./PlattformUebersichtPage');

function site(id: string, name: string, extra: Partial<AdminFleetSite> = {}): AdminFleetSite {
  return {
    siteId: id,
    siteName: name,
    tenantId: 't1',
    tenantName: 'Demo C&I',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    tarifArt: 'fest',
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: new Date().toISOString(),
    lastPlanGeneratedAt: new Date().toISOString(),
    hasStorage: false,
    batteryWithoutDevice: false,
    sources: null,
    edge: null,
    control: null,
    curtailment: null,
    kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: '-' },
    forecast: [],
    pflege: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fleet.mockResolvedValue({ sites: [] });
});

describe('PlattformUebersichtPage', () => {
  it('shows one row per site across ALL tenants - from ONE request', async () => {
    fleet.mockResolvedValue({
      sites: [
        site('s1', 'Solarpark Dachau'),
        site('s2', 'PV-Park Pilsting', { tenantId: 't2', tenantName: 'Energiehof P.' }),
      ],
    });
    render(<PlattformUebersichtPage onJumpToTenant={vi.fn()} />);

    expect(await screen.findByText('Solarpark Dachau')).toBeInTheDocument();
    expect(screen.getByText('PV-Park Pilsting')).toBeInTheDocument();
    expect(screen.getByText('Anlagen gesamt')).toBeInTheDocument();
    // Die Mandanten-Schleife ist entfallen: EIN Aufruf trägt die ganze Seite.
    expect(fleet).toHaveBeenCalledTimes(1);
  });

  it('carries NO money at all - a pure technical view (Captain Q2)', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'Anlage A')] });
    const { container } = render(<PlattformUebersichtPage onJumpToTenant={vi.fn()} />);
    await screen.findByText('Anlage A');
    expect(container.textContent).not.toContain('€');
    expect(container.textContent).not.toMatch(/verdient|gespart|Erlös/i);
  });

  it('names a failed load instead of claiming an empty fleet', async () => {
    fleet.mockRejectedValue(new Error('kaputt'));
    render(<PlattformUebersichtPage onJumpToTenant={vi.fn()} />);
    expect(await screen.findByText(/nicht geladen werden/)).toBeInTheDocument();
    expect(screen.queryByText(/Noch keine Anlage/)).toBeNull();
  });

  it('opens the Anlage in ITS tenant context', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'Solarpark Dachau')] });
    const jump = vi.fn();
    render(<PlattformUebersichtPage onJumpToTenant={jump} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Solarpark Dachau' }));
    expect(jump).toHaveBeenCalledWith('t1', { page: 'anlagen', siteId: 's1', sub: null });
  });

  it('shows the control matrix from the SAME response - no extra request', async () => {
    fleet.mockResolvedValue({
      sites: [
        site('s1', 'Speicheranlage', {
          hasStorage: true,
          curtailment: {
            deviceId: 'd1',
            units: 2,
            certifiedUnits: 0,
            controlEnabled: true,
            active: false,
            appliedCapKw: null,
            allMatch: null,
            possibleOverride: false,
            checkedAt: new Date().toISOString(),
          },
        }),
      ],
    });
    render(<PlattformUebersichtPage onJumpToTenant={vi.fn()} />);

    const toggle = await screen.findByRole('button', { name: /Steuerung & Abregelung/ });
    fireEvent.click(toggle);
    // Die Pilsting-Sicht steht prominent in der Zeile.
    expect(await screen.findByText('0 von 2 Wechselrichtern freigegeben')).toBeInTheDocument();
    await waitFor(() => expect(fleet).toHaveBeenCalledTimes(1));
  });

  it('offers no control matrix at all when no plant has a battery', async () => {
    fleet.mockResolvedValue({ sites: [site('s1', 'PV ohne Speicher')] });
    render(<PlattformUebersichtPage onJumpToTenant={vi.fn()} />);
    await screen.findByText('PV ohne Speicher');
    expect(screen.queryByRole('button', { name: /Steuerung & Abregelung/ })).toBeNull();
  });

  it('shows a B4 finding as a chip that carries its reason', async () => {
    fleet.mockResolvedValue({
      sites: [
        site('s1', 'Skalierungsfall', {
          kwp: {
            configuredKwp: 30,
            observedPeakKw: 420,
            buckets: 2000,
            verdict: 'zu_hoch',
            reason: 'Gemessene PV-Spitze 420,0 kW über 30,0 kWp installiert.',
          },
          pflege: [
            {
              code: 'kwp-unplausibel',
              label: 'kWp unplausibel',
              detail: 'Gemessene PV-Spitze 420,0 kW über 30,0 kWp installiert.',
            },
          ],
        }),
      ],
    });
    render(<PlattformUebersichtPage onJumpToTenant={vi.fn()} />);
    const chip = await screen.findByText('kWp unplausibel');
    expect(chip.closest('[title]')?.getAttribute('title')).toContain('420,0 kW');
  });
});
