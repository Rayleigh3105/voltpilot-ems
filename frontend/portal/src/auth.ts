import Keycloak from 'keycloak-js';

/**
 * Keycloak OIDC client for the portal (public client, Authorization Code + PKCE).
 * Config comes from VITE_* env (see .env.example); defaults match the local
 * docker-compose stack.
 */
export const keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL ?? 'http://localhost:8081',
  realm: import.meta.env.VITE_KEYCLOAK_REALM ?? 'voltpilot',
  clientId: import.meta.env.VITE_KEYCLOAK_CLIENT_ID ?? 'voltpilot-frontend',
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

/**
 * Initialise Keycloak. Uses a silent SSO check so an existing session is picked
 * up without a full redirect; returns whether the user is authenticated.
 */
export async function initAuth(): Promise<boolean> {
  return keycloak.init({
    onLoad: 'check-sso',
    silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
    pkceMethod: 'S256',
    // Auth-code response in the query string, NOT the fragment: the portal uses
    // the URL hash for navigation (#/geraete etc.), so the default fragment
    // response mode would clobber the current page on every login redirect.
    responseMode: 'query',
  });
}

/** Redirect to the Keycloak login; a hint pre-fills the username/email field. */
export function login(loginHint?: string): void {
  void keycloak.login(loginHint ? { loginHint } : undefined);
}

export function logout(): void {
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
    // Refresh failed (session gone) - force a fresh login.
    login();
  }
  return keycloak.token;
}
