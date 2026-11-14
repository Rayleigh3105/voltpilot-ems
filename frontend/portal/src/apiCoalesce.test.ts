import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { request, setKundenbereich, setTenantOverride, STARTFENSTER_MS, vorabAbrufen } from './api';
import { seitendatenVorab } from './seitenVorab';

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
   * 100-300 ms - der Eintrag bleibt nach der Antwort kurz im Bündel, nur für diese Route.
   */
  describe('Startfenster der Funktionen', () => {
    beforeEach(() => {
      // Nur der Zeitgeber des Fensters ist gefälscht; Promises laufen wie sonst.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(async () => {
      // Das Fenster dieses Falls abschließen, damit der nächste einen leeren Bündel-Stand sieht.
      release.forEach((r) => r());
      await vi.advanceTimersByTimeAsync(STARTFENSTER_MS);
      vi.useRealTimers();
    });

    const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
    const antworten = async () => {
      await tick();
      release.forEach((r) => r());
      await tick();
    };

    it('teilt die Antwort auch NACH dem Flug, solange das Fenster offen ist', async () => {
      const a = request('/api/v1/funktionen');
      await antworten();
      await a;
      await tick(300);
      await expect(request('/api/v1/funktionen')).resolves.toEqual({ ok: 1 });
      expect(calls).toHaveLength(1);
    });

    it('fragt nach Ablauf des Fensters wieder neu - die Veraltung ist begrenzt', async () => {
      const a = request('/api/v1/funktionen');
      await antworten();
      await a;
      await tick(STARTFENSTER_MS);
      void request('/api/v1/funktionen');
      await tick();
      expect(calls).toHaveLength(2);
    });

    it('eine Änderung leert das Fenster sofort - Lesen nach Schreiben', async () => {
      const a = request('/api/v1/funktionen');
      await antworten();
      await a;
      const aenderung = request('/api/v1/sites/x', { method: 'PUT', body: '{}' });
      await tick();
      release[1]();
      await aenderung;
      await tick(100);
      void request('/api/v1/funktionen');
      await tick();
      expect(calls.filter((c) => c.includes('/funktionen'))).toHaveLength(2);
    });

    it('gilt nur für die Funktionen - jede andere Route holt nach dem Flug wirklich neu', async () => {
      const a = request('/api/v1/sites/x/entities');
      await antworten();
      await a;
      await tick(100);
      void request('/api/v1/sites/x/entities');
      await tick();
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
      await antworten();
      await a;
      setTenantOverride('tenant-b');
      void request('/api/v1/funktionen');
      await tick();
      expect(calls).toHaveLength(2);
    });
  });

  /**
   * Vorab-Abrufe nach Route (Performance-Runde vp-perf2-portal, Idee 2): was `vorabAbrufen` stellt, teilt das
   * Startfenster der Funktionen - die Seite, die gleich dieselbe Adresse fragt, bekommt diese Antwort.
   */
  describe('Vorab-Abrufe', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(async () => {
      release.forEach((r) => r());
      await vi.advanceTimersByTimeAsync(STARTFENSTER_MS);
      vi.useRealTimers();
    });

    const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
    const antworten = async () => {
      await tick();
      release.forEach((r) => r());
      await tick();
    };

    it('die Seite fragt dieselbe Adresse nach der Antwort: keine zweite Anfrage im Startfenster', async () => {
      vorabAbrufen([() => request('/api/v1/sites/x/topology')]);
      await antworten();
      await tick(800);
      await expect(request('/api/v1/sites/x/topology')).resolves.toEqual({ ok: 1 });
      expect(calls).toHaveLength(1);
    });

    it('nach dem Startfenster fragt sie wirklich neu - ein Vorab-Abruf wird nie zum Zwischenspeicher', async () => {
      vorabAbrufen([() => request('/api/v1/sites/x/topology')]);
      await antworten();
      await tick(STARTFENSTER_MS);
      void request('/api/v1/sites/x/topology');
      await tick();
      expect(calls).toHaveLength(2);
    });

    it('nur der Vorab-Abruf hält sein Fenster - derselbe Abruf der Seite danach nicht', async () => {
      vorabAbrufen([() => request('/api/v1/sites/x/topology')]);
      await antworten();
      await tick(STARTFENSTER_MS);
      const takt = request('/api/v1/sites/x/topology');
      await antworten();
      await takt;
      await tick(100);
      void request('/api/v1/sites/x/topology');
      await tick();
      expect(calls).toHaveLength(3);
    });

    it('eine Ablehnung wird nie geteilt, und sie bleibt still', async () => {
      const failing = vi.fn(() => Promise.reject(new Error('403')));
      vi.stubGlobal('fetch', failing);
      vorabAbrufen([() => request('/api/v1/sites/fremd/topology')]);
      await tick();
      await expect(request('/api/v1/sites/fremd/topology')).rejects.toThrow('403');
      expect(failing).toHaveBeenCalledTimes(2);
    });

    it('eine Änderung leert das Fenster - Lesen nach Schreiben', async () => {
      vorabAbrufen([() => request('/api/v1/sites/x/schedule')]);
      await antworten();
      const aenderung = request('/api/v1/sites/x', { method: 'PUT', body: '{}' });
      await tick();
      release[1]();
      await aenderung;
      void request('/api/v1/sites/x/schedule');
      await tick();
      expect(calls.filter((c) => c.endsWith('/schedule'))).toHaveLength(2);
    });

    it('seitendatenVorab: Cockpit-Adresse = Grundabrufe und Cockpit, Unterseite = nur Grundabrufe, sonst nichts', async () => {
      seitendatenVorab('#/portfolio');
      seitendatenVorab('#/anlage');
      await tick();
      expect(calls).toEqual([]);
      seitendatenVorab('#/anlage/s-1/modell');
      await tick();
      const pfad = (c: string) => c.replace(/^GET https?:\/\/[^/]+/, 'GET ');
      const unterseite = calls.map(pfad).sort();
      expect(unterseite).toEqual([
        'GET /api/v1/funktionen',
        'GET /api/v1/sites/s-1/entities',
        'GET /api/v1/sites/s-1/entity-strategies',
        'GET /api/v1/sites/s-1/flows',
        'GET /api/v1/sites/s-1/interventions',
        'GET /api/v1/sites/s-1/profile',
        'GET /api/v1/sites/s-1/profiles',
      ]);
      await antworten();
      await tick(STARTFENSTER_MS);
      calls.length = 0;
      seitendatenVorab('#/anlage/s-1');
      await tick();
      expect(calls).toHaveLength(7 + 16);
      expect(calls.map(pfad)).toEqual(expect.arrayContaining([
        'GET /api/v1/overview',
        'GET /api/v1/sites/s-1/topology',
        'GET /api/v1/sites/s-1/earnings?range=day',
        'GET /api/v1/sites/s-1/consumer-status',
        'GET /api/v1/sites/s-1/cockpit-layout',
        'GET /api/v1/sites/s-1/rollen/grid',
      ]));
    });
  });
});
