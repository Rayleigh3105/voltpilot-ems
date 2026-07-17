import Keycloak from 'keycloak-js';

const KC_URL = import.meta.env.VITE_KEYCLOAK_URL ?? 'http://localhost:8081';
const KC_REALM = import.meta.env.VITE_KEYCLOAK_REALM ?? 'voltpilot';
const KC_CLIENT_ID = import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? 'voltpilot-frontend';

/**
 * Keycloak OIDC client for the portal (public client, Authorization Code + PKCE).
 * Config comes from VITE_* env (see .env.example); defaults match the local
 * docker-compose stack.
 */
export const keycloak = new Keycloak({
  url: KC_URL,
  realm: KC_REALM,
  clientId: KC_CLIENT_ID,
});

export interface UserInfo {
  name: string;
  email?: string;
  tenantId?: string;
  roles: string[];
}

/** Realm role that marks a Portal-Admin (platform operator). */
export const PLATFORM_ADMIN_ROLE = 'platform-admin';

/** Realm roles from the access token (Keycloak `realm_access.roles`). */
export function currentRoles(): string[] {
  const t = keycloak.tokenParsed as { realm_access?: { roles?: string[] } } | undefined;
  return t?.realm_access?.roles ?? [];
}

/** True when the logged-in user is a Portal-Admin (sees the admin console). */
export function isPlatformAdmin(): boolean {
  return currentRoles().includes(PLATFORM_ADMIN_ROLE);
}

// ---------------------------------------------------------------------------
// Seamless post-registration login (Direct Access Grant).
//
// A fresh customer just typed their email + password into OUR registration
// form; sending them to the Keycloak login page to type the same credentials
// again would be a pointless second hurdle. Instead the register flow mints
// tokens directly at the token endpoint (grant_type=password on the public
// client) and boots the SPA with them injected into keycloak-js. Because this
// path sets no Keycloak SSO cookie, the tokens are kept in sessionStorage and
// re-validated (refresh grant) on every page load until they expire - then the
// portal simply falls back to the normal redirect login.
// ---------------------------------------------------------------------------

const TOKEN_STORE_KEY = 'vp.auth.tokens';

/**
 * Thrown by freshToken() when it has already triggered a full-page redirect to
 * the Keycloak login (the session is gone). request() catches it and aborts the
 * pending call instead of firing an unauthenticated fetch that would 401 and
 * flash a raw "API-Fehler: 401" at the user just before the redirect lands.
 */
export class AuthRedirectError extends Error {
  constructor() {
    super('auth redirect in progress');
    this.name = 'AuthRedirectError';
  }
}

// Set when a STORED direct-grant session existed but could not be refreshed on
// boot (expired or a persistent failure): the login screen then explains
// "Sitzung abgelaufen" instead of showing a blank card (M5).
let storedSessionExpired = false;

/** True when a stored session was found on boot but its refresh ultimately failed. */
export function wasSessionExpired(): boolean {
  return storedSessionExpired;
}

// Set when the token endpoint refused a boot-path grant with 429 (throttling)
// or a Keycloak brute-force lockout: the login screen then shows the German
// "zu viele Anmeldeversuche" card instead of redirecting or going blank.
let authRateLimited = false;

/** True when a boot-path token grant was refused as throttled/locked out. */
export function wasRateLimited(): boolean {
  return authRateLimited;
}

interface TokenSet {
  access_token: string;
  refresh_token: string;
  id_token?: string;
}

/** Per-request ceiling for direct token-endpoint calls (the boot is bounded on top). */
const TOKEN_GRANT_TIMEOUT_MS = 6_000;

/** A refused token grant, carrying the HTTP status + Keycloak error fields. */
export class TokenGrantError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode?: string,
    readonly errorDescription?: string,
  ) {
    super(`token grant failed: ${status}${errorCode ? ` (${errorCode})` : ''}`);
    this.name = 'TokenGrantError';
  }

  /** 429 throttling or a Keycloak brute-force "temporarily disabled" lockout. */
  get throttled(): boolean {
    return this.status === 429 || /temporarily disabled/i.test(this.errorDescription ?? '');
  }
}

function tokenEndpoint(): string {
  return `${KC_URL.replace(/\/$/, '')}/realms/${KC_REALM}/protocol/openid-connect/token`;
}

async function tokenGrant(form: Record<string, string>): Promise<TokenSet> {
  // Bounded: a hanging token endpoint must never hang the boot (white page).
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: KC_CLIENT_ID, scope: 'openid', ...form }),
    signal: AbortSignal.timeout(TOKEN_GRANT_TIMEOUT_MS),
  });
  if (!res.ok) {
    let code: string | undefined;
    let description: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      code = body.error;
      description = body.error_description;
    } catch {
      // Non-JSON error body (proxy error page) - the status alone suffices.
    }
    throw new TokenGrantError(res.status, code, description);
  }
  return (await res.json()) as TokenSet;
}

function storeTokens(t: TokenSet): void {
  sessionStorage.setItem(TOKEN_STORE_KEY, JSON.stringify(t));
}

function clearStoredTokens(): void {
  sessionStorage.removeItem(TOKEN_STORE_KEY);
}

/**
 * Re-validate stored tokens against Keycloak (refresh grant). Returns a fresh,
 * guaranteed-valid token set, or null (clearing the store) when there is no
 * stored session or it has expired.
 */
