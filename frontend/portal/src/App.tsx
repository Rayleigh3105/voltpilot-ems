import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Card } from '../designsystem/components/core/Card';
import { Icon } from '../designsystem/components/core/Icon';
import { Input } from '../designsystem/components/forms/Input';
import { AuthScreen, TrustRow } from './components/AuthScreen';
import { isPlatformAdmin, login, loginWithCredentials } from './auth';
import {
  api,
  ApiError,
  deviceLiveStatus,
  register,
  setTenantOverride,
  type Betriebsart,
  type Device,
  type Site,
} from './api';
import { adminApi, type Tenant } from './admin/adminApi';
import {
  redirectOverviewToAnlage,
  redirectToPortfolio,
  showOverviewNav,
  showPortfolioNav,
} from './betriebsart';
import { AppShell } from './shell/AppShell';
import {
  anlageRoute,
  hashForRoute,
  pageRoute,
  PLATFORM_PAGES,
  routeFromHash,
  type PageId,
  type Route,
} from './nav';
import { showAddAnlageButton } from './addAnlage';
import { activeAreaKey, activeKeyForPage, anlageSidebar, resolveAnlage } from './anlageNav';
import { healthBadge } from './health';
import { useAnlageSurface } from './useAnlageSurface';
import { AnlageAnlegenDrawer } from './components/AnlageAnlegenDrawer';
import { OnboardingWizard } from './Onboarding';
import { UebersichtPage } from './pages/UebersichtPage';
import { PortfolioPage } from './pages/PortfolioPage';
import { AnlagenPage } from './pages/AnlagenPage';
import { MarktpreisePage } from './pages/DataPages';
import { PrognosePage } from './pages/PrognosePage';
import { MandantenPage } from './pages/admin/MandantenPage';
import { BenutzerPage } from './pages/admin/BenutzerPage';
import { GeraeteRegistryPage } from './pages/admin/GeraeteRegistryPage';
import { OptimizerPage } from './pages/admin/OptimizerPage';
import { FlowsPage } from './pages/admin/FlowsPage';

export default function App({
  initialAuth,
  authError = false,
  authTimeout = false,
  rateLimited = false,
  sessionExpired = false,
  redirecting = false,
  initialView = 'login',
}: {
  initialAuth: boolean;
  authError?: boolean;
  /** True when the auth bootstrap hit the hard boot timeout (init hung). */
  authTimeout?: boolean;
  /** True when the token endpoint refused with 429/brute-force lockout. */
  rateLimited?: boolean;
  sessionExpired?: boolean;
  /** True while main.tsx is navigating to the Keycloak login (no pre-step). */
  redirecting?: boolean;
  /** 'register' when the visitor deep-linked the portal's #register route. */
  initialView?: 'login' | 'register';
}) {
  if (!initialAuth)
    return (
      <LoginScreen
        authError={authError}
        authTimeout={authTimeout}
        rateLimited={rateLimited}
        sessionExpired={sessionExpired}
        redirecting={redirecting}
        initialView={initialView}
      />
    );
  // ONE app for both roles (unified shell): a Portal-Admin gets the same
  // customer pages via the tenant switcher plus the additive "Plattform" nav
  // group. The backend enforces the role split (403 / header-gated tenant
  // override) - the UI only adapts the surface.
  return <UnifiedPortal />;
}

