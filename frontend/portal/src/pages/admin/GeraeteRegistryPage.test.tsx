import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProvisionedDevices = vi.fn();
const listPendingEnrollments = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    listProvisionedDevices: () => listProvisionedDevices(),
    listPendingEnrollments: () => listPendingEnrollments(),
    provisionDevice: vi.fn(),
    deleteProvisionedDevice: vi.fn(),
  },
}));

const { GeraeteRegistryPage } = await import('./GeraeteRegistryPage');

const DEVICE = {
  externalRef: 'VP-DEMO-0001',
  kind: 'inverter',
  note: null,
  provisionedAt: '2026-07-01T00:00:00Z',
  claimed: true,
  claimedByTenant: 'Demo C&I',
};

beforeEach(() => {
  vi.clearAllMocks();
  listProvisionedDevices.mockResolvedValue([DEVICE]);
  listPendingEnrollments.mockResolvedValue([]);
});

describe('GeraeteRegistryPage (B3 - der Onboarding-Funnel)', () => {
  it('shows the three funnel stages over the registry', async () => {
    render(<GeraeteRegistryPage />);
    expect(await screen.findByText('Registriert')).toBeInTheDocument();
    expect(screen.getByText('Wartet auf Zuordnung')).toBeInTheDocument();
    expect(screen.getByText('Verbunden')).toBeInTheDocument();
  });

  it('surfaces a device that reported but met no claim - the typo window', async () => {
    listPendingEnrollments.mockResolvedValue([
      {
        externalRef: 'edge-k7m2p4x',
        deviceInfo: 'VP Edge · Raspberry Pi',
        csrUpdatedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
        everIssued: false,
        issuedAt: null,
      },
    ]);
    render(<GeraeteRegistryPage />);

    expect(await screen.findByText('edge-k7m2p4x')).toBeInTheDocument();
    expect(screen.getByText('VP Edge · Raspberry Pi')).toBeInTheDocument();
    expect(screen.getByText('Vermutlich Tippfehler beim Kunden')).toBeInTheDocument();
  });

  it('says plainly that nobody is waiting instead of showing an empty table', async () => {
    render(<GeraeteRegistryPage />);
    expect(await screen.findByText('Kein Gerät wartet auf Zuordnung')).toBeInTheDocument();
  });

  it('a failed pending load is a FAILURE, never "nobody is waiting"', async () => {
    listPendingEnrollments.mockRejectedValue(new Error('kaputt'));
    render(<GeraeteRegistryPage />);

    // Die Registry darunter bleibt benutzbar ...
    expect(await screen.findByText('VP-DEMO-0001')).toBeInTheDocument();
    // ... und die Sektion sagt, dass sie gerade nichts weiß.
    expect(screen.getByText(/wartenden Geräte konnten nicht geladen werden/)).toBeInTheDocument();
    expect(screen.queryByText('Kein Gerät wartet auf Zuordnung')).toBeNull();
  });
});
