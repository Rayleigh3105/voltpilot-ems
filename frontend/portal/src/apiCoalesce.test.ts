import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { request, setKundenbereich, setTenantOverride } from './api';

/** `request` wartet zuerst auf ein frisches Token - erst danach fliegt fetch. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Die Bündelung gleicher GETs (`api.ts`). Gemessen waren 8 von 21
 * anlagenbezogenen Anfragen des Cockpits exakte Doppel; sie entstehen
 * strukturell, weil Schale und Seite dasselbe Lese-Modell brauchen.
 *
 * Die drei Grenzen sind das Eigentliche: nur GET, nur SOLANGE unterwegs, und
 * der Mandant gehört in den Schlüssel.
 */
describe('request: In-flight-Bündelung', () => {
  let calls: string[];
  let release: (() => void)[] = [];

  beforeEach(() => {
    calls = [];
    release = [];
    setTenantOverride(null); setKundenbereich(null);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
        return new Promise((resolve) => {
          release.push(() =>
            resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) } as Response),
          );
        });
      }),
    );
  });

  afterEach(async () => {
    // Jede absichtlich offen gelassene Anfrage abschliessen: ein nie
    // beantworteter Eintrag bliebe sonst unter seinem Schlüssel liegen und
    // der nächste Fall bekäme ihn. (Im Browser antwortet fetch immer - das
    // ist reine Test-Hygiene.)
    release.forEach((r) => r());
    await flush();
    setTenantOverride(null); setKundenbereich(null);
    vi.unstubAllGlobals();
  });

  it('bündelt zwei gleichzeitige GETs auf EINE Anfrage - beide bekommen die Antwort', async () => {
    const a = request('/api/v1/sites/x/entities');
    const b = request('/api/v1/sites/x/entities');
    await flush();
    expect(calls).toHaveLength(1);
    release.forEach((r) => r());
    await expect(a).resolves.toEqual({ ok: 1 });
    await expect(b).resolves.toEqual({ ok: 1 });
  });

  it('bündelt NICHT über die Antwort hinaus - der nächste Takt holt wirklich neu', async () => {
    const a = request('/api/v1/sites/x/entities');
    await flush();
    release.forEach((r) => r());
    await a;
    void request('/api/v1/sites/x/entities');
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('bündelt niemals eine Mutation', async () => {
    void request('/api/v1/sites/x', { method: 'PUT', body: '{}' });
    void request('/api/v1/sites/x', { method: 'PUT', body: '{}' });
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('trennt nach Mandant - ein Umschalten teilt keine fremde Antwort', async () => {
    void request('/api/v1/overview');
    await flush();
    setTenantOverride('tenant-b');
    void request('/api/v1/overview');
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('räumt auch nach einem Fehlschlag auf - der nächste Versuch fliegt wirklich', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('fetch', failing);
    await expect(request('/api/v1/overview')).rejects.toThrow('offline');
    await expect(request('/api/v1/overview')).rejects.toThrow('offline');
    expect(failing).toHaveBeenCalledTimes(2);
  });
  it('bündelt keine Antworten über einen Unterstützer-Kundenbereich-Wechsel', async () => {
    setKundenbereich('ahrenberg'); const a = request('/api/v1/me');
    setKundenbereich('lindach'); const b = request('/api/v1/me');
    await flush(); expect(calls).toHaveLength(2);
    release.forEach(r => r()); await Promise.all([a, b]);
  });

});
