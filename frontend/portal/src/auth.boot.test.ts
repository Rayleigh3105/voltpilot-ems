/**
 * Boot-path behavior of auth.ts (white-page fix): corrupt stored tokens are
 * treated as absent, throttled refreshes keep the tokens + set the rate-limit
 * flag, definitive refusals do not retry, and the check-sso init disables the
 * login-status iframe (a proven unbounded-hang source in keycloak-js 26).
 *
 * Plus the tab token store (2026-08-07): a NORMAL Keycloak login feeds the same
 * store the registration path uses, so the next load takes the one-request
 * refresh path - and EVERY way that can fail degrades to check-sso.
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

/**
 * Faithful stand-in for what keycloak-js does on a SUCCESSFUL init: it publishes
 * the session on the instance. `function` (not an arrow) so `this` is the
 * keycloak singleton the module under test holds.
 */
function initSucceedsWith(tokens: { access: string; refresh: string; id?: string }) {
  initMock.mockImplementation(function (this: Record<string, unknown>) {
    this['token'] = tokens.access;
    this['refreshToken'] = tokens.refresh;
    this['idToken'] = tokens.id;
    return Promise.resolve(true);
  });
}

const storedNow = () => JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY) ?? 'null');

const TOKEN_STORE_KEY = 'vp.auth.tokens';

function kcResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

async function freshAuthModule() {
  vi.resetModules();
  return import('./auth');
}

describe('auth boot paths', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    initMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('corrupt stored tokens are discarded (logged) and the boot proceeds to check-sso', async () => {
    sessionStorage.setItem(TOKEN_STORE_KEY, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initMock.mockResolvedValue(false);

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(false);

    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({ onLoad: 'check-sso', checkLoginIframe: false }),
    );
    warn.mockRestore();
  });

  it('a stored token set without a refresh_token counts as corrupt too', async () => {
    sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify({ access_token: 'a' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initMock.mockResolvedValue(false);

    const { initAuth } = await freshAuthModule();
    await initAuth();

    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a 429-throttled refresh keeps the stored tokens, does NOT retry, and flags rate-limited', async () => {
    const stored = { access_token: 'a', refresh_token: 'r' };
    sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(stored));
    fetchMock.mockResolvedValue(kcResponse(429, { error: 'slow_down' }));
    initMock.mockResolvedValue(false);

    const { initAuth, wasRateLimited, wasSessionExpired } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wasRateLimited()).toBe(true);
    expect(wasSessionExpired()).toBe(false);
    // Tokens survive: once the window passes, a reload can still refresh them.
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBe(JSON.stringify(stored));
  });

  it('a Keycloak brute-force lockout ("temporarily disabled") counts as rate-limited', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    );
    fetchMock.mockResolvedValue(
      kcResponse(400, { error: 'invalid_grant', error_description: 'Account temporarily disabled' }),
    );
    initMock.mockResolvedValue(false);

    const { initAuth, wasRateLimited } = await freshAuthModule();
    await initAuth();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wasRateLimited()).toBe(true);
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).not.toBeNull();
  });

  it('a definitive 400 refusal clears the store without a pointless retry and flags session-expired', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    );
    fetchMock.mockResolvedValue(
      kcResponse(400, { error: 'invalid_grant', error_description: 'Token is not active' }),
    );
    initMock.mockResolvedValue(false);

    const { initAuth, wasRateLimited, wasSessionExpired } = await freshAuthModule();
    await initAuth();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wasSessionExpired()).toBe(true);
    expect(wasRateLimited()).toBe(false);
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('a transient network failure is retried once, then treated as an expired session', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    );
    fetchMock.mockRejectedValue(new TypeError('network down'));
    initMock.mockResolvedValue(false);

    const { initAuth, wasSessionExpired } = await freshAuthModule();
    await initAuth();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wasSessionExpired()).toBe(true);
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('a successful refresh injects the tokens into keycloak.init without the SSO iframe check', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'old-a', refresh_token: 'old-r' }),
    );
    fetchMock.mockResolvedValue(
      kcResponse(200, { access_token: 'new-a', refresh_token: 'new-r', id_token: 'new-i' }),
    );
    initMock.mockResolvedValue(true);

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'new-a',
        refreshToken: 'new-r',
        idToken: 'new-i',
        checkLoginIframe: false,
      }),
    );
    expect(JSON.parse(sessionStorage.getItem(TOKEN_STORE_KEY)!)).toEqual({
      access_token: 'new-a',
      refresh_token: 'new-r',
      id_token: 'new-i',
    });
  });
});

