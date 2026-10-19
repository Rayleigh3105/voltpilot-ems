import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushBeiAbmeldenAufraeumen, urlBase64AlsBytes } from './push';

vi.mock('./auth', () => ({ freshToken: async () => 'test', AuthRedirectError: class extends Error {} }));

describe('urlBase64AlsBytes', () => {
  it('dekodiert einen ungepolsterten, URL-sicheren Base64-Text', () => {
    // "VoltPilot" als Bytes, URL-sicher ohne Füllzeichen kodiert.
    const text = btoa('VoltPilot').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const bytes = urlBase64AlsBytes(text);
    const zurueck = String.fromCharCode(...bytes);
    expect(zurueck).toBe('VoltPilot');
  });

  it('liefert die erwartete Länge für einen 65-Byte-Schlüssel', () => {
    const roh = new Uint8Array(65).fill(7);
    let bin = '';
    roh.forEach((b) => {
      bin += String.fromCharCode(b);
    });
    const text = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(urlBase64AlsBytes(text)).toHaveLength(65);
  });
});

describe('pushBeiAbmeldenAufraeumen (B8: Push auf geteilten Geräten)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { PushManager?: unknown }).PushManager;
    delete (window as { Notification?: unknown }).Notification;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it('tut nichts, wenn der Browser Push gar nicht unterstützt', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await pushBeiAbmeldenAufraeumen();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('beendet das Browser-Abo DIESES Geräts und meldet es beim Server ab', async () => {
    (window as unknown as { PushManager: unknown }).PushManager = class {};
    (window as unknown as { Notification: unknown }).Notification = class {};
    const unsubscribe = vi.fn(async () => true);
    const abo = { endpoint: 'https://push.example/geteiltes-geraet', unsubscribe };
    (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
      getRegistration: async () => ({ pushManager: { getSubscription: async () => abo } }),
    };
    const fetch = vi.fn(async () => ({ ok: true, status: 204, json: async () => undefined }));
    vi.stubGlobal('fetch', fetch);

    await pushBeiAbmeldenAufraeumen();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/v1/zustellwege/push?endpoint=${encodeURIComponent(abo.endpoint)}`);
    expect(init).toMatchObject({ method: 'DELETE' });
  });

  it('ohne ein aktives Abo meldet sich nichts beim Server ab', async () => {
    (window as unknown as { PushManager: unknown }).PushManager = class {};
    (window as unknown as { Notification: unknown }).Notification = class {};
    (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
      getRegistration: async () => ({ pushManager: { getSubscription: async () => null } }),
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await pushBeiAbmeldenAufraeumen();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('ist bestmöglich: ein Fehler beim Aufräumen darf das Abmelden nie aufhalten', async () => {
    (window as unknown as { PushManager: unknown }).PushManager = class {};
    (window as unknown as { Notification: unknown }).Notification = class {};
    (navigator as unknown as { serviceWorker: unknown }).serviceWorker = {
      getRegistration: async () => {
        throw new Error('kaputt');
      },
    };

    await expect(pushBeiAbmeldenAufraeumen()).resolves.toBeUndefined();
  });
});
