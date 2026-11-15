/**
 * Eine Keycloak-Runde vor dem ersten Bild (Performance Welle 3, Idee 1).
 *
 * Bis hierher lief jeder Aufruf mit gespeicherter Sitzung durch ZWEI Token-Abrufe hintereinander, bevor `/me`
 * hinausging: den eigenen in `refreshStoredTokens` und den erzwungenen von keycloak-js im `init`
 * (`updateToken(-1)`, nur um den Uhrversatz zu lernen). Jetzt übernimmt `init` die eben geprüften Tokens mit dem
 * Versatz aus genau diesem Abruf.
 *
 * Diese Fälle fahren das ECHTE keycloak-js (nur `fetch` ist gestellt), denn was hier zählt, entscheidet die
 * Bibliothek: wie oft sie den Token-Endpunkt ruft, wann ein Token als abgelaufen gilt (`timeSkew`) und wann der
 * `onTokenExpired`-Zeitgeber feuert. Auf der Basis ist „genau ein Abruf“ rot (zwei).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Auth = typeof import('./auth');

const TOKEN_STORE_KEY = 'vp.auth.tokens';
const LEBENSDAUER_S = 900; // accessTokenLifespan des Realms (infra/local/keycloak/voltpilot-realm.json)

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Ein Token, wie Keycloak es ausstellt - `iat`/`exp` nach der Uhr des SERVERS. */
function jwt(iat: number, extra: Record<string, unknown> = {}): string {
  return [
    b64url({ alg: 'RS256', typ: 'JWT' }),
    b64url({
      iat,
      exp: iat + LEBENSDAUER_S,
      sub: 'kunde-1',
      sid: 'sitzung-1',
      realm_access: { roles: ['tenant-user'] },
      ...extra,
    }),
    'signatur',
  ].join('.');
}

