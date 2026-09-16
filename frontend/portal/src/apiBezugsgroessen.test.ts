import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
vi.mock('./auth', () => ({ freshToken: async () => 'test', AuthRedirectError: class extends Error {} }));
afterEach(() => vi.unstubAllGlobals());
it('IP-9 verwendet die bestehenden Listen-, Anlege- und Archivierungsrouten', async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ bezugsgroessen: [], bezugsflaechen: [] }) }));
  vi.stubGlobal('fetch', fetch);
  expect(await api.bezugsgroessen()).toEqual({ bezugsgroessen: [], bezugsflaechen: [] });
  const body = { name: 'Produktion', wertart: 'periodenwert' as const, einheit: 'kg', periode_art: 'monat' as const, geltung_art: 'standort' as const, geltung_id: 'standort' };
  await api.bezugsgroesseAnlegen(body);
  await api.bezugsgroesseArchivieren('bezugs-id');
  expect(fetch.mock.calls).toMatchObject([
    [expect.stringContaining('/api/v1/bezugsgroessen'), expect.anything()],
    [expect.stringContaining('/api/v1/bezugsgroessen'), { method: 'POST', body: JSON.stringify(body) }],
    [expect.stringContaining('/api/v1/bezugsgroessen/bezugs-id/archivieren'), { method: 'POST' }],
  ]);
});
