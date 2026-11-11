import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, zustellwegBestaetigen } from './api';

/**
 * Der Link aus der Bestätigungs-Mail (ZustellwegController#bestaetigen, §6.6):
 * sein Endpunkt verlangt bewusst keine Anmeldung, darum geht `zustellwegBestaetigen`
 * - wie `register` - NICHT über `request()`. Kein Auth-Mock nötig: ein Aufruf,
 * der freshToken bräuchte, würde hier mangels Mock sofort durchfallen.
 */
describe('zustellwegBestaetigen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('meldet "bestaetigt" bei 200 OK und schickt keinen Authorization-Header', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200 } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(zustellwegBestaetigen('abc123')).resolves.toBe('bestaetigt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toContain('/api/v1/zustellwege/bestaetigen?token=abc123');
    expect(init?.headers).toBeUndefined();
  });

  it('meldet "abgelaufen" bei 410 - ungültig/abgelaufen/schon verwendet bleiben ununterscheidbar', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 410 } as Response)));
    await expect(zustellwegBestaetigen('irrelevant')).resolves.toBe('abgelaufen');
  });

  it('wirft bei einem unerwarteten Serverfehler einen ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    await expect(zustellwegBestaetigen('abc')).rejects.toBeInstanceOf(ApiError);
  });

  it('kodiert den Token in der Adresse', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    vi.stubGlobal('fetch', fetchMock);
    await zustellwegBestaetigen('a b/c+d');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain(`token=${encodeURIComponent('a b/c+d')}`);
  });
});
