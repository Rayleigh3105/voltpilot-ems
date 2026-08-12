import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const componentFleet = vi.fn();

vi.mock('../../admin/adminApi', () => ({
  adminApi: { componentFleet: () => componentFleet() },
}));

const { KomponentenFlottePage } = await import('./KomponentenFlottePage');

function a(over: Record<string, unknown> = {}) {
  return {
    siteId: 's1',
    siteName: 'Pilsting',
    tenantId: 't1',
    tenantName: 'Kunde A',
    componentAuthority: 'portal',
    componentCount: 4,
    sources: { builtin: 1, certified: 0, custom: 0, composed: 3, unknown: 0 },
    privateTemplates: 0,
    syncStatus: 'in_sync',
    ...over,
  };
}

describe('KomponentenFlottePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    componentFleet.mockResolvedValue([a()]);
  });

  it('zeigt je Anlage Pflege-Ort, Herkunft und Soll/Ist über alle Mandanten', async () => {
    componentFleet.mockResolvedValue([
      a(),
      a({ siteId: 's2', siteName: 'Auernheim', tenantName: 'Kunde B', componentAuthority: 'box' }),
    ]);
    render(<KomponentenFlottePage />);
    await screen.findByText('Pilsting');

    const table = screen.getByTestId('komponenten-flotte');
    expect(within(table).getByText('Auernheim')).toBeInTheDocument();
    expect(within(table).getByText('Im Portal')).toBeInTheDocument();
    expect(within(table).getByText('An der Box')).toBeInTheDocument();
    expect(within(table).getAllByText(/Katalog/).length).toBeGreaterThan(0);
    expect(screen.getByTestId('kopf')).toHaveTextContent('1 im Portal gepflegt');
  });

  it('eine nur lesende Anlage sagt das, statt eine Freigabe zu behaupten', async () => {
    render(<KomponentenFlottePage />);
    await screen.findByText('Pilsting');
    expect(screen.getByText('Nur lesend')).toBeInTheDocument();
  });

  it('⚠ eine stille Anlage steht NICHT in „Das braucht einen Blick“', async () => {
    componentFleet.mockResolvedValue([a({ syncStatus: 'unreported' })]);
    render(<KomponentenFlottePage />);
    await screen.findByText('Pilsting');

    expect(screen.getByText('Nicht gemeldet')).toBeInTheDocument();
    expect(screen.queryByTestId('aufmerksamkeit')).not.toBeInTheDocument();
  });

  it('eine abgelehnte Fassung ist der Befund und nennt ihren Grund', async () => {
    componentFleet.mockResolvedValue([
      a({ syncStatus: 'pending', refusedRevision: 'r7', refusedReason: 'Unbekannter Treiber' }),
    ]);
    render(<KomponentenFlottePage />);

    const box = await screen.findByTestId('aufmerksamkeit');
    expect(box).toHaveTextContent(/Unbekannter Treiber/);
    expect(box).toHaveTextContent(/Fassung r7/);
  });

  it('der Selbstbau-Blick erscheint nur, wo es welchen gibt', async () => {
    render(<KomponentenFlottePage />);
    await screen.findByText('Pilsting');
    expect(screen.queryByTestId('selbstbau')).not.toBeInTheDocument();

    componentFleet.mockResolvedValue([
      a({ sources: { builtin: 0, certified: 0, custom: 2, composed: 0, unknown: 0 } }),
    ]);
    const { findByTestId } = render(<KomponentenFlottePage />);
    expect(await findByTestId('selbstbau')).toHaveTextContent(/2 eigene Geräte/);
  });

  it('ein Ladefehler ist ein Fehler, nie eine leere Flotte', async () => {
    componentFleet.mockRejectedValue(new Error('boom'));
    render(<KomponentenFlottePage />);
    expect(await screen.findByText(/ließ sich nicht laden/)).toBeInTheDocument();
    expect(screen.queryByTestId('komponenten-flotte')).not.toBeInTheDocument();
  });
});
