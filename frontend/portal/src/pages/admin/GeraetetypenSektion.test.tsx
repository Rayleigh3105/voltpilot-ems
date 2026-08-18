import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const consumerDeviceTypes = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: {
    consumerDeviceTypes: () => consumerDeviceTypes(),
  },
}));

const { GeraetetypenSektion } = await import('./GeraetetypenSektion');

function dt(over: Record<string, unknown>) {
  return {
    type: 'wallbox',
    label: 'Wallbox',
    certificationStatus: 'simulator_only',
    certifiedAt: null,
    certificationNotes: null,
    connectedCount: 0,
    ...over,
  };
}

describe('GeraetetypenSektion (Admin-Umbau Stufe 3: Sektion der Steuerungs-Freigabe)', () => {
  it('renders each type with its honest freigabe-stand and no switch', async () => {
    consumerDeviceTypes.mockResolvedValue([
      dt({ type: 'wallbox', label: 'Wallbox', certificationStatus: 'simulator_only', connectedCount: 3 }),
      dt({ type: 'heating-rod', label: 'Heizstab', certificationStatus: 'in_certification' }),
    ]);
    render(<GeraetetypenSektion />);

    // The honest starting sentence (nothing certified yet).
    expect(await screen.findByText(/nur der Simulator/i)).toBeInTheDocument();
    expect(screen.getByText('Wallbox')).toBeInTheDocument();
    expect(screen.getByText('Nur Simulator')).toBeInTheDocument();
    expect(screen.getByText('In Zertifizierung')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // connected count
    // Read-only: no switch/toggle on this surface.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('shows a certified type with its date', async () => {
    consumerDeviceTypes.mockResolvedValue([
      dt({ certificationStatus: 'certified', certifiedAt: '2026-08-11T00:00:00Z' }),
    ]);
    render(<GeraetetypenSektion />);
    expect(await screen.findByText('Zertifiziert (plattformweit)')).toBeInTheDocument();
    expect(screen.getByText(/seit 11\.08\.2026/)).toBeInTheDocument();
  });

  it('shows an honest error state that can retry', async () => {
    consumerDeviceTypes.mockRejectedValue(new Error('boom'));
    render(<GeraetetypenSektion />);
    await waitFor(() =>
      expect(screen.getByText(/konnten nicht geladen werden/i)).toBeInTheDocument(),
    );
  });

  it('trägt den Anker, auf den das alte Lesezeichen springt', () => {
    consumerDeviceTypes.mockResolvedValue([]);
    const { container } = render(<GeraetetypenSektion />);
    // `#/geraetetypen` wird auf `?sektion=geraetetypen` umgeschrieben; ohne
    // dieses Ziel liefe der Sprung ins Leere.
    expect(container.querySelector('#sektion-geraetetypen')).toBeTruthy();
  });
});
