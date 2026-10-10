import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
vi.mock('./auth', () => ({ freshToken: async () => 'test', AuthRedirectError: class extends Error {} }));
afterEach(() => vi.unstubAllGlobals());

it.each(['box-a', 'box-b', undefined])('erhält die Boxwahl %s und die Komponentenidentität getrennt', async (deviceId) => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetch);
  await api.testComponentConnection('anlage', {
    deviceId, entityId: 'komponente', templateRef: 'vorlage', connection: { ip: '192.168.1.4' },
  });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/sites/anlage/component-test'), expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ deviceId, entityId: 'komponente', templateRef: 'vorlage', connection: { ip: '192.168.1.4' } }),
  }));
});
