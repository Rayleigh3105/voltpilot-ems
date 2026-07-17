/**
 * Boot-path behavior of auth.ts (white-page fix): corrupt stored tokens are
 * treated as absent, throttled refreshes keep the tokens + set the rate-limit
 * flag, definitive refusals do not retry, and the check-sso init disables the
 * login-status iframe (a proven unbounded-hang source in keycloak-js 26).
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
