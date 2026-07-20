import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnlageTabBar } from './AnlageTabBar';
import { api, type SiteUsageProfile } from '../api';

function profileResp(usageProfile: string): SiteUsageProfile {
  return {
    usageProfile,
    derivedProfile: usageProfile,
    override: null,
    emphasis: { money: 'prominent', peak: 'minimal', flow: 'secondary', devices: 'secondary' },
    signals: {
      hasStorage: true,
      hasPv: true,
      hasControllableConsumer: false,
      activeStrategyNodeTypes: [],
      plantKind: null,
      hasLeistungspreis: false,
      override: null,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AnlageTabBar', () => {
  it('renders the derived visible tabs for the profile (arbitrage promotes Erlöse + Fahrplan)', async () => {
    vi.spyOn(api, 'usageProfile').mockResolvedValue(profileResp('arbitrage'));
    const onOpen = vi.fn();
    render(
      <AnlageTabBar
        siteId="s-1"
        siteName="Solarpark"
        activeSub={null}
        betriebsart="betreiber"
        onOpen={onOpen}
      />,
    );
    // The promoted arbitrage tabs appear once the profile resolves.
    expect(await screen.findByRole('button', { name: /Erlöse/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Fahrplan/ })).toBeInTheDocument();
    // The always-findable structures are visible tabs, not overflow.
    expect(screen.getByRole('button', { name: /Geräte/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Steuerung/ })).toBeInTheDocument();
  });

  it('clicking a tab navigates to that sub; Übersicht navigates to the cockpit (null)', async () => {
    vi.spyOn(api, 'usageProfile').mockResolvedValue(profileResp('private'));
    const onOpen = vi.fn();
    render(
      <AnlageTabBar siteId="s-1" activeSub={null} betriebsart="endkunde" onOpen={onOpen} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Geräte/ }));
    expect(onOpen).toHaveBeenCalledWith('entitaeten');

    fireEvent.click(screen.getByRole('button', { name: /Übersicht/ }));
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  it('the active sub is marked aria-current="page"', async () => {
    vi.spyOn(api, 'usageProfile').mockResolvedValue(profileResp('private'));
    render(
      <AnlageTabBar siteId="s-1" activeSub="steuerung" betriebsart={null} onOpen={vi.fn()} />,
    );
    const steuerung = await screen.findByRole('button', { name: /Steuerung/ });
    expect(steuerung).toHaveAttribute('aria-current', 'page');
  });

  it('overflow subs are reachable via the "Mehr" menu and navigate on click', async () => {
    vi.spyOn(api, 'usageProfile').mockResolvedValue(profileResp('arbitrage'));
    const onOpen = vi.fn();
    render(
      <AnlageTabBar siteId="s-1" activeSub={null} betriebsart="betreiber" onOpen={onOpen} />,
    );
    const more = await screen.findByRole('button', { name: /Mehr/ });
    // Wetter is not a visible tab on arbitrage - it lives in the overflow.
    expect(screen.queryByRole('button', { name: /^Wetter$/ })).not.toBeInTheDocument();
    fireEvent.click(more);
    const wetter = await screen.findByRole('menuitem', { name: /Wetter/ });
    fireEvent.click(wetter);
    expect(onOpen).toHaveBeenCalledWith('wetter');
  });

  it('falls back to a stable default order when the profile call fails (v1-safe)', async () => {
    vi.spyOn(api, 'usageProfile').mockRejectedValue(new Error('no profile'));
    render(<AnlageTabBar siteId="s-1" activeSub={null} betriebsart={null} onOpen={vi.fn()} />);
    // Übersicht/Live/Steuerung/Geräte are all present in the default order.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Übersicht/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Live/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Steuerung/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Geräte/ })).toBeInTheDocument();
  });
});
