/**
 * Konzept Nachweisen n1, Inventur A16: Datei-Abrufe (Berichtsstand, Verzeichnis, Wiedervorlage) tragen dieselbe Wahl
 * des Kundenbereichs wie jeder andere Abruf - `X-Kundenbereich`, ohne ihn der Plattform-Umschalter `X-Tenant-Id`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  freshToken: async () => 'token',
}));

import { api, setKundenbereich, setTenantOverride } from './api';

const kopf = () => (vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers ?? {}) as Record<string, string>;

describe('Datei-Abrufe mit dem Kundenbereich (A16)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['x']), { status: 200 })));
  });
  afterEach(() => {
    setKundenbereich(null);
    setTenantOverride(null);
    vi.unstubAllGlobals();
  });

  it('Bericht, Verzeichnis und Wiedervorlage senden X-Kundenbereich wie `request`', async () => {
    setKundenbereich('kb-ahrenberg');
    setTenantOverride('kb-ahrenberg');
    for (const abruf of [
      () => api.berichtDatei('BR-2026-0001', 1, 'pdf'),
      () => api.energiemanagementVerzeichnisCsv({}),
      () => api.energiemanagementWiedervorlageIcs(),
    ]) {
      await abruf();
      expect(kopf()).toMatchObject({ Authorization: 'Bearer token', 'X-Kundenbereich': 'kb-ahrenberg' });
      expect(kopf()).not.toHaveProperty('X-Tenant-Id');
    }
  });

  it('ohne Kundenbereich der Plattform-Umschalter, ohne beides kein Kopf', async () => {
    setTenantOverride('mandant-1');
    await api.berichtDatei('BR-2026-0001', 1, 'csv');
    expect(kopf()).toMatchObject({ 'X-Tenant-Id': 'mandant-1' });
    setTenantOverride(null);
    await api.berichtDatei('BR-2026-0001', 1, 'csv');
    expect(Object.keys(kopf())).toEqual(['Authorization']);
  });
});
