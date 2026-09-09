import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Site, type SiteTopology } from './api';
import { customerFlowApi } from './flows/flowsApi';
import { useAnlageSurface } from './useAnlageSurface';
import { useAdaptiveLive } from './useAdaptiveLive';

vi.mock('./flows/flowsApi', () => ({ customerFlowApi: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const site = { id: 'a', plantKind: 'eigenverbrauch' } as Site;
const topology = { entities: [], topology: { nodes: [], flows: [] } } as unknown as SiteTopology;

beforeEach(() => {
  vi.spyOn(api, 'usageProfile').mockResolvedValue(null as never);
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ entities: [] } as never);
  vi.spyOn(api, 'siteProfiles').mockResolvedValue(null as never);
  vi.spyOn(api, 'siteInterventions').mockResolvedValue(null as never);
  vi.spyOn(api, 'entityStrategies').mockResolvedValue(null as never);
  vi.spyOn(api, 'topology').mockResolvedValue(topology);
  vi.mocked(customerFlowApi).mockReturnValue({ list: async () => [] } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('Cockpit loading', () => {
  it('releases the layout while the badge is still loading, then updates the badge', async () => {
    const badge = deferred<Awaited<ReturnType<typeof api.siteInterventions>>>();
    vi.mocked(api.siteInterventions).mockReturnValue(badge.promise);
    const { result } = renderHook(() => useAnlageSurface(site));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.surface).not.toBeNull();
    expect(result.current.aufmerksam.anzahl).toBe(0);
    await act(async () => badge.resolve({ automationPaused: true } as never));
    expect(result.current.aufmerksam.anzahl).toBe(1);
  });

  it('still waits for the stored profile that determines the cockpit layout', async () => {
    const profile = deferred<Awaited<ReturnType<typeof api.siteProfiles>>>();
    vi.mocked(api.siteProfiles).mockReturnValue(profile.promise);
    const { result } = renderHook(() => useAnlageSurface(site));
    await act(async () => {});
    expect(result.current.loading).toBe(true);
    expect(result.current.surface).toBeNull();
    await act(async () => profile.resolve(null as never));
    expect(result.current.loading).toBe(false);
  });

  it('ignores an old site badge that arrives after switching sites', async () => {
    const old = deferred<Awaited<ReturnType<typeof api.siteInterventions>>>();
    vi.mocked(api.siteInterventions).mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook(({ id }) => useAnlageSurface({ ...site, id }), {
      initialProps: { id: 'a' },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ id: 'b' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => old.resolve({ automationPaused: true } as never));
    expect(result.current.aufmerksam.anzahl).toBe(0);
  });

  it('shows topology without waiting for the optional emphasis profile', async () => {
    const profile = deferred<Awaited<ReturnType<typeof api.usageProfile>>>();
    vi.mocked(api.usageProfile).mockReturnValue(profile.promise);
    const { result } = renderHook(() => useAdaptiveLive('a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.topology).toEqual(topology);
    expect(result.current.profile).toBeNull();
    await act(async () => profile.resolve({ usageProfile: 'private' } as never));
    expect(result.current.profile?.usageProfile).toBe('private');
  });

  it('reports a topology error even when the optional profile never answers', async () => {
    vi.mocked(api.usageProfile).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.topology).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAdaptiveLive('a'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.failed).toBe(true);
    expect(result.current.adaptive).toBe(false);
  });
});