async function refreshStoredTokens(): Promise<TokenSet | null> {
  const raw = sessionStorage.getItem(TOKEN_STORE_KEY);
  if (!raw) return null;
  let stored: TokenSet;
  try {
    stored = JSON.parse(raw) as TokenSet;
    if (typeof stored?.refresh_token !== 'string' || stored.refresh_token === '') {
      throw new Error('stored token set has no refresh_token');
    }
  } catch (e) {
    // Corrupt store must never break the boot - treat it as "no session".
    // eslint-disable-next-line no-console
    console.warn('Gespeicherte Sitzung ist unlesbar und wird verworfen.', e);
    clearStoredTokens();
    return null;
  }
  // Retry the grant ONCE before giving up: a single transient network blip on
  // the immediate post-registration reload must not silently bounce a
  // just-signed-in customer to a blank login card (M5).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = await tokenGrant({
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token,
      });
      storeTokens(fresh);
      return fresh;
    } catch (e) {
      if (e instanceof TokenGrantError && e.throttled) {
        // Throttled/locked out: KEEP the stored tokens (they may still be
        // valid once the window passes - wiping them would force a fresh
        // credential entry) and surface the German rate-limit card instead of
        // hammering the endpoint with a retry.
        authRateLimited = true;
        return null;
      }
      if (e instanceof TokenGrantError && e.status >= 400 && e.status < 500) {
        // A definitive refusal (expired/revoked refresh token) - retrying the
        // identical grant cannot succeed and only adds token-endpoint load.
        storedSessionExpired = true;
        clearStoredTokens();
        return null;
      }
      if (attempt === 1) {
        // A stored session existed but could not be refreshed - the session is
        // truly gone. Flag it so the login screen says "Sitzung abgelaufen".
        storedSessionExpired = true;
        clearStoredTokens();
        return null;
      }
    }
  }
  return null;
}

/**
 * Sign in with credentials the user just typed (post-registration): mint
 * tokens via the Direct Access Grant, persist them, and reload the SPA -
 * initAuth() picks them up and the customer lands in the portal without ever
 * seeing the Keycloak login page. Throws when the grant is refused so the
 * caller can fall back to the redirect login.
 */
export async function loginWithCredentials(username: string, password: string): Promise<void> {
  storeTokens(await tokenGrant({ grant_type: 'password', username, password }));
  window.location.reload();
}

/**
 * Initialise Keycloak. A stored direct-grant session (fresh registration) is
 * re-validated and injected; otherwise a silent SSO check picks up an existing
 * Keycloak session without a full redirect. Returns whether authenticated.
 */
export async function initAuth(): Promise<boolean> {
  const injected = await refreshStoredTokens();
  if (injected) {
    // No SSO cookie exists on this path, so skip the SSO iframe check - the
    // just-refreshed tokens are the session.
    const ok = await keycloak.init({
      token: injected.access_token,
      refreshToken: injected.refresh_token,
      idToken: injected.id_token,
      checkLoginIframe: false,
      pkceMethod: 'S256',
    });
    if (ok) {
      // keycloak-js rotates the tokens on refresh; keep the store current so
      // a mid-onboarding page reload stays signed in.
      keycloak.onAuthRefreshSuccess = () => {
        if (keycloak.token && keycloak.refreshToken) {
          storeTokens({
            access_token: keycloak.token,
            refresh_token: keycloak.refreshToken,
            id_token: keycloak.idToken,
          });
        }
      };
      return true;
    }
    clearStoredTokens();
    return false;
  }
  return keycloak.init({
    onLoad: 'check-sso',
    silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
    pkceMethod: 'S256',
    // The login-status iframe (default ON) is a proven white-page hang: its
    // load event fires even for a proxy/Keycloak ERROR page, but keycloak-js
    // then waits UNBOUNDED for a postMessage the error page never sends - and
    // on the ?code callback path the iframe even gates the code exchange.
    // Cross-tab logout detection degrades gracefully without it: the next
    // token refresh fails and freshToken() redirects to a fresh login.
    checkLoginIframe: false,
    // Auth-code response in the query string, NOT the fragment: the portal uses
    // the URL hash for navigation (#/geraete etc.), so the default fragment
    // response mode would clobber the current page on every login redirect.
    responseMode: 'query',
  });
}

/** Redirect to the Keycloak login; a hint pre-fills the username/email field. */
export function login(loginHint?: string): void {
  clearStoredTokens();
  void keycloak.login(loginHint ? { loginHint } : undefined);
}

export function logout(): void {
  clearStoredTokens();
  void keycloak.logout({ redirectUri: window.location.origin });
}

export function currentUser(): UserInfo {
  const t = keycloak.tokenParsed as Record<string, unknown> | undefined;
  return {
    name: (t?.['name'] as string) || (t?.['preferred_username'] as string) || 'Operator',
    email: t?.['email'] as string | undefined,
    tenantId: t?.['tenant_id'] as string | undefined,
    roles: currentRoles(),
  };
}

/** A valid access token, refreshed if it expires within 30s. */
export async function freshToken(): Promise<string | undefined> {
  try {
    await keycloak.updateToken(30);
  } catch {
    // Refresh failed (session gone) - redirect to a fresh login and ABORT the
    // pending request via AuthRedirectError, so it never fires an
    // unauthenticated call that would 401 and flash a raw status at the user.
    login();
    throw new AuthRedirectError();
  }
  return keycloak.token;
}
