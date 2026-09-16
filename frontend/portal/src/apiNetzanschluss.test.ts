import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { anfrage, neuerEntwurf } from './netzanschlussListe';
vi.mock('./auth', () => ({ freshToken: async () => 'test', AuthRedirectError: class extends Error {} }));
afterEach(() => vi.unstubAllGlobals());
it('liest den Stichtag und schreibt Anlegen/Wechseln an die vorhandenen IP-6-Routen', async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  vi.stubGlobal('fetch', fetch);
  await api.netzanschluesse('stand ort', '2026-10-20');
  expect(fetch.mock.calls[0][0]).toContain('/api/v1/standorte/stand%20ort/netzanschluesse?stichtag=2026-10-20');
  const body = anfrage({ ...neuerEntwurf('NA-0004'), name: 'Hauptanschluss Halle 1' });
  await api.netzanschlussAnlegen('st', body);
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  const bindung = { anlage_id: 'an', gueltig_ab: '2026-10-21', grund: null };
  await api.netzanschlussBinden('st', 'na', bindung);
  expect(fetch.mock.calls[2][0]).toContain('/api/v1/standorte/st/netzanschluesse/na/anlagen');
  expect(fetch.mock.calls[2][1]).toMatchObject({ method: 'POST', body: JSON.stringify(bindung) });
});
