import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JetztZone } from './JetztZone';
import { api, type Site } from '../api';

const cList = vi.fn();
const cStatus = vi.fn();
const cOverrides = vi.fn();
const cStartOverride = vi.fn();
const cClearOverride = vi.fn();

vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    list: (...a: unknown[]) => cList(...a),
    status: (...a: unknown[]) => cStatus(...a),
    overrides: (...a: unknown[]) => cOverrides(...a),
    startOverride: (...a: unknown[]) => cStartOverride(...a),
    clearOverride: (...a: unknown[]) => cClearOverride(...a),
  },
}));

const site = { id: 's-1', name: 'Halle Nord', plantKind: 'eigenverbrauch' } as Site;

const CONSUMER = {
  id: 'e-wb', type: 'wallbox', typeLabel: 'Wallbox', name: 'Wallbox Garage',
  controlKind: 'on_off', ratedPowerKw: 11, minPowerKw: null, levelsKw: null,
  resolutionKw: null, powerRangesKw: null, storageRelation: 'consumer_first',
  defaultGridEnergyPolicy: 'allow', allowStorageDischarge: false, failsafe: 'off',
  enabled: true, version: 1, connection: 'connected', edgeSourceId: 'src-1',
  controlActivation: 'active', hasDraftPolicy: true, draftPolicyVersion: 1,
};

beforeEach(() => {
  vi.restoreAllMocks();
  cList.mockResolvedValue([]);
  cStatus.mockResolvedValue([]);
  cOverrides.mockResolvedValue([]);
  cClearOverride.mockResolvedValue({});
  cStartOverride.mockResolvedValue({});
  vi.spyOn(api, 'schedule').mockResolvedValue({ deviceId: null, slots: [] } as never);
  vi.spyOn(api, 'controlStatus').mockResolvedValue(null as never);
  vi.spyOn(api, 'curtailmentStatus').mockResolvedValue(null as never);
});

describe('Zone ① „Jetzt" (Steuerung Stufe 1)', () => {
  it('sagt ohne Steuerbares den WEG statt einer Zeile mit „—"', async () => {
    render(<JetztZone site={site} />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Jetzt' })).toBeInTheDocument());
    expect(await screen.findByText(/steuert VoltPilot noch nichts/)).toBeInTheDocument();
    expect(document.querySelectorAll('.vp-jetztrow')).toHaveLength(0);
  });

  it('zeigt je Gerät Zustand, Quelle und das Eingriffs-Menü', async () => {
    cList.mockResolvedValue([CONSUMER]);
    cStatus.mockResolvedValue([
      { entityId: 'e-wb', state: 'running_optimized', actualKw: 7.4, confirmed: true },
    ]);
    render(<JetztZone site={site} />);

    expect(await screen.findByText('Wallbox Garage')).toBeInTheDocument();
    expect(screen.getByText(/7,4/)).toBeInTheDocument();
    expect(screen.getByText('Ihre Regel')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Wallbox Garage: eingreifen/ }));
    expect(screen.getByRole('menuitem', { name: 'Jetzt starten' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Jetzt stoppen' })).toBeInTheDocument();
  });

  it('ein Eingriff geht durch die Rückfrage — der erste Klick schaltet nichts', async () => {
    cList.mockResolvedValue([CONSUMER]);
    render(<JetztZone site={site} />);
    fireEvent.click(await screen.findByRole('button', { name: /Wallbox Garage: eingreifen/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Jetzt starten' }));
    expect(cStartOverride).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(cStartOverride).toHaveBeenCalledWith(
      's-1', 'e-wb', expect.objectContaining({ action: 'start' }),
    ));
  });

  it('nennt einen laufenden Handeingriff im Banner — mit Ende UND Countdown', async () => {
    cList.mockResolvedValue([CONSUMER]);
    cOverrides.mockResolvedValue([{
      entityId: 'e-wb', kind: 'start', targetCommand: 'on_off',
      endsAt: new Date(Date.now() + 72 * 60 * 1000).toISOString(),
    }]);
    render(<JetztZone site={site} />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toContain('Handeingriff läuft');
    expect(banner.textContent).toContain('Wallbox Garage');
    expect(banner.textContent).toMatch(/noch 1 Std\./);
    // Der einzige Ausweg ist „Automatik fortsetzen" — auch im Zeilen-Menü.
    fireEvent.click(screen.getByRole('button', { name: 'Automatik fortsetzen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bestätigen' }));
    await waitFor(() => expect(cClearOverride).toHaveBeenCalledWith('s-1', 'e-wb'));
  });

  it('bietet keinem unerreichbaren Gerät einen Knopf an und nennt den Grund', async () => {
    cList.mockResolvedValue([{ ...CONSUMER, connection: 'disconnected' }]);
    render(<JetztZone site={site} />);
    expect(await screen.findByText(/meldet sich gerade nicht/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /eingreifen/ })).toBeNull();
  });
});