/** Gestellter Token-Endpunkt: Keycloaks Uhr läuft um `versatzS` hinter der des Geräts (positiv = Gerät vor). */
function tokenEndpunkt(versatzS = 0) {
  let n = 0;
  const antworten: Array<() => Response> = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (!String(url).includes('/protocol/openid-connect/token')) throw new Error(`unerwarteter Abruf ${String(url)}`);
    const naechste = antworten.shift();
    if (naechste) return naechste();
    n += 1;
    const serverJetzt = Math.floor(Date.now() / 1000) - versatzS;
    return new Response(
      JSON.stringify({
        access_token: jwt(serverJetzt, { n }),
        refresh_token: jwt(serverJetzt, { typ: 'Refresh', n }),
        id_token: jwt(serverJetzt, { typ: 'ID', n }),
        expires_in: LEBENSDAUER_S,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return {
    fetchMock,
    /** Die nächste Antwort ist eine Ablehnung (abgelaufene Sitzung). */
    lehntAb() {
      antworten.push(
        () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Session not active' }), { status: 400 }),
      );
    },
    tokenAbrufe: () => fetchMock.mock.calls.length,
  };
}

function speichere(accessIat: number) {
  sessionStorage.setItem(
    TOKEN_STORE_KEY,
    JSON.stringify({ access_token: jwt(accessIat), refresh_token: jwt(accessIat, { typ: 'Refresh' }) }),
  );
}

async function frischesAuth(): Promise<Auth> {
  vi.resetModules();
  const auth = await import('./auth');
  // Wie `main.tsx`: der Zeitgeber hält das Token im Hintergrund frisch.
  auth.keycloak.onTokenExpired = () => {
    void auth.keycloak.updateToken(30).catch(() => {});
  };
  return auth;
}

const jetztS = () => Math.floor(Date.now() / 1000);

describe('eine Keycloak-Runde vor /me (echtes keycloak-js)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-15T09:00:00Z'));
    // keycloak-js warnt in jsdom über den fehlenden „secure context“ und loggt jede Erneuerung.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('frischer Token: genau EIN Token-Abruf bis zur fertigen Anmeldung, danach keiner, solange das Token gilt', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS() - 60);
    const auth = await frischesAuth();

    await expect(auth.initAuth()).resolves.toBe(true);

    expect(kc.tokenAbrufe()).toBe(1);
    expect(auth.keycloak.authenticated).toBe(true);
    expect(auth.keycloak.timeSkew).toBe(0);
    // Es ist das Token aus DIESEM Abruf, und genau das liegt im Speicher für den nächsten Aufruf.
    const gespeichert = JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY)!);
    expect(auth.keycloak.token).toBe(gespeichert.access_token);
    expect(auth.keycloak.refreshToken).toBe(gespeichert.refresh_token);
    expect(auth.keycloak.tokenParsed?.['n']).toBe(1);

    await expect(auth.freshToken()).resolves.toBe(gespeichert.access_token);
    expect(kc.tokenAbrufe()).toBe(1);
  });

  it('abgelaufener Access-Token mit gültigem Refresh-Token: ein Abruf erneuert, die Seite startet angemeldet', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS() - 3 * LEBENSDAUER_S); // längst abgelaufen
    const auth = await frischesAuth();

    await expect(auth.initAuth()).resolves.toBe(true);

    expect(kc.tokenAbrufe()).toBe(1);
    expect(auth.keycloak.isTokenExpired(30)).toBe(false);
    expect(auth.wasSessionExpired()).toBe(false);
  });

  it('erneuert erst 30 s vor Ablauf - nicht früher (kein Token länger als bisher) und nicht später', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS());
    const auth = await frischesAuth();
    await auth.initAuth();

    vi.setSystemTime(Date.now() + (LEBENSDAUER_S - 31) * 1000);
    await auth.freshToken();
    expect(kc.tokenAbrufe()).toBe(1);

    vi.setSystemTime(Date.now() + 2_000);
    await auth.freshToken();
    expect(kc.tokenAbrufe()).toBe(2);
    expect(auth.keycloak.tokenParsed?.['n']).toBe(2);
  });

  it('abgelaufener Refresh-Token beim Start: keine Übernahme, Speicher leer, die Anmeldung übernimmt (check-sso)', async () => {
    const kc = tokenEndpunkt();
    kc.lehntAb();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS() - 50_000);
    const auth = await frischesAuth();
    // check-sso öffnet in jsdom ein Iframe - hier zählt nur, DASS der Start dorthin fällt.
    const init = vi.spyOn(auth.keycloak, 'init').mockResolvedValue(false);

    await expect(auth.initAuth()).resolves.toBe(false);

    expect(kc.tokenAbrufe()).toBe(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0]?.[0]).toMatchObject({ onLoad: 'check-sso' });
    expect(init.mock.calls[0]?.[0]).not.toHaveProperty('token');
    expect(auth.wasSessionExpired()).toBe(true);
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('abgelaufener Refresh-Token während der Sitzung: die nächste Anfrage führt zur Anmeldung', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS());
    const auth = await frischesAuth();
    await auth.initAuth();
    const login = vi.spyOn(auth.keycloak, 'login').mockResolvedValue(undefined);

    vi.setSystemTime(Date.now() + 2 * LEBENSDAUER_S * 1000);
    kc.lehntAb();
    await expect(auth.freshToken()).rejects.toBeInstanceOf(auth.AuthRedirectError);

    expect(login).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('Abmelden: der Speicher ist leer, Keycloak beendet die Sitzung - wie bisher', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS());
    const auth = await frischesAuth();
    await auth.initAuth();
    const logout = vi.spyOn(auth.keycloak, 'logout').mockResolvedValue(undefined);

    auth.logout();

    expect(logout).toHaveBeenCalledWith({ redirectUri: window.location.origin });
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
    expect(localStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it.each([
    ['Gerät 10 min vor', 600],
    ['Gerät 10 min nach', -600],
  ])('Uhrversatz (%s): Ablauf nach der Uhr des Servers, derselbe Versatz wie keycloak-js ihn selbst lernt', async (_, versatzS) => {
    const kc = tokenEndpunkt(versatzS);
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS() - versatzS);
    const auth = await frischesAuth();

    await auth.initAuth();

    expect(kc.tokenAbrufe()).toBe(1);
    expect(auth.keycloak.timeSkew).toBe(versatzS);
    // Gleich nach dem Start gilt das Token - ohne Versatz hielte die Bibliothek es (Gerät vor) für abgelaufen
    // und frischte bei JEDER Anfrage auf, oder (Gerät nach) zu spät.
    await auth.freshToken();
    expect(kc.tokenAbrufe()).toBe(1);
    vi.setSystemTime(Date.now() + (LEBENSDAUER_S - 29) * 1000);
    await auth.freshToken();
    expect(kc.tokenAbrufe()).toBe(2);
    // Die eigene Erneuerung von keycloak-js kommt zum selben Versatz.
    expect(auth.keycloak.timeSkew).toBe(versatzS);
  });

  it('der Ablauf-Zeitgeber steht nach dem Start und feuert, wenn das Token abläuft (nach der Uhr des Servers)', async () => {
    const kc = tokenEndpunkt(600);
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS() - 600);
    const auth = await frischesAuth();
    await auth.initAuth();
    expect(auth.keycloak.tokenTimeoutHandle).toBeDefined();

    await vi.advanceTimersByTimeAsync((LEBENSDAUER_S - 1) * 1000);
    expect(kc.tokenAbrufe()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(kc.tokenAbrufe()).toBe(2);
    expect(auth.keycloak.isTokenExpired(30)).toBe(false);
  });

  it('Wiederaufnahme nach Ruhezustand / Hintergrund-Tab: der Zeitgeber kam nicht, die nächste Anfrage erneuert genau einmal', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS());
    const auth = await frischesAuth();
    await auth.initAuth();

    // Ruhezustand: die Wanduhr springt zwei Stunden, kein Zeitgeber lief (gedrosselter Tab, Rechner schlief).
    vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
    const tokens = await Promise.all([auth.freshToken(), auth.freshToken(), auth.freshToken()]);

    expect(kc.tokenAbrufe()).toBe(2);
    expect(new Set(tokens).size).toBe(1);
    expect(auth.keycloak.tokenParsed?.['n']).toBe(2);
    expect(JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY)!).access_token).toBe(tokens[0]);
  });

  it('ohne lesbares iat bleibt der alte Weg: keycloak-js frischt selbst auf (langsamer, nie falsch)', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    kc.fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          access_token: [b64url({ alg: 'RS256' }), b64url({ exp: jetztS() + LEBENSDAUER_S }), 's'].join('.'),
          refresh_token: jwt(jetztS(), { typ: 'Refresh' }),
        }),
        { status: 200 },
      ),
    );
    speichere(jetztS());
    const auth = await frischesAuth();

    await expect(auth.initAuth()).resolves.toBe(true);

    expect(kc.tokenAbrufe()).toBe(2);
    expect(auth.keycloak.timeSkew).toBe(0);
  });

  it('nach dem Start erneuert keycloak-js wieder selbst - die Umgehung gilt nur für die Übernahme im init', async () => {
    const kc = tokenEndpunkt();
    vi.stubGlobal('fetch', kc.fetchMock);
    speichere(jetztS());
    const auth = await frischesAuth();
    await auth.initAuth();

    await expect(auth.keycloak.updateToken(-1)).resolves.toBe(true);
    expect(kc.tokenAbrufe()).toBe(2);
  });
});
