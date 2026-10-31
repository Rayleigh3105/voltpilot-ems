/**
 * The token store in the INSTALLED app (PWA, display-mode standalone) versus a
 * browser tab (2026-10-31). Every app start is a fresh browsing context, so the
 * sessionStorage store died with each close; the app now keeps its token set in
 * localStorage. A tab keeps the sessionStorage store and never reads, writes or
 * drops the app's persisted copy on the way in - only "Abmelden" clears it from
 * everywhere. platform-admin never persists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { initMock } = vi.hoisted(() => ({ initMock: vi.fn() }));

vi.mock('keycloak-js', () => ({
  default: class KeycloakMock {
    init = initMock;
    token: string | undefined;
    refreshToken: string | undefined;
    idToken: string | undefined;
    onAuthRefreshSuccess: (() => void) | undefined;
  },
}));

const TOKEN_STORE_KEY = 'vp.auth.tokens';

/** A Keycloak-shaped access token carrying these realm roles (signature irrelevant). */
function accessToken(roles: string[], name = 'Jürgen Kunde'): string {
  const teil = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${teil({ alg: 'RS256', typ: 'JWT' })}.${teil({ name, realm_access: { roles } })}.sig`;
}

const KUNDE = accessToken(['default-roles-voltpilot', 'offline_access']);
const KUNDE_ROTIERT = accessToken(['default-roles-voltpilot'], 'Kunde rotiert');
const BETRIEB = accessToken(['default-roles-voltpilot', 'platform-admin']);

function initSucceedsWith(tokens: { access: string; refresh: string; id?: string }) {
  initMock.mockImplementation(function (this: Record<string, unknown>) {
    this['token'] = tokens.access;
    this['refreshToken'] = tokens.refresh;
    this['idToken'] = tokens.id;
    return Promise.resolve(true);
  });
}

const imApp = () => JSON.parse(localStorage.getItem(TOKEN_STORE_KEY) ?? 'null');
const imTab = () => JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY) ?? 'null');

function kcResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The display mode the browser reports: an installed app or a plain tab. */
function anzeige(standalone: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: standalone && q === '(display-mode: standalone)',
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

async function freshAuthModule() {
  vi.resetModules();
  return import('./auth');
}

const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  initMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { standalone?: boolean }).standalone;
});

describe('installed app: the session survives closing the app', () => {
  beforeEach(() => anzeige(true));

  it('a login in the app is persisted in localStorage, not in the window store', async () => {
    initSucceedsWith({ access: KUNDE, refresh: 'kc-r', id: 'kc-i' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(imApp()).toEqual({ access_token: KUNDE, refresh_token: 'kc-r', id_token: 'kc-i' });
    expect(imTab()).toBeNull();
  });

  it('the NEXT app start (window store empty) takes the one-request refresh path', async () => {
    localStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: KUNDE, refresh_token: 'kc-r', id_token: 'kc-i' }),
    );
    fetchMock.mockResolvedValue(
      kcResponse(200, { access_token: KUNDE_ROTIERT, refresh_token: 'r2', id_token: 'i2' }),
    );
    initSucceedsWith({ access: KUNDE_ROTIERT, refresh: 'r2', id: 'i2' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toContain('refresh_token=kc-r');
    const opts = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts['onLoad']).toBeUndefined();
    expect(opts).toMatchObject({ token: KUNDE_ROTIERT, refreshToken: 'r2', checkLoginIframe: false });
    expect(imApp()).toEqual({ access_token: KUNDE_ROTIERT, refresh_token: 'r2', id_token: 'i2' });
    expect(imTab()).toBeNull();
  });

  it('a rotated token keeps the persisted store current', async () => {
    initSucceedsWith({ access: KUNDE, refresh: 'kc-r' });
    const { initAuth, keycloak } = await freshAuthModule();
    await initAuth();

    keycloak.token = KUNDE_ROTIERT;
    keycloak.refreshToken = 'rotated-r';
    keycloak.onAuthRefreshSuccess?.();

    expect(imApp()).toMatchObject({ access_token: KUNDE_ROTIERT, refresh_token: 'rotated-r' });
  });

  it('platform-admin never persists: its set stays in the window store, an old copy is dropped', async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'alt' }));
    fetchMock.mockResolvedValue(kcResponse(200, { access_token: BETRIEB, refresh_token: 'b-r' }));
    initSucceedsWith({ access: BETRIEB, refresh: 'b-r' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(imApp()).toBeNull();
    expect(imTab()).toMatchObject({ access_token: BETRIEB, refresh_token: 'b-r' });
  });

  it('platform-admin signing in by the Keycloak login stays in the window store', async () => {
    initSucceedsWith({ access: BETRIEB, refresh: 'b-r' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(imApp()).toBeNull();
    expect(imTab()).toMatchObject({ refresh_token: 'b-r' });
  });

  it('an unreadable access token counts as platform-admin (fail closed: not persisted)', async () => {
    initSucceedsWith({ access: 'kein-jwt', refresh: 'kc-r' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(imApp()).toBeNull();
    expect(imTab()).toMatchObject({ refresh_token: 'kc-r' });
  });

  it('a refused refresh (session over) drops the persisted set and falls back to check-sso', async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'dead' }));
    fetchMock.mockResolvedValue(kcResponse(400, { error: 'invalid_grant' }));
    initMock.mockResolvedValue(false);

    const { initAuth, wasSessionExpired } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ onLoad: 'check-sso' }));
    expect(imApp()).toBeNull();
    expect(wasSessionExpired()).toBe(true);
  });

  it('Keycloak unreachable at app start KEEPS the persisted set (no signal is no refusal)', async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'r' }));
    fetchMock.mockRejectedValue(new TypeError('network down'));
    initMock.mockRejectedValue(new Error('keycloak unreachable'));

    const { initAuth, wasSessionExpired } = await freshAuthModule();
    await expect(initAuth()).rejects.toThrow('keycloak unreachable');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(imApp()).toMatchObject({ refresh_token: 'r' });
    expect(wasSessionExpired()).toBe(false);
  });

  it('a 5xx from Keycloak keeps the persisted set as well', async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'r' }));
    fetchMock.mockResolvedValue(kcResponse(503, {}));
    initMock.mockResolvedValue(false);

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(imApp()).toMatchObject({ refresh_token: 'r' });
  });

  it('a corrupt persisted set is discarded and the boot proceeds to check-sso', async () => {
    localStorage.setItem(TOKEN_STORE_KEY, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initMock.mockResolvedValue(false);

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(imApp()).toBeNull();
    warn.mockRestore();
  });

  it('logout clears the persisted set and ends the Keycloak session; login() clears it too', async () => {
    initSucceedsWith({ access: KUNDE, refresh: 'kc-r' });
    const { initAuth, logout, login, keycloak } = await freshAuthModule();
    keycloak.logout = vi.fn();
    keycloak.login = vi.fn();

    await initAuth();
    expect(imApp()).not.toBeNull();
    logout();
    expect(imApp()).toBeNull();
    expect(imTab()).toBeNull();
    expect(keycloak.logout).toHaveBeenCalledTimes(1);

    await initAuth();
    expect(imApp()).not.toBeNull();
    login();
    expect(imApp()).toBeNull();
  });

  it('the registration grant inside the app is persisted, too', async () => {
    fetchMock.mockResolvedValue(kcResponse(200, { access_token: KUNDE, refresh_token: 'pw-r' }));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });

    const { loginWithCredentials } = await freshAuthModule();
    await loginWithCredentials('kunde@example.org', 'zwoelf-zeichen');

    expect(String((fetchMock.mock.calls[0][1] as RequestInit).body)).toContain('grant_type=password');
    expect(imApp()).toMatchObject({ refresh_token: 'pw-r' });
    expect(imTab()).toBeNull();
    expect(reload).toHaveBeenCalled();
  });

  it("iOS: Apple's own navigator.standalone marks the installed app as well", async () => {
    anzeige(false);
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    initSucceedsWith({ access: KUNDE, refresh: 'kc-r' });

    const { initAuth } = await freshAuthModule();
    await initAuth();

    expect(imApp()).toMatchObject({ refresh_token: 'kc-r' });
    expect(imTab()).toBeNull();
  });
});

describe('browser tab: today\'s store, the app copy left alone', () => {
  beforeEach(() => anzeige(false));

  it('a login in a tab stays in sessionStorage', async () => {
    initSucceedsWith({ access: KUNDE, refresh: 'kc-r' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(imTab()).toMatchObject({ refresh_token: 'kc-r' });
    expect(imApp()).toBeNull();
  });

  it("a tab never boots from the app's persisted set (Android/desktop share the origin storage)", async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'app-r' }));
    initSucceedsWith({ access: KUNDE_ROTIERT, refresh: 'tab-r' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    // No refresh grant with the app's token: the tab went the check-sso way.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ onLoad: 'check-sso' }));
    expect(imTab()).toMatchObject({ refresh_token: 'tab-r' });
    expect(imApp()).toMatchObject({ refresh_token: 'app-r' });
  });

  it("a refused tab refresh or a login redirect leaves the app's persisted set alone", async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'app-r' }));
    sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'tab-dead' }));
    fetchMock.mockResolvedValue(kcResponse(400, { error: 'invalid_grant' }));
    initMock.mockResolvedValue(false);

    const { initAuth, login, keycloak } = await freshAuthModule();
    keycloak.login = vi.fn();
    await expect(initAuth()).resolves.toBe(false);
    login();

    expect(imTab()).toBeNull();
    expect(imApp()).toMatchObject({ refresh_token: 'app-r' });
  });

  it('logout in a tab drops the persisted app set as well (signing out leaves no token behind)', async () => {
    localStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: KUNDE, refresh_token: 'app-r' }));
    initSucceedsWith({ access: KUNDE, refresh: 'tab-r' });
    const { initAuth, logout, keycloak } = await freshAuthModule();
    keycloak.logout = vi.fn();

    await initAuth();
    logout();

    expect(imTab()).toBeNull();
    expect(imApp()).toBeNull();
    expect(keycloak.logout).toHaveBeenCalledTimes(1);
  });
});
