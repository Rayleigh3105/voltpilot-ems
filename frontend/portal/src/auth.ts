import Keycloak from 'keycloak-js';
import { isStandalone } from './installApp';

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
// Konto-Aktionen (Einstellungen Scheibe 1, Entscheid 6A): „Passwort ändern" und
// „Zwei-Schritt-Anmeldung" laufen als Keycloak-Schritt aus der Seite heraus
// (`login({action})` setzt `kc_action`), die Rückkehr landet wieder auf der
// Konto-Gruppe der Einstellungs-Seite. `onActionUpdate` muss VOR `keycloak.init()`
// hängen, um die Rückkehr noch zu sehen - darum hier am Modul-Rand, nicht erst
// in `initAuth()`.

export type KontoAktion = 'UPDATE_PASSWORD' | 'CONFIGURE_TOTP';
export type KontoAktionStatus = 'success' | 'cancelled' | 'error';
export interface KontoAktionErgebnis {
  status: KontoAktionStatus;
  action: KontoAktion | null;
}

let kontoAktionErgebnis: KontoAktionErgebnis | null = null;
const kontoAktionListeners = new Set<() => void>();
keycloak.onActionUpdate = (status, action) => {
  kontoAktionErgebnis = { status, action: action === 'UPDATE_PASSWORD' || action === 'CONFIGURE_TOTP' ? action : null };
  kontoAktionListeners.forEach((f) => f());
};

export function subscribeKontoAktion(cb: () => void): () => void {
  kontoAktionListeners.add(cb);
  return () => kontoAktionListeners.delete(cb);
}

export function kontoAktionSnapshot(): KontoAktionErgebnis | null {
  return kontoAktionErgebnis;
}

/** Nur fürs Blatt: der gesehene Status zählt nur einmal. */
export function kontoAktionZuruecksetzen(): void {
  kontoAktionErgebnis = null;
}

/** Löst den Keycloak-Schritt aus - Rückkehr auf dieselbe Gruppe der Einstellungs-Seite. */
export function kontoAktionAusfuehren(action: KontoAktion): void {
  void keycloak.login({
    action,
    redirectUri: `${window.location.origin}${window.location.pathname}#/einstellungen?abschnitt=konto`,
  });
}

// ---------------------------------------------------------------------------
// The TOKEN STORE - one mechanism, two feeders.
//
// (1) Seamless post-registration login (Direct Access Grant). A fresh customer
//     just typed their email + password into OUR registration form; sending
//     them to the Keycloak login page to type the same credentials again would
//     be a pointless second hurdle. So the register flow mints tokens directly
//     at the token endpoint (grant_type=password on the public client) and
//     boots the SPA with them injected into keycloak-js.
//
// (2) The NORMAL Keycloak login (Authorization Code + PKCE). Measured
//     2026-08-06: every page load spent ~1,1 s (56 % of the cockpit's total
//     load time on Fast 4G) in three CONSECUTIVE Keycloak round trips -
//     3p-cookies probe, auth?prompt=none, token - because nothing was stored
//     and initAuth always fell through to the full check-sso dance. The tokens
//     of a successful login are therefore remembered here too, so the next load
//     in this tab (or app) takes the SAME proven ONE-request refresh path as (1).
//
// WHERE the store lives depends on how the portal runs:
//  - In a browser TAB: sessionStorage, so it dies with the tab and is never
//    shared between tabs - a deliberate scope/lifetime trade-off (AGENTS.md).
//  - As the INSTALLED app (display-mode standalone, iOS `navigator.standalone`):
//    localStorage. Every app start is a fresh browsing context, so a
//    sessionStorage store died with each close and the boot fell back to
//    check-sso, which only works while a persistent Keycloak cookie survives
//    in the app (none after the registration grant or without "Angemeldet
//    bleiben"). The persisted refresh token lives exactly as long as its
//    Keycloak session: with "Angemeldet bleiben" 90 d idle / 180 d max,
//    without it and after the registration's password grant 12 h / 24 h
//    (realm template; measured 2026-10-31). NEVER for platform-admin: that
//    token set stays in sessionStorage, as in a tab.
// A refused/expired refresh ALWAYS degrades to the normal check-sso path, so
// the store can only ever make a boot faster, never break it.
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

