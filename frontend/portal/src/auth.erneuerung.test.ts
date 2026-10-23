/**
 * B2 (Anlage-Flow a1): ein Netzaussetzer bei der Token-Erneuerung ist keine
 * beendete Sitzung. Vorher rief `freshToken()` bei JEDEM Fehler von
 * `updateToken` sofort `login()` - ein Funkloch warf aus dem Formular, die
 * Eingaben waren weg (Beleg `belege/sitzung-390`). Jetzt führt nur eine echte
 * Ablehnung durch Keycloak (400 `invalid_grant`, 401) zur Anmeldung.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kc = vi.hoisted(() => ({
  updateToken: vi.fn(),
  login: vi.fn(() => Promise.resolve()),
  isTokenExpired: vi.fn(() => true),
  token: 'alt' as string | undefined,
  refreshToken: 'erneuerung' as string | undefined,
}));

vi.mock('keycloak-js', () => ({
  default: class KeycloakMock {
    get token() {
      return kc.token;
    }
    get refreshToken() {
      return kc.refreshToken;
    }
    updateToken = kc.updateToken;
    login = kc.login;
    isTokenExpired = kc.isTokenExpired;
  },
}));

type Auth = typeof import('./auth');
let auth: Auth;

/** So lehnt keycloak-js ab, wenn Keycloak antwortet (`NetworkError` mit `response`). */
function abgelehnt(status: number) {
  return Object.assign(new Error('Server responded with an invalid status.'), {
    response: new Response('{"error":"invalid_grant"}', { status }),
  });
}

describe('freshToken (B2)', () => {
  beforeEach(async () => {
    // Das Setup lädt `auth` schon mit dem echten keycloak-js - frisch laden, damit der Mock greift.
    vi.resetModules();
    auth = await import('./auth');
    kc.updateToken.mockReset();
    kc.login.mockClear();
    kc.isTokenExpired.mockReset().mockReturnValue(true);
    kc.token = 'alt';
    kc.refreshToken = 'erneuerung';
  });

  it('Netzfehler bei der Erneuerung: keine Umleitung, die Anfrage scheitert wie ein verlorenes fetch', async () => {
    kc.updateToken.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(auth.freshToken()).rejects.toBeInstanceOf(auth.VerbindungUnterbrochen);
    expect(kc.login).not.toHaveBeenCalled();
  });

  it('Netzfehler, aber das Token gilt noch: die Anfrage läuft mit dem alten Token weiter', async () => {
    kc.updateToken.mockRejectedValue(new TypeError('Failed to fetch'));
    kc.isTokenExpired.mockReturnValue(false);
    await expect(auth.freshToken()).resolves.toBe('alt');
    expect(kc.login).not.toHaveBeenCalled();
  });

  it('Keycloak überlastet (503) oder drosselt (429): ebenfalls keine Umleitung', async () => {
    for (const status of [503, 429]) {
      kc.updateToken.mockRejectedValueOnce(abgelehnt(status));
      await expect(auth.freshToken()).rejects.toBeInstanceOf(auth.VerbindungUnterbrochen);
    }
    expect(kc.login).not.toHaveBeenCalled();
  });

  it('invalid_grant (Sitzung beendet): zur Anmeldung, die Anfrage bricht ab', async () => {
    kc.updateToken.mockImplementation(async () => {
      // keycloak-js räumt die Tokens bei einer 400 selbst ab.
      kc.refreshToken = undefined;
      kc.token = undefined;
      throw abgelehnt(400);
    });
    await expect(auth.freshToken()).rejects.toBeInstanceOf(auth.AuthRedirectError);
    expect(kc.login).toHaveBeenCalledTimes(1);
  });

  it('401 vom Token-Endpunkt: ebenfalls zur Anmeldung', async () => {
    kc.updateToken.mockRejectedValue(abgelehnt(401));
    await expect(auth.freshToken()).rejects.toBeInstanceOf(auth.AuthRedirectError);
    expect(kc.login).toHaveBeenCalledTimes(1);
  });

  it('Erneuerung gelingt: das neue Token', async () => {
    kc.updateToken.mockImplementation(async () => {
      kc.token = 'neu';
      return true;
    });
    await expect(auth.freshToken()).resolves.toBe('neu');
    expect(kc.login).not.toHaveBeenCalled();
  });
});
