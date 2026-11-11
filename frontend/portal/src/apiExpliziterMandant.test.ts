import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { api, request, setKundenbereich, setTenantOverride } from './api';
import { benutzerApi } from './benutzer';

/**
 * Befund vp-kundenakte-fremde-personen: die Kundenakte von Kunde B zeigte bei offenem
 * Mandanten-Umschalter („Wie der Kunde es sieht" auf Kunde A) die Personen von Kunde A.
 * `bereichKopf` hängte den `X-Kundenbereich` des Umschalters AUCH an Aufrufe mit eigenem
 * `X-Tenant-Id`-Kopf, und die API nahm still den Umschalter.
 *
 * Die Regel: ein Aufruf, der seinen Kunden AUSDRÜCKLICH nennt (per-Aufruf `X-Tenant-Id` wie
 * `benutzerApi.liste(tenantId)` und `api.selbstauskunft(tenantId)`), trägt NIE zusätzlich den
 * Umschalter-Kopf. Und die In-flight-Bündelung unterscheidet ausdrückliche Mandanten - die
 * Kundenliste fragt `/api/v1/me` je Kunde gleichzeitig ab und darf nie die Antwort des ersten
 * Kunden für alle Zeilen teilen.
 */
describe('Aufrufe mit ausdrücklichem Kunden bei offenem Mandanten-Umschalter', () => {
  const A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const B = 'bbbbbbbb-0000-0000-0000-000000000002';

  const koepfe = () => vi.mocked(fetch).mock.calls.map((c) => (c[1]?.headers ?? {}) as Record<string, string>);

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) =>
      new Response(JSON.stringify({ url, mandant: (init?.headers as Record<string, string>)?.['X-Tenant-Id'] ?? null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })));
    // Der offene Umschalter steht auf Kunde A (App.tsx setzt beide).
    setTenantOverride(A);
    setKundenbereich(A);
  });

  afterEach(() => {
    setKundenbereich(null);
    setTenantOverride(null);
    vi.unstubAllGlobals();
  });

  it('benutzerApi.liste(B) trägt X-Tenant-Id: B und KEINEN X-Kundenbereich', async () => {
    await benutzerApi.liste(B);
    const kopf = koepfe().at(-1)!;
    expect(kopf['X-Tenant-Id']).toBe(B);
    expect(kopf).not.toHaveProperty('X-Kundenbereich');
  });

  it('api.selbstauskunft(B) trägt X-Tenant-Id: B und KEINEN X-Kundenbereich', async () => {
    await api.selbstauskunft(B);
    const kopf = koepfe().at(-1)!;
    expect(kopf['X-Tenant-Id']).toBe(B);
    expect(kopf).not.toHaveProperty('X-Kundenbereich');
  });

  it('ohne ausdrücklichen Kunden bleibt der Umschalter-Kopf wie bisher', async () => {
    await request('/api/v1/benutzer');
    const kopf = koepfe().at(-1)!;
    expect(kopf['X-Kundenbereich']).toBe(A);
    expect(kopf).not.toHaveProperty('X-Tenant-Id');
  });

  it('bündelt /api/v1/me NICHT über verschiedene ausdrückliche Kunden (Kundenliste: Zustand je Zeile)', async () => {
    const [a, b] = await Promise.all([api.selbstauskunft(A), api.selbstauskunft(B)]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    expect(a).not.toEqual(b);
  });

  it('bündelt zwei gleichzeitige Abrufe DESSELBEN ausdrücklichen Kunden weiterhin auf eine Anfrage', async () => {
    await Promise.all([api.selbstauskunft(B), api.selbstauskunft(B)]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });
});
