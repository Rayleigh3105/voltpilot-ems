import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Card } from '../designsystem/components/core/Card';
import { Icon } from '../designsystem/components/core/Icon';
import logoUrl from '../designsystem/assets/voltpilot-logo.png';
import { Input } from '../designsystem/components/forms/Input';
import { isPlatformAdmin, login, loginWithCredentials } from './auth';
import { api, ApiError, register, setTenantOverride, type Device, type Site } from './api';
import { adminApi, type Tenant } from './admin/adminApi';
import { AppShell } from './shell/AppShell';
import { hashForPage, pageFromHash, PLATFORM_PAGES, type PageId } from './nav';
import { OnboardingWizard } from './Onboarding';
import { UebersichtPage } from './pages/UebersichtPage';
import { StandortePage } from './pages/StandortePage';
import { GeraetePage } from './pages/GeraetePage';
import { FahrplanPage, MarktpreisePage, WetterPage } from './pages/DataPages';
import { HistoriePage } from './pages/HistoriePage';
import { PrognosePage } from './pages/PrognosePage';
import { MandantenPage } from './pages/admin/MandantenPage';
import { BenutzerPage } from './pages/admin/BenutzerPage';
import { GeraeteRegistryPage } from './pages/admin/GeraeteRegistryPage';

export default function App({
  initialAuth,
  authError = false,
  sessionExpired = false,
}: {
  initialAuth: boolean;
  authError?: boolean;
  sessionExpired?: boolean;
}) {
  if (!initialAuth) return <LoginScreen authError={authError} sessionExpired={sessionExpired} />;
  // ONE app for both roles (unified shell): a Portal-Admin gets the same
  // customer pages via the tenant switcher plus the additive "Plattform" nav
  // group. The backend enforces the role split (403 / header-gated tenant
  // override) - the UI only adapts the surface.
  return <UnifiedPortal />;
}

function LoginScreen({
  authError,
  sessionExpired = false,
}: {
  authError: boolean;
  sessionExpired?: boolean;
}) {
  const [view, setView] = useState<'login' | 'register'>('login');
  return (
    <div className="vp-login">
      <Card padding="lg" radius="lg" className="vp-login-card">
        <img src={logoUrl} alt="VoltPilot" />
        {view === 'login' ? (
          <>
            <h1>VoltPilot EMS</h1>
            <p>
              Ihr Energiemanagement-Portal - Standorte, Geräte, Börsenpreise und
              Batterie-Fahrplan auf einen Blick.
            </p>
            {authError ? (
              // Keycloak is unreachable: sending the user to keycloak.login()
              // would just redirect to the same dead host, OUTSIDE the SPA, with
              // no way back. Offer a plain in-app retry instead (M4).
              <Button
                variant="primary"
                size="lg"
                fullWidth
                iconLeft={<Icon name="refresh-cw" size={18} />}
                onClick={() => window.location.reload()}
              >
                Erneut versuchen
              </Button>
            ) : (
              <Button variant="primary" size="lg" fullWidth onClick={() => login()}>
                Anmelden
              </Button>
            )}
            {/* Registration also needs a reachable Keycloak, so hide it while
                the auth service is down - it would be a second dead path (M4). */}
            {!authError && (
              <p className="vp-note" style={{ marginTop: 16 }}>
                Neu bei VoltPilot?{' '}
                <button type="button" className="vp-linklike" onClick={() => setView('register')}>
                  Konto erstellen
                </button>
              </p>
            )}
            {/* No self-service reset without SMTP - point at support (m8). */}
            <p className="vp-note" style={{ marginTop: authError ? 16 : 8 }}>
              Passwort vergessen? Bitte kontaktieren Sie unseren Support.
            </p>
          </>
        ) : (
          <RegisterForm onBack={() => setView('login')} />
        )}
        {sessionExpired && !authError && view === 'login' && (
          <div className="vp-alert vp-alert-err">
            Ihre Sitzung ist abgelaufen, bitte erneut anmelden.
          </div>
        )}
        {authError && (
          <div className="vp-alert vp-alert-err">
            Der Anmeldedienst ist zurzeit nicht erreichbar. Bitte versuchen Sie es in
            wenigen Minuten erneut.
          </div>
        )}
      </Card>
    </div>
  );
}

