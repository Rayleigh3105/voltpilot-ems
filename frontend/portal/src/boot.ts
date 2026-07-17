/**
 * Pure boot logic for the auth bootstrap in main.tsx.
 *
 * Why this exists (white-page-on-login bug, 2026-07-17): keycloak-js 26's
 * init() contains UNBOUNDED awaits - the login-status iframe and the silent
 * check-sso iframe both wait forever on a postMessage that a Keycloak/proxy
 * ERROR PAGE inside the hidden iframe never sends (an error page fires the
 * iframe's load event but does not run the postMessage script). Combined with
 * rendering nothing until init settles, that was a permanent white page.
 * The boot is therefore (a) rendered immediately (BootSplash) and (b) bounded
 * by withTimeout(); the branching below is pure so the loop-guard/rate-limit
 * interplay is unit-testable.
 */

/** Hard ceiling for the whole auth bootstrap (keycloak init + token refresh). */
export const BOOT_TIMEOUT_MS = 10_000;

/** Thrown by withTimeout() when the wrapped promise does not settle in time. */
export class BootTimeoutError extends Error {
  constructor(ms: number) {
    super(`auth boot did not settle within ${ms}ms`);
    this.name = 'BootTimeoutError';
  }
}

/**
 * Bound a promise: rejects with BootTimeoutError after `ms` if it has not
 * settled. The underlying promise keeps running (a late keycloak init result
 * is simply ignored) - deliberately no state is wiped on timeout, so a reload
 * or a manual login() retries cleanly.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new BootTimeoutError(ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(handle);
        resolve(v);
      },
      (e) => {
        clearTimeout(handle);
        reject(e);
      },
    );
  });
}

export type BootOutcome =
  /** Authenticated: clear the loop guard, render the portal. */
  | { kind: 'app' }
  /** #register route renders the in-portal registration form, never redirects. */
  | { kind: 'register' }
  /** No session, first attempt: set the loop guard, redirect to Keycloak. */
  | { kind: 'autoLogin' }
  /** Manual login card (loop guard was set, or throttled - never redirect then). */
  | { kind: 'login' };

/**
 * Decide what an unauthenticated/authenticated boot renders. Mirrors the
 * long-standing main.tsx branching, plus: a rate-limited/locked-out boot never
 * auto-redirects (the redirect could not succeed and would hide the German
 * "zu viele Versuche" explanation behind a Keycloak page).
 */
export function bootOutcome(input: {
  authenticated: boolean;
  registerRoute: boolean;
  guardWasSet: boolean;
  rateLimited: boolean;
}): BootOutcome {
  if (input.authenticated) return { kind: 'app' };
  if (input.registerRoute) return { kind: 'register' };
  if (input.rateLimited) return { kind: 'login' };
  if (!input.guardWasSet) return { kind: 'autoLogin' };
  return { kind: 'login' };
}
