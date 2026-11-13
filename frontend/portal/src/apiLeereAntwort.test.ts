import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { request } from './api';

/**
 * Kunden-Alarmierung B3: `POST /api/v1/zustellwege/email` antwortet 202 OHNE Rumpf. `request` las jede Antwort außer
 * 204 als JSON, warf beim leeren Rumpf und die Einstellungen zeigten „Das hat nicht geklappt“ - die Mail war da schon
 * unterwegs. Ein leerer Rumpf ist kein Fehler, gleich welcher 2xx-Status.
 */
describe('request: leere Antworten', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const status of [200, 201, 202, 204]) {
    it(`ein leerer ${status} ist Erfolg ohne Inhalt, kein Lesefehler`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(status === 204 ? null : '', { status })));
      await expect(request('/api/v1/zustellwege/email', { method: 'POST', body: '{}' })).resolves.toBeUndefined();
    });
  }

  it('ein 202 mit JSON-Rumpf liefert den Rumpf', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ auftrag: 'a1' }, { status: 202 })));
    await expect(request('/api/v1/irgendwas', { method: 'POST', body: '{}' })).resolves.toEqual({ auftrag: 'a1' });
  });

  it('ein kaputter Rumpf bleibt ein Fehler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{kaputt', { status: 200 })));
    await expect(request('/api/v1/sites')).rejects.toThrow();
  });
});