function RegisterForm({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState({ name: false, email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const nameOk = name.trim().length > 0;
  const emailOk = /\S+@\S+\.\S+/.test(email.trim());
  const passwordOk = password.length >= 8;
  const valid = nameOk && emailOk && passwordOk;

  function touch(field: keyof typeof touched) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  async function submit() {
    if (busy) return;
    if (!valid) {
      // Point at what's missing instead of silently refusing.
      setTouched({ name: true, email: true, password: true });
      (!nameOk ? nameRef : !emailOk ? emailRef : passwordRef).current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await register({ name: name.trim(), email: email.trim(), password });
      // Sign the fresh customer straight in with the credentials they just
      // typed (reloads the SPA into the onboarding wizard). If the direct
      // grant is unavailable (e.g. older realm config), fall back to the
      // pre-filled Keycloak login.
      try {
        await loginWithCredentials(email.trim().toLowerCase(), password);
        return; // reloading
      } catch {
        setDone(true);
      }
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 409
          ? 'Mit dieser E-Mail-Adresse gibt es bereits ein Konto. Melden Sie sich stattdessen an.'
          : e instanceof ApiError && e.status === 400
            ? 'Bitte prüfen Sie Ihre Eingaben: gültige E-Mail-Adresse und ein Passwort mit mindestens 8 Zeichen.'
            : e instanceof ApiError && e.status === 429
              ? 'Zu viele Registrierungsversuche von Ihrem Anschluss. Bitte versuchen Sie es in etwa einer Stunde erneut.'
              : e instanceof ApiError && (e.status === 502 || e.status === 503)
                ? // Keycloak/anmeldedienst is down: this is an outage, not a
                  // transient hiccup - don't invite an immediate retry (m7).
                  'Der Anmeldedienst ist zurzeit nicht erreichbar. Bitte versuchen Sie es in wenigen Minuten erneut.'
                : 'Die Registrierung hat gerade nicht geklappt. Bitte versuchen Sie es gleich noch einmal.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <h1>Ihr Konto ist bereit</h1>
        <p>
          Willkommen bei VoltPilot! Melden Sie sich jetzt mit Ihrer E-Mail-Adresse an -
          danach legen Sie Ihren Standort an und verbinden Ihr Gerät.
        </p>
        <Button variant="primary" size="lg" fullWidth onClick={() => login(email.trim())}>
          Jetzt anmelden
        </Button>
      </>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <h1>Konto erstellen</h1>
      <p>In einer Minute startklar: Konto anlegen, Standort benennen, Gerät verbinden.</p>
      <div style={{ display: 'grid', gap: 12, textAlign: 'left' }}>
        <Input
          ref={nameRef}
          label="Ihr Name oder Firmenname"
          placeholder="z. B. Erika Kaiser"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(e) => setName((e.target as HTMLInputElement).value)}
          onBlur={() => touch('name')}
          error={
            touched.name && !nameOk
              ? 'Bitte geben Sie Ihren Namen oder Firmennamen ein.'
              : null
          }
        />
        <Input
          ref={emailRef}
          label="E-Mail-Adresse"
          type="email"
          placeholder="erika@example.com"
          autoComplete="email"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
          onBlur={() => touch('email')}
          error={
            touched.email && !emailOk
              ? 'Das sieht noch nicht wie eine E-Mail-Adresse aus.'
              : null
          }
        />
        <div className="vp-pw-field">
          <div className="vp-pw-labelrow">
            <label htmlFor="reg-password" className="vp-field-label">
              Passwort
            </label>
            <button
              type="button"
              className="vp-linklike vp-pw-toggle"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
            >
              {showPassword ? 'Verbergen' : 'Anzeigen'}
            </button>
          </div>
          <Input
            ref={passwordRef}
            id="reg-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
            onBlur={() => touch('password')}
            error={
              touched.password && !passwordOk
                ? password.length === 0
                  ? 'Bitte wählen Sie ein Passwort mit mindestens 8 Zeichen.'
                  : `Noch ${8 - password.length} Zeichen – mindestens 8 sind nötig.`
                : null
            }
            hint={
              passwordOk ? (
                <span style={{ color: 'var(--vp-green)' }}>
                  <Icon
                    name="check"
                    size={12}
                    strokeWidth={3}
                    style={{ verticalAlign: '-1px', marginRight: 4 }}
                  />
                  Passwort ist lang genug.
                </span>
              ) : (
                'Mindestens 8 Zeichen.'
              )
            }
          />
        </div>
      </div>
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        disabled={busy}
        style={{ marginTop: 16 }}
      >
        {busy ? 'Erstelle Konto…' : 'Konto erstellen'}
      </Button>
      {err && <div className="vp-alert vp-alert-err">{err}</div>}
      <p className="vp-note" style={{ marginTop: 16 }}>
        Schon ein Konto?{' '}
        <button type="button" className="vp-linklike" onClick={onBack}>
          Zur Anmeldung
        </button>
      </p>
    </form>
  );
}

function UnifiedPortal() {
  const isAdmin = useMemo(() => isPlatformAdmin(), []);
  const [page, setPage] = useState<PageId>(() => {
    const p = pageFromHash();
    return !isAdmin && PLATFORM_PAGES.some((d) => d.id === p) ? 'uebersicht' : p;
  });

  // Admin tenant context (the switcher). Customers never have an override -
  // their tenant comes from the JWT and the backend ignores the header anyway.
  // The selection survives a reload (sessionStorage) so an admin does not
  // land back on "Mandanten-Kontext wählen" after every refresh.
  const [tenantId, setTenantId] = useState<string | null>(() =>
    isAdmin ? sessionStorage.getItem('vp-tenant-override') : null,
  );
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const [sites, setSites] = useState<Site[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  const navigate = useCallback(
    (p: PageId) => {
      if (!isAdmin && PLATFORM_PAGES.some((d) => d.id === p)) p = 'uebersicht';
      window.location.hash = hashForPage(p);
      setPage(p);
    },
    [isAdmin],
  );

  // Hash routing: back/forward + direct edits.
  useEffect(() => {
    const onHash = () => {
      const p = pageFromHash();
      setPage(!isAdmin && PLATFORM_PAGES.some((d) => d.id === p) ? 'uebersicht' : p);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [isAdmin]);

  const reloadTenants = useCallback(
    (selectId?: string) => {
      if (!isAdmin) return;
      adminApi
        .listTenants()
        .then((t) => {
          setTenants(t);
          if (selectId) setTenantId(selectId);
        })
        .catch((e) =>
          setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler'),
        );
    },
    [isAdmin],
  );

  useEffect(() => {
    reloadTenants();
  }, [reloadTenants]);

  // A restored override may point at a meanwhile-deleted tenant - drop it.
  useEffect(() => {
    if (tenantId && tenants.length > 0 && !tenants.some((t) => t.id === tenantId)) {
      setTenantId(null);
      sessionStorage.removeItem('vp-tenant-override');
    }
  }, [tenants, tenantId]);

  // Tenant-scoped data. For an admin without a selected tenant this yields
  // empty lists (backend default-deny) - the pages show a pick-a-tenant hint.
  const tenantReady = !isAdmin || tenantId != null;
  const reload = useCallback(
    async (selectSiteId?: string, opts?: { background?: boolean }) => {
      if (!tenantReady) {
        setSites([]);
        setDevices([]);
        setSelectedSite(null);
        return;
      }
      try {
        const [s, d] = await Promise.all([api.listSites(), api.listDevices()]);
        setSites(s);
        setDevices(d);
        setSelectedSite((cur) =>
          selectSiteId ?? (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null),
        );
        setError(null);
      } catch (e) {
        // A background poll (Geräte-Seite alle 30 s) must not raise the app-wide
        // red banner on a momentary blip - it keeps the last good data and
        // fails silently; only a user-triggered/initial load surfaces the error.
        if (!opts?.background) {
          setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
        }
      } finally {
        setLoaded(true);
      }
    },
    [tenantReady],
  );

  // Keep the module-level API header in sync in an EFFECT (not during render):
  // mutating shared module state in the render body is impure and, under React
  // concurrent features, an interrupted/discarded render would still stamp the
  // header - a cross-tenant leak hazard. Declared BEFORE the tenant-scoped fetch
  // effect so it runs first (effects fire in declaration order), guaranteeing
  // the header is set before any listSites/listDevices call.
  useEffect(() => {
    setTenantOverride(isAdmin ? tenantId : null);
  }, [isAdmin, tenantId]);

  useEffect(() => {
    void reload();
  }, [reload, tenantId]);

  const changeTenant = (id: string | null) => {
    setTenantId(id);
    setSelectedSite(null);
    if (id) sessionStorage.setItem('vp-tenant-override', id);
    else sessionStorage.removeItem('vp-tenant-override');
  };

  const jumpToTenant = (id: string, target: PageId) => {
    changeTenant(id);
    navigate(target);
  };

  const customerProps = {
    sites,
    devices,
    selectedSite,
    onSelectSite: setSelectedSite,
    onReload: (selectSiteId?: string) => void reload(selectSiteId),
  };

  const needsTenantPick = isAdmin && tenantId == null && !isPlatformPage(page);

  // An INITIAL sites/devices load failure must not masquerade as an empty
  // account ("Willkommen … ersten Standort anlegen"): with no data AND an
  // error we render a distinct error+retry state instead (M2). A transient
  // error while data is already present only raises the top banner.
  const loadFailed =
    error != null && loaded && tenantReady && sites.length === 0 && devices.length === 0;

  // First-run journey: until the customer has a device sending data, the whole
  // portal IS the onboarding. No empty dashboard with disconnected forms.
  // Customers only - an admin browsing an empty tenant keeps the normal pages.
  const showOnboarding =
    !isAdmin && loaded && !error && devices.length === 0 && !onboardingDismissed;

  function finishOnboarding() {
    setOnboardingDismissed(true);
    void reload();
  }

  return (
    <AppShell
      page={page}
      onNavigate={navigate}
      isAdmin={isAdmin}
      counts={{
        sites: tenantReady ? sites.length : null,
        devices: tenantReady ? devices.length : null,
      }}
      tenants={tenants}
      tenantOverride={tenantId}
      onTenantChange={changeTenant}
    >
      {error && !loadFailed && (
        <div
          className="vp-alert vp-alert-err"
          style={{ marginBottom: 'var(--vp-space-4)', display: 'flex', alignItems: 'center', gap: 'var(--vp-space-3)', flexWrap: 'wrap' }}
        >
          <span style={{ flex: '1 1 320px' }}>{error}</span>
          <Button variant="outline" size="sm" iconLeft={<Icon name="refresh-cw" size={16} />} onClick={() => void reload()}>
            Erneut laden
          </Button>
        </div>
      )}

      {needsTenantPick ? (
        <PickTenantNotice tenants={tenants} onPick={changeTenant} />
      ) : loadFailed ? (
        <LoadErrorNotice onRetry={() => void reload()} />
      ) : showOnboarding ? (
        <OnboardingWizard sites={sites} onDone={finishOnboarding} onSkip={finishOnboarding} />
      ) : (
        <>
          {page === 'uebersicht' && !isAdmin && loaded && !error && devices.length === 0 && (
            // The customer skipped the guided setup ("Später einrichten"):
            // keep one clear way back in, instead of a dead-end dashboard.
            <Card padding="lg" radius="lg" accent="primary" className="vp-resume-banner">
              <div style={{ flex: '1 1 360px', minWidth: 0 }}>
                <h4 style={{ marginBottom: 4 }}>Ihre Anlage ist noch nicht verbunden</h4>
                <p className="vp-muted" style={{ margin: 0 }}>
                  In wenigen Minuten startklar: Standort anlegen, Gerät verbinden -
                  wir führen Sie Schritt für Schritt durch.
                </p>
              </div>
              <Button variant="primary" onClick={() => setOnboardingDismissed(false)}>
                Einrichtung fortsetzen
              </Button>
            </Card>
          )}
          {page === 'uebersicht' && (
            <UebersichtPage {...customerProps} onNavigate={navigate} isAdmin={isAdmin} />
          )}
          {page === 'standorte' && <StandortePage {...customerProps} isAdmin={isAdmin} />}
          {page === 'geraete' && (
            <GeraetePage
              sites={sites}
              devices={devices}
              onReload={() => void reload()}
              onPoll={() => void reload(undefined, { background: true })}
            />
          )}
          {page === 'marktpreise' && (
            <MarktpreisePage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'wetter' && (
            <WetterPage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'fahrplan' && (
            <FahrplanPage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'historie' && (
            <HistoriePage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'prognose' && (
            <PrognosePage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
          )}
          {page === 'mandanten' && isAdmin && (
            <MandantenPage
              tenants={tenants}
              onReloadTenants={reloadTenants}
              onJumpToTenant={jumpToTenant}
            />
          )}
          {page === 'benutzer' && isAdmin && (
            <BenutzerPage tenants={tenants} tenantOverride={tenantId} />
          )}
          {page === 'geraete-registry' && isAdmin && <GeraeteRegistryPage />}
        </>
      )}
    </AppShell>
  );
}

function isPlatformPage(page: PageId): boolean {
  return PLATFORM_PAGES.some((d) => d.id === page);
}

/**
 * Initial data load failed (backend outage/unreachable): a distinct error +
 * retry, NEVER the "Willkommen … ersten Standort anlegen" onboarding copy on
 * top of an outage (M2).
 */
function LoadErrorNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <Card padding="lg" radius="lg">
      <div className="vp-empty">
        <h3>Daten konnten nicht geladen werden</h3>
        <p>
          Ihre Standorte und Geräte ließen sich gerade nicht laden. Das liegt
          meist an einer kurzen Verbindungsstörung. Bitte versuchen Sie es erneut.
        </p>
        <Button variant="primary" iconLeft={<Icon name="refresh-cw" size={18} />} onClick={onRetry}>
          Erneut laden
        </Button>
      </div>
    </Card>
  );
}

/** Admin on a customer page without a tenant context: never a dead-end. */
function PickTenantNotice({
  tenants,
  onPick,
}: {
  tenants: Tenant[];
  onPick: (tenantId: string) => void;
}) {
  return (
    <Card padding="lg" radius="lg">
      <div className="vp-empty">
        <h3>Mandanten-Kontext wählen</h3>
        <p>
          Diese Seite zeigt Kundendaten. Wählen Sie oben im Kontext-Umschalter einen
          Mandanten (oder hier direkt), um dessen Portal-Ansicht zu sehen.
        </p>
        <div style={{ display: 'flex', gap: 'var(--vp-space-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
          {tenants.slice(0, 6).map((t) => (
            <Button key={t.id} variant="outline" size="sm" onClick={() => onPick(t.id)}>
              {t.name}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  );
}
