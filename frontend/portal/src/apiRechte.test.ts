import { afterEach, expect, it, vi } from 'vitest';
import { api, request, setTenantOverride } from './api';
import { sichtbareListe } from './test/rollenFixtures';
vi.mock('./auth', () => ({ freshToken: async () => 'test', AuthRedirectError: class extends Error {} }));
afterEach(() => { vi.unstubAllGlobals(); setTenantOverride(null); });

it.each(['listSites', 'listDevices', 'edgeVersions'] as const)('%s liest den Umschlag einschließlich Teilansicht unverändert', async (name) => {
  const antwort = sichtbareListe([{ id: 'sichtbar' }]);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => antwort })));
  expect(await api[name]()).toEqual(antwort);
});

it('N7 · nur die benannte Entzug-Antwort löst die neue Startansicht aus', async () => {
  const entzogen = vi.fn();
  window.addEventListener('vp-zugriff-beendet', entzogen);
  try {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const code of ['nicht_gefunden', 'zugriff_beendet']) {
      fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ code, message: 'Ihr Zugriff auf Werk Lindach wurde beendet.' }) });
      await expect(request('/test/entzug')).rejects.toMatchObject({ status: 404 });
    }
    expect(entzogen).toHaveBeenCalledTimes(1);
    expect(entzogen.mock.calls[0][0].detail).toContain('Werk Lindach');
  } finally { window.removeEventListener('vp-zugriff-beendet', entzogen); }
});

it('Eine verspätete Antwort des vorherigen Mandanten beendet nicht den neuen Zugriff', async () => {
  let antworte!: (value: unknown) => void;
  const entzogen = vi.fn(); window.addEventListener('vp-zugriff-beendet', entzogen);
  const fetch = vi.fn(() => new Promise(resolve => { antworte = resolve; }));
  vi.stubGlobal('fetch', fetch);
  try {
    setTenantOverride('vorher');
    const alt = request('/test/alter-mandant');
    setTenantOverride('nachher');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(fetch.mock.calls[0][1].headers['X-Tenant-Id']).toBe('vorher');
    antworte({ ok: false, status: 404, json: async () => ({ code: 'zugriff_beendet', message: 'Beendet' }) });
    await expect(alt).rejects.toMatchObject({ status: 404 });
    expect(entzogen).not.toHaveBeenCalled();
  } finally { window.removeEventListener('vp-zugriff-beendet', entzogen); }
});