describe('the tab token store is fed by the NORMAL Keycloak login too', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    initMock.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an authenticated check-sso boot remembers the session (the whole point)', async () => {
    initSucceedsWith({ access: 'kc-a', refresh: 'kc-r', id: 'kc-i' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    // The slow path ran exactly once, and nothing was refreshed on the way in.
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ onLoad: 'check-sso' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedNow()).toEqual({ access_token: 'kc-a', refresh_token: 'kc-r', id_token: 'kc-i' });
  });

  it('the NEXT boot then takes the ONE-request refresh path instead of check-sso', async () => {
    // What the login boot above left behind.
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'kc-a', refresh_token: 'kc-r', id_token: 'kc-i' }),
    );
    fetchMock.mockResolvedValue(
      kcResponse(200, { access_token: 'a2', refresh_token: 'r2', id_token: 'i2' }),
    );
    initSucceedsWith({ access: 'a2', refresh: 'r2', id: 'i2' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain('grant_type=refresh_token');
    // No SSO dance: no onLoad, no silent-check-sso iframe, no login-status iframe.
    const opts = initMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts['onLoad']).toBeUndefined();
    expect(opts['silentCheckSsoRedirectUri']).toBeUndefined();
    expect(opts).toMatchObject({ token: 'a2', refreshToken: 'r2', checkLoginIframe: false });
    expect(storedNow()).toEqual({ access_token: 'a2', refresh_token: 'r2', id_token: 'i2' });
  });

  it('a rotated token keeps the store current, so a reload never presents a superseded one', async () => {
    initSucceedsWith({ access: 'kc-a', refresh: 'kc-r' });
    const { initAuth, keycloak } = await freshAuthModule();
    await initAuth();

    expect(storedNow()).toMatchObject({ refresh_token: 'kc-r' });
    // keycloak-js rotates in the background and fires the hook.
    keycloak.token = 'rotated-a';
    keycloak.refreshToken = 'rotated-r';
    keycloak.onAuthRefreshSuccess?.();

    expect(storedNow()).toEqual({
      access_token: 'rotated-a',
      refresh_token: 'rotated-r',
      id_token: undefined,
    });
  });

  it('an expired stored session falls back to check-sso, signs in, and re-fills the store', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'old', refresh_token: 'dead' }),
    );
    fetchMock.mockResolvedValue(kcResponse(400, { error: 'invalid_grant' }));
    initSucceedsWith({ access: 'fresh-a', refresh: 'fresh-r' });

    const { initAuth, wasSessionExpired } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ onLoad: 'check-sso' }));
    expect(storedNow()).toMatchObject({ refresh_token: 'fresh-r' });
    // We ARE signed in - the login screen must not be told the session expired.
    expect(wasSessionExpired()).toBe(false);
  });

  it('a throttled stored refresh still reaches check-sso and clears the rate-limit flag on success', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    );
    fetchMock.mockResolvedValue(kcResponse(429, { error: 'slow_down' }));
    initSucceedsWith({ access: 'fresh-a', refresh: 'fresh-r' });

    const { initAuth, wasRateLimited } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ onLoad: 'check-sso' }));
    expect(wasRateLimited()).toBe(false);
    expect(storedNow()).toMatchObject({ refresh_token: 'fresh-r' });
  });

  it('a corrupt store is discarded and the check-sso boot repairs it', async () => {
    sessionStorage.setItem(TOKEN_STORE_KEY, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    initSucceedsWith({ access: 'fresh-a', refresh: 'fresh-r' });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedNow()).toMatchObject({ refresh_token: 'fresh-r' });
    warn.mockRestore();
  });

  it('an UNAUTHENTICATED check-sso boot stores nothing (no session to remember)', async () => {
    initMock.mockResolvedValue(false);

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(false);

    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('an init that authenticates WITHOUT a token pair stores nothing partial', async () => {
    initMock.mockImplementation(function (this: Record<string, unknown>) {
      this['token'] = 'only-access';
      this['refreshToken'] = undefined;
      return Promise.resolve(true);
    });

    const { initAuth } = await freshAuthModule();
    await expect(initAuth()).resolves.toBe(true);

    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('Keycloak unreachable: the refresh is retried, then check-sso decides the outcome', async () => {
    sessionStorage.setItem(
      TOKEN_STORE_KEY,
      JSON.stringify({ access_token: 'a', refresh_token: 'r' }),
    );
    fetchMock.mockRejectedValue(new TypeError('network down'));
    initMock.mockRejectedValue(new Error('keycloak unreachable'));

    const { initAuth } = await freshAuthModule();
    // Rejecting is what main.tsx turns into the German "nicht erreichbar" card;
    // the boot is bounded on top, so it can never hang here.
    await expect(initAuth()).rejects.toThrow('keycloak unreachable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });

  it('logging out and starting a login BOTH empty the store, so no stale session can be injected', async () => {
    initSucceedsWith({ access: 'kc-a', refresh: 'kc-r' });
    const { initAuth, logout, login, keycloak } = await freshAuthModule();
    keycloak.logout = vi.fn();
    keycloak.login = vi.fn();

    await initAuth();
    expect(storedNow()).not.toBeNull();

    logout();
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();

    // ...and the redirect to Keycloak (e.g. to sign in as somebody else) too.
    await initAuth();
    expect(storedNow()).not.toBeNull();
    login();
    expect(sessionStorage.getItem(TOKEN_STORE_KEY)).toBeNull();
  });
});