/** Runs the portal as the installed app? Then the store outlives the window. */
function alsApp(): boolean {
  return typeof window !== 'undefined' && isStandalone(window);
}

/** Realm roles inside a raw access token (JWT payload); null when unreadable. */
function realmRollen(accessToken: string): string[] | null {
  try {
    const teil = (accessToken.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(teil.padEnd(Math.ceil(teil.length / 4) * 4, '=')), (c) =>
      c.charCodeAt(0),
    );
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      realm_access?: { roles?: unknown };
    };
    const rollen = payload.realm_access?.roles;
    return Array.isArray(rollen) ? rollen.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return null;
  }
}

/**
 * May this token set outlive the app window? Only in the installed app, and
 * never for platform-admin - an unreadable token counts as platform-admin.
 */
function bleibtUeberAppStart(t: TokenSet): boolean {
  if (!alsApp()) return false;
  const rollen = realmRollen(t.access_token);
  return rollen !== null && !rollen.includes(PLATFORM_ADMIN_ROLE);
}

function storeTokens(t: TokenSet): void {
  const raw = JSON.stringify(t);
  if (bleibtUeberAppStart(t)) {
    localStorage.setItem(TOKEN_STORE_KEY, raw);
    sessionStorage.removeItem(TOKEN_STORE_KEY);
    return;
  }
  sessionStorage.setItem(TOKEN_STORE_KEY, raw);
  // Only the app drops its persisted copy here. A tab leaves it alone: on
  // Android and the desktop the installed app shares this origin's storage.
  if (alsApp()) localStorage.removeItem(TOKEN_STORE_KEY);
}

function readStoredTokens(): string | null {
  const imFenster = sessionStorage.getItem(TOKEN_STORE_KEY);
  if (imFenster !== null || !alsApp()) return imFenster;
  return localStorage.getItem(TOKEN_STORE_KEY);
}

function clearStoredTokens(): void {
  sessionStorage.removeItem(TOKEN_STORE_KEY);
  if (alsApp()) localStorage.removeItem(TOKEN_STORE_KEY);
}

/**
 * Re-validate stored tokens against Keycloak (refresh grant). Returns a fresh,
 * guaranteed-valid token set, or null (clearing the store) when there is no
 * stored session or it has expired.
 */