function LoginScreen({
  authError,
  authTimeout = false,
  rateLimited = false,
  sessionExpired = false,
  redirecting = false,
  initialView = 'login',
}: {
  authError: boolean;
  authTimeout?: boolean;
  rateLimited?: boolean;
  sessionExpired?: boolean;
  redirecting?: boolean;
  initialView?: 'login' | 'register';
}) {
  const [view, setViewState] = useState<'login' | 'register'>(initialView);
  // Keep the URL in sync so a reload on the register form stays on the form
  // (main.tsx only auto-redirects to Keycloak OFF the #register route).
  function setView(v: 'login' | 'register') {
    setViewState(v);
    window.location.hash = v === 'register' ? '#register' : '';
  }
  if (redirecting) {
    // The Keycloak redirect is already underway (no pre-step). The panel is
    // only a fallback if the navigation is interrupted.
    return (
      <AuthScreen>
        <h1>Willkommen zurück</h1>
        <p className="vp-auth-hint">Sie werden zur Anmeldung weitergeleitet …</p>
        <Button variant="primary" size="lg" fullWidth onClick={() => login()}>
          Zur Anmeldung
        </Button>
        <TrustRow />
      </AuthScreen>
    );
  }
  return (
    <AuthScreen>
      {view === 'login' ? (
        <>
          <h1>Willkommen zurück</h1>
          <p className="vp-auth-hint">Melden Sie sich an Ihrer Anlage an.</p>
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
            <p className="vp-auth-note">
              Neu bei VoltPilot?{' '}
              <button type="button" className="vp-linklike" onClick={() => setView('register')}>
                Konto erstellen
              </button>
            </p>
          )}
          {/* No self-service reset without SMTP - point at support (m8). */}
          <p className="vp-auth-note" style={{ marginTop: authError ? 16 : 8 }}>
            Passwort vergessen? Bitte kontaktieren Sie unseren Support.
          </p>
        </>
      ) : (
        // "Zur Anmeldung" goes straight to the Keycloak login (there is no
        // in-portal login pre-step anymore).
        <RegisterForm onBack={() => login()} />
      )}
      {rateLimited && !authError && view === 'login' && (
        <div className="vp-alert vp-alert-err">
          Zu viele Anmeldeversuche. Bitte versuchen Sie es in ein paar Minuten
          erneut.
        </div>
      )}
      {authTimeout && !rateLimited && !authError && view === 'login' && (
        <div className="vp-alert vp-alert-err">
          Die Anmeldung dauert ungewöhnlich lange. Bitte versuchen Sie es erneut.
        </div>
      )}
      {sessionExpired && !rateLimited && !authTimeout && !authError && view === 'login' && (
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
      {view === 'login' && <TrustRow />}
    </AuthScreen>
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
        <p className="vp-auth-hint">
          Willkommen bei VoltPilot! Melden Sie sich jetzt mit Ihrer E-Mail-Adresse an -
          danach legen Sie Ihre Anlage an und verbinden Ihr Gerät.
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
      <p className="vp-auth-hint">
        In einer Minute startklar: Konto anlegen, Anlage benennen, Gerät verbinden.
      </p>
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
      <p className="vp-auth-note">
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
  const [route, setRoute] = useState<Route>(() => {
    const r = routeFromHash();
    return !isAdmin && PLATFORM_PAGES.some((d) => d.id === r.page) ? pageRoute('uebersicht') : r;
  });
  const page = route.page;

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
  // U0 shell frame: the tenant's EFFECTIVE Betriebsart from /tenant-context
  // (resolved server-side; null until loaded or when the call fails - the
  // shell decision then falls back to the v1 site-count heuristic).
  const [betriebsart, setBetriebsart] = useState<Betriebsart | null>(null);
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  // The shell's "＋ Anlage hinzufügen" one-flow drawer (single-Anlage customers).
  const [addAnlageOpen, setAddAnlageOpen] = useState(false);

  const navigate = useCallback(
    (target: Route | PageId) => {
      let r: Route = typeof target === 'string' ? pageRoute(target) : target;
      if (!isAdmin && PLATFORM_PAGES.some((d) => d.id === r.page)) r = pageRoute('uebersicht');
      window.location.hash = hashForRoute(r);
      setRoute(r);
      // A page switch is a navigation, not a scroll continuation.
      window.scrollTo({ top: 0 });
    },
    [isAdmin],
  );

  // Hash routing: back/forward + direct edits.
  useEffect(() => {
    const onHash = () => {
      const r = routeFromHash();
      setRoute(!isAdmin && PLATFORM_PAGES.some((d) => d.id === r.page) ? pageRoute('uebersicht') : r);
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
        setBetriebsart(null);
        setSelectedSite(null);
        return;
      }
      try {
        // The tenant-context read is fail-soft: an older backend (or a
        // transient blip) leaves the frame on its last known value - never a
        // broken portal, and never a mid-session shell flip from one failed
        // background poll. A never-succeeding read keeps the initial null =
        // the v1 site-count fallback.
        const [s, d, ctx] = await Promise.all([
          api.listSites(),
          api.listDevices(),
          api.tenantContext().catch(() => null),
        ]);
        setSites(s);
        setDevices(d);
        if (ctx) setBetriebsart(ctx.betriebsart);
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

  // U0 shell frame: a customer WITHOUT a fleet level (endkunde below 2
  // Anlagen - the single-plant merge, captain decision 2, 2026-07-07) has NO
  // "Übersicht"; any landing there (default boot hash, old bookmark) forwards
  // to the Anlagen entry. A BETREIBER is never forwarded - the Übersicht IS
  // their fleet/portfolio landing, even with one Standort. replace() keeps
  // the history clean (Back leaves the app, never bounces here). Admins are
  // untouched - they browse tenants and keep the Übersicht.
  useEffect(() => {
    if (error != null) return;
    const shell = { isAdmin, loaded, tenantReady, betriebsart, siteCount: sites.length };
    // Betreiber (U5): the Portfolio page is the landing. A betreiber landing on
    // the default #/uebersicht boot hash / an old bookmark is sent to
    // #/portfolio; a non-betreiber that hits #/portfolio (frame changed, stale
    // bookmark) is sent back to #/uebersicht (which itself may forward an
    // endkunde without a fleet level to their Anlage below).
    if (redirectToPortfolio(shell)) {
      if (route.page === 'uebersicht') {
        window.location.replace(hashForRoute(pageRoute('portfolio')));
        setRoute(pageRoute('portfolio'));
      }
      return;
    }
    if (route.page === 'portfolio' && loaded && tenantReady) {
      window.location.replace(hashForRoute(pageRoute('uebersicht')));
      setRoute(pageRoute('uebersicht'));
      return;
    }
    if (route.page === 'uebersicht' && redirectOverviewToAnlage(shell)) {
      window.location.replace(hashForRoute(pageRoute('anlagen')));
      setRoute(pageRoute('anlagen'));
    }
  }, [isAdmin, loaded, tenantReady, betriebsart, error, sites.length, route.page]);

  // An Anlage opened by route is also the context of the site-scoped pages
  // (Marktpreise, Prognosequalität) - switching there stays on "their" site.
  useEffect(() => {
    if (route.page === 'anlagen' && route.siteId) setSelectedSite(route.siteId);
  }, [route]);

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

  // M1 (#529): the Anlage-scoped shell nav. Scoped to the SAME Anlage the
  // AnlagenPage renders (resolveAnlage is shared, so the two can never
  // disagree), and only while that page is open - the Portfolio, the fleet
  // list and the Plattform pages keep the plain shell. The Steuerung badge +
  // the mode-scoped knowledge group come from the M0 read-model; the fetch is
  // fail-soft, so an older backend just yields no badge and no group.
  // The mode-scoped pages (Marktpreise/Prognosequalität) keep the Anlage nav
  // too - they are that Anlage's market-mode deep views, so leaving the trio
  // behind when opening one would strand the customer.
  const shellSite =
    page === 'anlagen'
      ? resolveAnlage(sites, route.siteId)
      : page === 'marktpreise' || page === 'prognose'
        ? resolveAnlage(sites, selectedSite)
        : null;
  const { surface } = useAnlageSurface(shellSite);

  // Re-derive the health badge as time passes: `lastSeenAt` does not change,
  // but a device crossing the 5-minute window must turn the badge amber
  // without waiting for the next data load. A pure clock tick, no request.
  const [healthTick, setHealthTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setHealthTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Device liveness of the Anlage in scope, straight from the already-loaded
  // devices list (the same 5-minute window `deviceLiveStatus` uses everywhere).
  const deviceHealth = useMemo(() => {
    if (!shellSite) return null;
    const own = devices.filter((d) => d.siteId === shellSite.id);
    if (own.length === 0) return { deviceCount: 0, onlineCount: 0, waitingCount: 0 };
    const now = new Date();
    let onlineCount = 0;
    let waitingCount = 0;
    for (const d of own) {
      const status = deviceLiveStatus(d, now);
      if (status === 'online') onlineCount += 1;
      else if (status === 'waiting') waitingCount += 1;
    }
    return { deviceCount: own.length, onlineCount, waitingCount };
    // healthTick is a deliberate dependency: it is what re-evaluates freshness.
  }, [shellSite, devices, healthTick]);

  const anlageNav = shellSite
    ? {
        siteId: shellSite.id,
        siteName: shellSite.name,
        sites: sites.map((s) => ({ id: s.id, name: s.name })),
        onSelectSite: (id: string) => navigate(anlageRoute(id)),
        sidebar: anlageSidebar(surface, surface?.modes.length ?? null),
        // A mode page keeps the Anlage nav and highlights ITS entry inside the
        // market mode group (`activeKeyForPage`), so opening Marktpreise never
        // leaves the customer without a "you are here".
        activeKey:
          page === 'anlagen' ? activeAreaKey(route.sub) : activeKeyForPage(page),
        onOpenSub: (sub: Parameters<typeof anlageRoute>[1]) =>
          navigate(anlageRoute(shellSite.id, sub ?? null)),
        onOpenPage: (target: PageId) => navigate(target),
        // "Alle Anlagen" only exists where a fleet level exists.
        onOpenFleet: sites.length > 1 ? () => navigate(pageRoute('anlagen')) : null,
        // Composed from data already in hand (the devices list) - the badge
        // must never add a request to the main page. Facts nobody supplied
        // (plan, control, battery) contribute nothing, so the badge never
        // claims health it did not measure.
        health: loaded && tenantReady ? healthBadge({ devices: deviceHealth }) : null,
      }
    : null;

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

  // The always-visible shell action for the one case with no obvious entry
  // point: a customer with exactly one Anlage (no Übersicht, no Anlagen-Liste).
  const showAddAnlage = showAddAnlageButton({
    isAdmin,
    loaded,
    tenantReady,
    onboarding: showOnboarding,
    siteCount: sites.length,
  });

  function finishOnboarding() {
    setOnboardingDismissed(true);
    void reload();
  }

  return (
    <AppShell
      page={page}
      onNavigate={navigate}
      isAdmin={isAdmin}
      // U0: the "Übersicht" nav item follows the tenant's Betriebsart frame
      // (betreiber = always the fleet level; endkunde = only from the second
      // Anlage on, where it renders the calm card overview), not the raw site
      // count. Unknown frame falls back to the v1 heuristic.
      showOverview={showOverviewNav({
        isAdmin,
        loaded,
        tenantReady,
        betriebsart,
        siteCount: sites.length,
      })}
      // U5: a betreiber frame swaps "Übersicht" for the "Portfolio" landing.
      showPortfolio={showPortfolioNav({
        isAdmin,
        loaded,
        tenantReady,
        betriebsart,
        siteCount: sites.length,
      })}
      showAddAnlage={showAddAnlage}
      onAddAnlage={() => setAddAnlageOpen(true)}
      counts={{
        sites: tenantReady ? sites.length : null,
        devices: tenantReady ? devices.length : null,
      }}
      tenants={tenants}
      tenantOverride={tenantId}
      onTenantChange={changeTenant}
      anlage={anlageNav}
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
          {(page === 'uebersicht' || page === 'anlagen') &&
            !isAdmin &&
            loaded &&
            !error &&
            devices.length === 0 && (
              // The customer skipped the guided setup ("Später einrichten"):
              // keep one clear way back in, instead of a dead-end dashboard.
              <Card padding="lg" radius="lg" accent="primary" className="vp-resume-banner">
                <div style={{ flex: '1 1 360px', minWidth: 0 }}>
                  <h4 style={{ marginBottom: 4 }}>Ihre Anlage ist noch nicht verbunden</h4>
                  <p className="vp-muted" style={{ margin: 0 }}>
                    In wenigen Minuten startklar: Anlage anlegen, Gerät verbinden -
                    wir führen Sie Schritt für Schritt durch.
                  </p>
                </div>
                <Button variant="primary" onClick={() => setOnboardingDismissed(false)}>
                  Einrichtung fortsetzen
                </Button>
              </Card>
            )}
          {page === 'portfolio' && (
            <PortfolioPage
              sites={sites}
              onNavigate={navigate}
              onReload={(selectSiteId?: string) => void reload(selectSiteId)}
              isAdmin={isAdmin}
            />
          )}
          {page === 'uebersicht' && (
            <UebersichtPage
              {...customerProps}
              onNavigate={navigate}
              isAdmin={isAdmin}
              betriebsart={betriebsart}
            />
          )}
          {page === 'anlagen' && (
            <AnlagenPage
              sites={sites}
              devices={devices}
              route={route}
              onNavigate={navigate}
              onReload={(selectSiteId?: string) => void reload(selectSiteId)}
              isAdmin={isAdmin}
            />
          )}
          {page === 'marktpreise' && (
            <MarktpreisePage sites={sites} selectedSite={selectedSite} onSelectSite={setSelectedSite} />
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
          {page === 'optimizer' && isAdmin && <OptimizerPage tenants={tenants} />}
          {page === 'flows' && isAdmin && <FlowsPage tenants={tenants} />}
        </>
      )}

      {/* The shell's "＋ Anlage hinzufügen" action opens the SAME one-flow
          drawer as everywhere else; on finish we reload and land the customer
          on their new Anlage. Always mounted so `open` alone drives it. */}
      <AnlageAnlegenDrawer
        open={addAnlageOpen}
        onClose={() => setAddAnlageOpen(false)}
        existingSites={sites}
        onChanged={(createdSiteId) => {
          void reload(createdSiteId);
          navigate(anlageRoute(createdSiteId));
        }}
      />
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
          Ihre Anlagen und Geräte ließen sich gerade nicht laden. Das liegt
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
