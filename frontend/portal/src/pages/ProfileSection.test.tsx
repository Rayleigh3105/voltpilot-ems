import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProfileSection } from './ProfileSection';
import type { Site } from '../api';
import type { SiteProfiles } from '../profiles';

const setSiteProfile = vi.fn();
const siteProfiles = vi.fn();

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      siteProfiles: (...args: unknown[]) => siteProfiles(...args),
      setSiteProfile: (...args: unknown[]) => setSiteProfile(...args),
    },
  };
});

vi.mock('../optimizerApi', () => ({
  optimizerApi: { configViaSwitcher: vi.fn().mockRejectedValue(new Error('admin only')) },
}));

vi.mock('../useAnlageSurface', () => ({
  useAnlageSurface: () => ({ surface: null, profiles: null, loading: false }),
}));

const SITE = { id: 's1', name: 'Demo' } as Site;

const SHELF: SiteProfiles = {
  profiles: [
    {
      id: 'eigenverbrauch',
      label: 'Eigenverbrauch',
      state: null,
      derivedActive: true,
      active: true,
      unlocks: { views: [], widgets: [], moneyStream: null },
      requirements: [
        { label: 'PV-Erzeugung', met: true },
        { label: 'Speicher', met: true },
      ],
      blockedReason: null,
      origin: 'masterdata',
      flowRef: null,
      gatedNodeTypes: [],
      gatedNodesEnabled: true,
    },
    {
      id: 'lastspitzenkappung',
      label: 'Lastspitzenkappung',
      state: null,
      derivedActive: false,
      active: false,
      unlocks: { views: [], widgets: [], moneyStream: null },
      requirements: [
        { label: 'Leistungspreis hinterlegt', met: false },
        { label: 'Speicher', met: true },
      ],
      blockedReason: null,
      origin: null,
      flowRef: null,
      gatedNodeTypes: ['vp.strategy.peakshaving'],
      gatedNodesEnabled: false,
    },
  ],
};

describe('ProfileSection', () => {
  beforeEach(() => {
    siteProfiles.mockReset().mockResolvedValue(SHELF);
    setSiteProfile.mockReset();
  });

  it('renders one card per profile with honest requirement chips', async () => {
    render(<ProfileSection site={SITE} />);
    expect(await screen.findByText('Eigenverbrauch')).toBeInTheDocument();
    expect(screen.getByText('Lastspitzenkappung')).toBeInTheDocument();
    expect(screen.getByText('Leistungspreis hinterlegt fehlt')).toBeInTheDocument();
    expect(screen.getByText('Von VoltPilot eingerichtet.')).toBeInTheDocument();
    // Two real switches, the active one checked - no "Angefragt" anywhere.
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(2);
    expect(switches[0]).toHaveAttribute('aria-checked', 'true');
    expect(document.body.textContent).not.toMatch(/angefragt/i);
  });

  it('toggles a profile through the server and renders the recomputed shelf', async () => {
    const after: SiteProfiles = {
      profiles: [
        SHELF.profiles[0],
        {
          ...SHELF.profiles[1],
          state: 'an',
          active: true,
          blockedReason: 'Ihr Leistungspreis ist noch nicht hinterlegt.',
        },
      ],
    };
    setSiteProfile.mockResolvedValue(after);
    render(<ProfileSection site={SITE} />);
    const peak = (await screen.findAllByRole('switch'))[1];
    fireEvent.click(peak);
    await waitFor(() =>
      expect(setSiteProfile).toHaveBeenCalledWith('s1', 'lastspitzenkappung', 'an'),
    );
    expect(
      await screen.findByText('Ihr Leistungspreis ist noch nicht hinterlegt.'),
    ).toBeInTheDocument();
  });
});
