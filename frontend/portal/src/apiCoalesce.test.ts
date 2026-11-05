import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { request, setKundenbereich, setTenantOverride, STARTFENSTER_MS, vergissStartfenster } from './api';

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

  it('Lesen nach Schreiben: nach der Antwort einer Änderung teilt ein neuer Leser keine vorher gestartete Lese-Anfrage', async () => {
    const vorher = request('/api/v1/unternehmen/messbedarf');
    await flush();
    const aenderung = request('/api/v1/unternehmen/energieeinsaetze/e/messbedarf/m/einloesen', { method: 'POST', body: '{}' });
    await flush();
    // Die Änderung antwortet zuerst; das Lesen von davor ist noch unterwegs.
    release[1]();
    await aenderung;
    const nachher = request('/api/v1/unternehmen/messbedarf');
    await flush();
    expect(calls.map((c) => c.replace(/https?:\/\/[^/]+/, ''))).toEqual([
      'GET /api/v1/unternehmen/messbedarf',
      'POST /api/v1/unternehmen/energieeinsaetze/e/messbedarf/m/einloesen',
      'GET /api/v1/unternehmen/messbedarf',
    ]);
    // Die alte Anfrage räumt beim Antworten nicht den Eintrag der neuen weg: ein dritter Leser teilt die neue.
    release[0]();
    await vorher;
    void request('/api/v1/unternehmen/messbedarf');
    await flush();
    expect(calls).toHaveLength(3);
    release[2]();
    await nachher;
  });

  it('auch eine gescheiterte Änderung beendet das Teilen - ob sie schrieb, weiß nur der Server', async () => {
    const lesen = vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      if (init?.method === 'PUT') return Promise.reject(new Error('offline'));
      return new Promise((resolve) => {
        release.push(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: 1 }) } as Response));
      });
    });
    vi.stubGlobal('fetch', lesen);
    void request('/api/v1/overview');
    await flush();
    await expect(request('/api/v1/sites/x', { method: 'PUT', body: '{}' })).rejects.toThrow('offline');
    void request('/api/v1/overview');
    await flush();
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2);
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

  /**
   * Das Startfenster der Funktionen (Rang 6): der App-Start liest `/funktionen` drei Mal, versetzt um
   * 100-300 ms - die Antwort wird kurz über das Ende des Fluges hinaus geteilt, nur für diese Route.
   */
  describe('Startfenster der Funktionen', () => {
    let jetzt: number;
    beforeEach(() => {
      jetzt = 1_000_000;
      vergissStartfenster();
      vi.spyOn(Date, 'now').mockImplementation(() => jetzt);
    });
    afterEach(() => vi.restoreAllMocks());

    const antworten = async () => {
      release.forEach((r) => r());
      await flush();
    };

    it('teilt die Antwort auch NACH dem Flug, solange das Fenster offen ist', async () => {
      const a = request('/api/v1/funktionen');
      await flush();
      await antworten();
      await a;
      jetzt += 300;
      await expect(request('/api/v1/funktionen')).resolves.toEqual({ ok: 1 });
      expect(calls).toHaveLength(1);
    });

    it('fragt nach Ablauf des Fensters wieder neu - die Veraltung ist begrenzt', async () => {
      const a = request('/api/v1/funktionen');
      await flush();
      await antworten();
      await a;
      jetzt += STARTFENSTER_MS;
      void request('/api/v1/funktionen');
      await flush();
      expect(calls).toHaveLength(2);
    });

    it('eine Änderung leert das Fenster sofort - Lesen nach Schreiben', async () => {
      const a = request('/api/v1/funktionen');
      await flush();
      await antworten();
      await a;
      const aenderung = request('/api/v1/sites/x', { method: 'PUT', body: '{}' });
      await flush();
      release[1]();
      await aenderung;
      jetzt += 100;
      void request('/api/v1/funktionen');
      await flush();
      expect(calls.filter((c) => c.includes('/funktionen'))).toHaveLength(2);
    });

    it('gilt nur für die Funktionen - jede andere Route holt nach dem Flug wirklich neu', async () => {
      const a = request('/api/v1/sites/x/entities');
      await flush();
      await antworten();
      await a;
      jetzt += 100;
      void request('/api/v1/sites/x/entities');
      await flush();
      expect(calls).toHaveLength(2);
    });

    it('teilt eine Ablehnung nie - der nächste Versuch fliegt wirklich', async () => {
      const failing = vi.fn(() => Promise.reject(new Error('offline')));
      vi.stubGlobal('fetch', failing);
      await expect(request('/api/v1/funktionen')).rejects.toThrow('offline');
      await expect(request('/api/v1/funktionen')).rejects.toThrow('offline');
      expect(failing).toHaveBeenCalledTimes(2);
    });

    it('trennt nach Mandant', async () => {
      const a = request('/api/v1/funktionen');
      await flush();
      await antworten();
      await a;
      setTenantOverride('tenant-b');
      void request('/api/v1/funktionen');
      await flush();
      expect(calls).toHaveLength(2);
    });
  });
});