async function refreshStoredTokens(): Promise<TokenSet | null> {
  const raw = readStoredTokens();
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
        // The installed app keeps its store when Keycloak is merely unreachable
        // (no signal at app start, 5xx): that is no refusal, and dropping it
        // would cost the months-long session. The next start tries again.
        if (alsApp()) return null;
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
 * Write the LIVE keycloak-js session into the token store. Called on every
 * authenticated boot and again after each background token refresh, because
 * keycloak-js rotates the refresh token - a store left at the token of an hour
 * ago would present a superseded (idle-timed-out) one on the next reload and
 * pointlessly fall back to check-sso.
 *
 * Silent when keycloak-js has no token pair: an incomplete store is worse than
 * none (the next boot would spend a refused grant before falling back anyway).
 */
function rememberSession(): void {
  if (keycloak.token && keycloak.refreshToken) {
    storeTokens({
      access_token: keycloak.token,
      refresh_token: keycloak.refreshToken,
      id_token: keycloak.idToken,
    });
  }
}

/**
 * The ONE thing both authenticated init paths do: remember the session for the
 * next load, keep it current across refreshes, and drop the diagnosis flags a
 * failed stored-session probe may have set on the way here - we ARE signed in,
 * so "Sitzung abgelaufen" / "zu viele Anmeldeversuche" would be untrue.
 */
function onAuthenticated(): void {
  keycloak.onAuthRefreshSuccess = rememberSession;
  rememberSession();
  storedSessionExpired = false;
  authRateLimited = false;
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
 * Initialise Keycloak.
 *
 * FAST path: a stored session (fresh registration OR the last successful login
 * in this tab or app) is re-validated with ONE refresh grant and injected - no
 * SSO iframe, no auth?prompt=none redirect.
 *
 * FALLBACK path: no store, or the stored session could not be refreshed for ANY
 * reason (expired, revoked, throttled, corrupt, Keycloak unreachable) - then the
 * proven silent SSO check runs exactly as before. Returns whether authenticated.
 */
export async function initAuth(): Promise<boolean> {
  const injected = await refreshStoredTokens();
  if (injected) {
    // The refresh above already proved the session, so skip the SSO iframe
    // check - the just-refreshed tokens ARE the session. (On the registration
    // path no SSO cookie exists at all; after a normal login one does, but this
    // path deliberately does not depend on it.)
    const ok = await keycloak.init({
      token: injected.access_token,
      refreshToken: injected.refresh_token,
      idToken: injected.id_token,
      checkLoginIframe: false,
      pkceMethod: 'S256',
    });
    if (ok) {
      onAuthenticated();
      return true;
    }
    clearStoredTokens();
    return false;
  }
  const authenticated = await keycloak.init({
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
  // Remember the session this login/SSO check just established, so the NEXT
  // load in this tab (or app) takes the fast path above instead of these three
  // round trips. Nothing else about this path changes.
  if (authenticated) onAuthenticated();
  return authenticated;
}

/** Redirect to the Keycloak login; a hint pre-fills the username/email field. */
export function login(loginHint?: string): void {
  clearStoredTokens();
  void keycloak.login(loginHint ? { loginHint } : undefined);
}

/**
 * Sign out: drop every stored token set, then end the Keycloak session. The
 * persisted app store goes from a tab too - on Android and the desktop the
 * installed app shares this origin's storage (and its Keycloak cookie), and
 * signing out must not leave a months-long token on the device.
 */
export function logout(): void {
  clearStoredTokens();
  localStorage.removeItem(TOKEN_STORE_KEY);
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

/**
 * Die Token-Erneuerung scheiterte an der Verbindung, nicht an der Sitzung
 * (Anlage-Flow a1, B2): WLAN-Wechsel, Rechner aus dem Ruhezustand, Funkloch.
 * Die Anfrage scheitert wie bei einem verlorenen `fetch` - die Fläche meldet
 * „nicht erreichbar“ und behält ihre Eingaben, die nächste Anfrage versucht es
 * neu. Keine Umleitung zur Anmeldung.
 */
export class VerbindungUnterbrochen extends Error {
  constructor() {
    super('Keine Verbindung zur Anmeldung.');
  }
}

/**
 * Hat die gescheiterte Erneuerung die Sitzung beendet? Nur wenn Keycloak
 * geantwortet und abgelehnt hat (400 `invalid_grant`, 401) - keycloak-js räumt
 * die Tokens dann selbst ab, darum zählt auch ein fehlendes Refresh-Token.
 * Ein Netzfehler (`TypeError`), ein 5xx oder ein 429 beendet keine Sitzung.
 */
export function sitzungBeendet(fehler: unknown): boolean {
  if (!keycloak.refreshToken) return true;
  const status = (fehler as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return status === 400 || status === 401;
}

/** A valid access token, refreshed if it expires within 30s. */
export async function freshToken(): Promise<string | undefined> {
  try {
    await keycloak.updateToken(30);
  } catch (fehler) {
    if (!sitzungBeendet(fehler)) {
      // B2: ein Netzaussetzer ist keine beendete Sitzung. Ein noch gültiges
      // Token trägt die Anfrage weiter; sonst scheitert nur diese Anfrage.
      if (keycloak.token && !keycloak.isTokenExpired(0)) return keycloak.token;
      throw new VerbindungUnterbrochen();
    }
    // Refresh refused (session gone) - redirect to a fresh login and ABORT the
    // pending request via AuthRedirectError, so it never fires an
    // unauthenticated call that would 401 and flash a raw status at the user.
    login();
    throw new AuthRedirectError();
  }
  return keycloak.token;
}
