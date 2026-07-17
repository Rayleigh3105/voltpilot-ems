import { describe, expect, it } from 'vitest';
import { BootTimeoutError, bootOutcome, withTimeout } from './boot';

describe('withTimeout', () => {
  it('passes a resolution through', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('passes a rejection through', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with BootTimeoutError when the promise never settles (the white-page hang)', async () => {
    const never = new Promise<boolean>(() => {});
    await expect(withTimeout(never, 20)).rejects.toBeInstanceOf(BootTimeoutError);
  });

  it('a late resolution after the timeout is ignored, not an unhandled rejection', async () => {
    let settle!: (v: string) => void;
    const late = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const bounded = withTimeout(late, 20);
    await expect(bounded).rejects.toBeInstanceOf(BootTimeoutError);
    settle('too late');
    // Nothing to assert beyond "does not throw" - the late value is dropped.
    await late;
  });
});

describe('bootOutcome', () => {
  const base = { authenticated: false, registerRoute: false, guardWasSet: false, rateLimited: false };

  it('authenticated boots render the app regardless of everything else', () => {
    expect(bootOutcome({ ...base, authenticated: true })).toEqual({ kind: 'app' });
    expect(
      bootOutcome({ ...base, authenticated: true, guardWasSet: true, rateLimited: true }),
    ).toEqual({ kind: 'app' });
  });

  it('the #register route renders the in-portal form without redirecting', () => {
    expect(bootOutcome({ ...base, registerRoute: true })).toEqual({ kind: 'register' });
  });

  it('first unauthenticated boot auto-redirects to Keycloak', () => {
    expect(bootOutcome(base)).toEqual({ kind: 'autoLogin' });
  });

  it('loop guard set -> manual login card instead of a redirect loop', () => {
    expect(bootOutcome({ ...base, guardWasSet: true })).toEqual({ kind: 'login' });
  });

  it('a rate-limited boot NEVER auto-redirects - the German card must stay visible', () => {
    expect(bootOutcome({ ...base, rateLimited: true })).toEqual({ kind: 'login' });
    expect(bootOutcome({ ...base, rateLimited: true, guardWasSet: true })).toEqual({
      kind: 'login',
    });
  });
});
