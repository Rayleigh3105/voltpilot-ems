import { BenutzerPage } from './pages/BenutzerPage';
import { darf, ohneStandort, RechteStandort, setSelbstauskunft, teilansichtKopf, useRollen } from './rollen';
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../designsystem/components/core/Button';
import { Card } from '../designsystem/components/core/Card';
import { Icon } from '../designsystem/components/core/Icon';
import { Input } from '../designsystem/components/forms/Input';
import { AuthScreen, TrustRow } from './components/AuthScreen';
import { currentRoles, isPlatformAdmin, login, loginWithCredentials } from './auth';
import {
  api,
  ApiError,
  register,
  setTenantOverride,
  setKundenbereich,
  type Betriebsart,
  type Device,
  type Site,
  type StandorteAmStichtag,
  type Unternehmen,
} from './api';
import { type Tenant } from './admin/adminApi';
import {
  canonicalShellHash,
  canonicalShellRoute,
  fleetLabel,
  flottenLandung,
  kopfPfad,
  orteAus,
  pfadWert,
  pfadZeile,
  redirectAdminToPlattform,
  showOverviewNav,
  showPortfolioNav,
  startEbene,
  type PfadGlied,
} from './betriebsart';
import { AppShell } from './shell/AppShell';
import {
  anlageRoute,
  canonicalAnlageHash,
  canonicalPlatformHash,
  isGeraeteBereich,
  hashForRoute,
  isBootHash,
  pageRoute,
  parseMessstelleWerte,
  PLATFORM_PAGES,
  routeFromHash,
  standortMessstellenRoute,
  standortBereichRoute,
  kennzahlRoute,
  berichtRoute,
  energieeinsatzRoute,
  energiezielRoute,
  massnahmeRoute,
  verbesserungRoute,
  messstelleRoute,
  standortRoute,
  transitionKind,
  type PageId,
  type Route,
} from './nav';
import { PAGE_CHUNK } from './pageChunks';
import { darfAnsehen as darfEnergieeinsaetzeSehen } from './bewertung';
import { darfAnsehen as darfVerbesserungSehen } from './energieziele';
import { transitionToRoute } from './pageTransition';
import { hatGeldWelt } from './portfolioHistorie';
import { geldAnlagen, type UebersichtEbene } from './uebersicht';
import { showAddAnlageButton } from './addAnlage';
import {
  activeAreaKey,
  anlageSidebar,
  ebenenAktiv,
  ebenenBereiche,
  ebenenLeiste,
  ebenenOrt,
  ebenenReiter,
  ebenenTitel,
  misstAnlage,
  resolveAnlage,
  standortEinstiege,
  standortBereichFuer,
  type EbenenLesemodell,
} from './ebenenNav';
import { healthBadge, sameHealthFacts, type AnlageHealthFacts } from './health';
import { deviceHealthForSite, LIVENESS_POLL_MS } from './liveness';
import { anlagenOptionen } from './anlagenWahl';
import {
  recordCurrentNavigation,
  recordNewNavigation,
  replaceCurrentNavigation,
  requestNavigation,
} from './navigationBlocker';
import { useFreshnessPoll } from './useFreshnessPoll';
import { sprungziel, type Sprung } from './uemsOberflaechen';
import { useDeployWatch } from './deployWatch';
import { aufmerksamkeitTitel } from './steuerungAufmerksamkeit';
import { useAnlageSurface } from './useAnlageSurface';
import { AnlageAnlegenDrawerLazy as AnlageAnlegenDrawer } from './components/AnlageAnlegenDrawerLazy';
import { LazyBoundary } from './components/Lazy';
import { MessenEinstiegKontext, type MessenZiel } from './messenEinstieg';
import { PortfolioTabs } from './components/PortfolioTabs';
import { EbenenTabs } from './components/EbenenTabs';
import { helpForRoute } from './help/context';
const HelpPage = lazy(PAGE_CHUNK.hilfe);
// Der Anlege-Assistent des ERSTEN Besuchs - nachgeladen statt mitgeliefert
// (Perf-Review `vp-cockpit-perf-p7` §2 U2). Er hängt über
// `Onboarding.tsx → AnlageFlow.tsx → LocationMap` an **Leaflet** (146 kB) und
// war damit der schwerste Rückfall der Lazy-Welle vom 06.08.: statisch
// importiert lag er in JEDEM Cockpit-Aufruf, obwohl ihn ein Kunde höchstens
// einmal sieht (`showOnboarding` = ein Konto OHNE Gerät). Gemessen:
// Einstiegs-Bündel 249 → 187 kB gzip.
//
// **Ein blosses `lazy` genügt hier - anders als beim `AnlageAnlegenDrawerLazy`**
// (dessen Aufrufer halten den Drawer DAUERHAFT montiert und steuern ihn über
// `open`, ein direktes `lazy` lüde also sofort). Der Wizard rendert
// ausschliesslich im Onboarding-Zweig, also lädt er auch nur dort.
//
// Der Suspense-Fallback ist bewusst `null`: das Boot-Skelett aus `index.html`
// steht zu diesem Zeitpunkt ohnehin, ein Skelett darunter wäre ein zweiter
// Ladezustand für dieselbe Sekunde.
const OnboardingWizard = lazy(() =>
  PAGE_CHUNK.onboarding().then((m) => ({ default: m.OnboardingWizard })),
);
// Die Anlagen-Seite ist das Ziel fast jedes Besuchs und bleibt deshalb im
// Einstiegs-Bündel. Jede ANDERE Seite wird lazy geladen: die Plattform-Seiten
// sieht ein Kunde nie, Portfolio nur ein Betreiber, Marktpreise/Prognose nur
// auf Klick - statisch importiert zogen sie ECharts, Leaflet und den
// Automations-Editor in den Startpfad (siehe `components/Lazy.tsx`).
import { AnlagenPage } from './pages/AnlagenPage';
const UebersichtPage = lazy(() =>
  PAGE_CHUNK.uebersicht().then((m) => ({ default: m.UebersichtPage })),
);
const PortfolioPage = lazy(() =>
  PAGE_CHUNK.portfolio().then((m) => ({ default: m.PortfolioPage })),
);
// UEMS AP-13 IP-2: die Seiten des Standorts reisen im Chunk seiner Übersicht.
const StandortGebaeudePage = lazy(() =>
  PAGE_CHUNK.standort().then((m) => ({ default: m.StandortGebaeudePage })),
);
const StandortBoxenPage = lazy(() =>
  PAGE_CHUNK.standort().then((m) => ({ default: m.StandortBoxenPage })),
);
const StandortNetzanschluessePage = lazy(() => import('./pages/StandortNetzanschluessePage').then(m => ({ default: m.StandortNetzanschluessePage })));
const StandortAnlagenPage = lazy(() =>
  PAGE_CHUNK.standort().then((m) => ({ default: m.StandortAnlagenPage })),
);
const StandortUebersichtPage = lazy(() =>
  PAGE_CHUNK.standort().then((m) => ({ default: m.StandortUebersichtPage })),
);

/** Die zwei Antworten des Standort-Lesemodells, wie sie ankamen (UEMS AP-01 IP-5). */
interface OrteQuelle {
  liste: StandorteAmStichtag;
  unternehmen: Unternehmen | null;
}

/**
 * Lädt die Ortsstruktur fail-soft: jeder Fehler — auch ein älteres Backend ohne
 * die Route — heisst `null`, und `null` heisst für die Startansicht „wie heute".
 */
async function orteLaden(): Promise<OrteQuelle | null> {
  try {
    const [liste, unternehmen] = await Promise.all([
      api.standorte(),
      api.unternehmen().catch(() => null),
    ]);
    return { liste, unternehmen };
  } catch {
    return null;
  }
}

const StandortePage = lazy(() =>
  PAGE_CHUNK['portfolio-standorte']().then((m) => ({ default: m.StandortePage })),
);
const MessstellenPage = lazy(() =>
  PAGE_CHUNK['portfolio-messstellen']().then((m) => ({ default: m.MessstellenPage })),
);
const BezugsgroessenPage = lazy(() =>
  PAGE_CHUNK['portfolio-bezugsgroessen']().then((m) => ({ default: m.BezugsgroessenPage })),
);
const KennzahlenPage = lazy(() =>
  PAGE_CHUNK['portfolio-kennzahlen']().then((m) => ({ default: m.KennzahlenPage })),
);
const BerichtePage = lazy(() =>
  PAGE_CHUNK['portfolio-berichte']().then((m) => ({ default: m.BerichtePage })),
);
const BewertungPage = lazy(() =>
  PAGE_CHUNK['portfolio-bewertung']().then((m) => ({ default: m.BewertungPage })),
);
const VerbesserungBereich = lazy(() =>
  PAGE_CHUNK['portfolio-verbesserung']().then((m) => ({ default: m.VerbesserungBereich })),
);
const PortfolioMesswerte = lazy(() =>
  PAGE_CHUNK['portfolio-messwerte']().then((m) => ({ default: m.PortfolioMesswerte })),
);
const PortfolioErloese = lazy(() =>
  PAGE_CHUNK['portfolio-erloese']().then((m) => ({ default: m.PortfolioErloese })),
);
const MandantenPage = lazy(() =>
  PAGE_CHUNK.mandanten().then((m) => ({ default: m.MandantenPage })),
);
const PlattformUebersichtPage = lazy(() =>
  PAGE_CHUNK['plattform-uebersicht']().then((m) => ({
    default: m.PlattformUebersichtPage,
  })),
);
// Stufe 3: EIN Nav-Punkt „Geräte" mit zwei Tabs - beide Routen rendern denselben
// Bereich, also gibt es auch nur einen Lade-Einstieg.
const GeraeteBereich = lazy(() =>
  PAGE_CHUNK['geraete-registry']().then((m) => ({ default: m.GeraeteBereich })),
);
const OptimizerPage = lazy(() =>
  PAGE_CHUNK.optimizer().then((m) => ({ default: m.OptimizerPage })),
);
const FlowsPage = lazy(() =>
  PAGE_CHUNK.flows().then((m) => ({ default: m.FlowsPage })),
);
const SteuerungsFreigabePage = lazy(() =>
  PAGE_CHUNK['steuerungs-freigabe']().then((m) => ({
    default: m.SteuerungsFreigabePage,
  })),
);
const VorlagenPage = lazy(() =>
  PAGE_CHUNK.vorlagen().then((m) => ({ default: m.VorlagenPage })),
);
// AP-01 E5 = A: der Assistent „Messen & Auswerten“ an genau EINER Stelle der App. Er wird nur gerendert, solange
// ein Einstieg ihn geöffnet hat - ein blosses `lazy` lädt also erst beim ersten Öffnen.
const MessenAssistent = lazy(() =>
  import('./components/MessenAssistent').then((m) => ({ default: m.MessenAssistent })),
);
const KomponentenFlottePage = lazy(() =>
  PAGE_CHUNK['komponenten-flotte']().then((m) => ({
    default: m.KomponentenFlottePage,
  })),
);

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
  // Ein Hinweis gehoert VOR die Handlung, nicht darunter - sonst steht der
  // Grund unter dem Knopf, den er erklaert. Es wird IMMER hoechstens einer
  // gezeigt (die Sperre ist die schaerfere Aussage als ein Timeout, und ein
  // nicht erreichbarer Dienst schlaegt alles - er erklaert auch die anderen).
  const banner = authError
    ? 'Der Anmeldedienst ist zurzeit nicht erreichbar. Bitte versuchen Sie es in wenigen Minuten erneut.'
    : view !== 'login'
      ? null
      : rateLimited
        ? 'Zu viele Anmeldeversuche. Bitte versuchen Sie es in ein paar Minuten erneut.'
        : authTimeout
          ? 'Die Anmeldung dauert ungewöhnlich lange. Bitte versuchen Sie es erneut.'
          : sessionExpired
            ? 'Ihre Sitzung ist abgelaufen, bitte erneut anmelden.'
            : null;
  return (
    <AuthScreen>
      {banner && (
        <div className="vp-alert vp-alert-err" role="alert">
          {banner}
        </div>
      )}
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
                <span style={{ color: 'var(--vp-ok-ink)' }}>
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
        // Blur validation can add a line above this button between pointer
        // down/up, moving it away from the tap. An invalid submit focuses the
        // first error itself; keep the field focused until that click lands.
        onMouseDown={(e) => { if (!valid) e.preventDefault(); }}
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
  const { selbst } = useRollen();
  const [zugriffBeendet, setZugriffBeendet] = useState<string | null>(null);
  const ladeNummer = useRef(0);
  const [route, setRoute] = useState<Route>(() => {
    const r = routeFromHash();
    return !isAdmin && PLATFORM_PAGES.some((d) => d.id === r.page) ? pageRoute('uebersicht') : r;
  });
  const page = route.page;
  const helpReturnHash = useRef<string | null>(page === 'hilfe' ? null : window.location.hash);
  useEffect(() => {
    if (route.page !== 'hilfe') helpReturnHash.current = window.location.hash;
  }, [route]);

  // Admin tenant context (the switcher). Customers never have an override -
  // their tenant comes from the JWT and the backend ignores the header anyway.
  // The selection survives a reload (sessionStorage) so an admin does not
  // land back on "Mandanten-Kontext wählen" after every refresh.
  const [tenantId, setTenantId] = useState<string | null>(() =>
    isAdmin ? sessionStorage.getItem('vp-tenant-override') : currentRoles().includes('partner') ? sessionStorage.getItem('vp-kundenbereich') : null,
  );
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const [sites, setSites] = useState<Site[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  // Die Bezugszeit der Geräteliste: WANN der Server diese `lastSeenAt`-Werte
  // gemeldet hat. Sie wird NUR gemeinsam mit `devices` gesetzt - genau das
  // verhindert, dass ein stehender Schnappschuss gegen eine weiterlaufende
  // Uhr altert und die Kopfzeile grundlos auf „Gerät meldet sich nicht"
  // kippt (siehe `liveness.ts`).
  const [devicesAt, setDevicesAt] = useState<number | null>(null);
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
  // AP-01 E5 = A: Ziel des offenen Messen-Assistenten (`null` = zu), Zahl der Schließungen, Avatar → Karte.
  const [messenZiel, setMessenZiel] = useState<MessenZiel | null>(null);
  const [messenRunde, setMessenRunde] = useState(0);
  const [karteGezeigtAm, setKarteGezeigtAm] = useState<number | null>(null);
  // Deploy-Erkennung (deployWatch.ts): ein tagelang offener Tab erfuhr sonst
  // NIE von einem Deploy und zeigte die UI seines Boot-Stands weiter (die
  // APIs sind additiv, die alte App läuft klaglos - Scout vp-stale-view-w2).
  const updateAvailable = useDeployWatch();

  /* ---------------------------------------------------------------------
     DER SEITENWECHSEL LÄUFT DURCH GENAU EINE HÜLLE (Bewegungs-Programm P5)
     Konzept `data/vp-motion-konzept-m1/report.md` §6, Empfehlung E5 (a).

     Jede Navigation des Portals endet in `window.location.hash = …` und damit
     in `onHash` — die zwei Ausnahmen sind `navigate()` (setzt den Hash SELBST
     und stellt die Route sofort, damit ein Klick nicht auf ein Ereignis
     wartet) und die zwei Umleitungen beim Start, die ERSETZEN statt zu
     navigieren und deshalb bewusst keinen Übergang zeigen (das Ankommen der
     Anwendung gehört P4).

     ⚠ `commit` ist die EINZIGE Stelle, die `setRoute` für einen echten
       Wechsel ruft. Wer eine neue Navigationsart einführt, ruft sie hier —
       nicht ein zweites `setRoute` daneben, sonst hätte das Portal zwei
       Übergänge für dieselbe Sache.
     --------------------------------------------------------------------- */
  const routeRef = useRef<Route>(route);
  useEffect(() => { routeRef.current = route; }, [route]);
  // Der Verlaufs-Index, den `navigationBlocker` ohnehin mitführt: SINKT er,
  // war es ein Zurück — die einzige belastbare Quelle dafür (ein Vergleich am
  // Hash-Text rät, siehe `nav.transitionKind`).
  const navIndex = useRef<number>(-1);
  // Welche Adresse gerade durch die Hülle läuft. Sie verhindert, dass das
  // `hashchange`-Echo eines `navigate()` einen ZWEITEN Übergang auf dasselbe
  // Ziel startet (das Vorladen kann zwischen beiden liegen).
  const committedHref = useRef<string>(window.location.href);

  const commit = useCallback((next: Route, back: boolean) => {
    committedHref.current = window.location.href;
    const kind = transitionKind(routeRef.current, next, back);
    transitionToRoute(next, kind, () => setRoute(next));
  }, []);

  // Jeder Seitenwechsel läuft hier durch — auch ein Sprung, dessen Adresse mehr trägt als die Route
  // (UEMS AP-13 IP-3: `?periode=…&version=…` aus `uemsOberflaechen.sprungziel`).
  const geheZu = useCallback(
    (r: Route, nextHash: string) => {
      if (requestNavigation(new URL(nextHash, window.location.href).href)) return;
      window.location.hash = nextHash;
      navIndex.current = recordNewNavigation();
      commit(r, false);
      // A page switch is a navigation, not a scroll continuation.
      window.scrollTo({ top: 0 });
    },
    [commit],
  );

  const navigate = useCallback(
    (target: Route | PageId) => {
      let r: Route = typeof target === 'string' ? pageRoute(target) : target;
      if (!isAdmin && PLATFORM_PAGES.some((d) => d.id === r.page)) r = pageRoute('uebersicht');
      geheZu(r, hashForRoute(r));
    },
    [isAdmin, geheZu],
  );

  const springe = useCallback((s: Sprung) => geheZu(s.route, s.hash), [geheZu]);

  // Hash routing: back/forward + direct edits.
  useEffect(() => {
    navIndex.current = recordCurrentNavigation();
    const onHash = () => {
      if (requestNavigation(window.location.href, true)) return;
      const index = recordNewNavigation();
      const back = index < navIndex.current;
      navIndex.current = index;
      // Das Echo eines `navigate()`: der Wechsel läuft schon.
      if (window.location.href === committedHref.current) return;
      const r = routeFromHash();
      commit(!isAdmin && PLATFORM_PAGES.some((d) => d.id === r.page) ? pageRoute('uebersicht') : r, back);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [isAdmin, commit]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey
        || event.shiftKey || event.altKey) return;
      const source = event.target;
      const link = source instanceof Element ? source.closest('a[href]') : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.download) return;
      if (!requestNavigation(link.href)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Eine stillgelegte Unterseite (`…/historie` → `…/messwerte`, `…/entitaeten`
  // → `…/modell`, …) wird in der ADRESSE auf die kanonische Route umgeschrieben
  // - MIT ihren Parametern, damit ein Lesezeichen wie
  // `…/historie?m=…&z=woche` denselben Messwert im selben Zeitraum öffnet.
  // `replaceState` erzeugt keinen Verlaufseintrag und kein `hashchange`; die
  // geparste Route ist ohnehin dieselbe.
  useEffect(() => {
    const canonical =
      canonicalAnlageHash(window.location.hash)
      ?? canonicalPlatformHash(window.location.hash);
    if (canonical) {
      replaceCurrentNavigation(canonical);
    }
  }, [route]);

  const reloadTenants = useCallback(
    (selectId?: string) => {
      if (!isAdmin) return;
      import('./admin/adminApi')
        .then(({ adminApi }) => adminApi.listTenants())
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
    if (isAdmin && tenantId && tenants.length > 0 && !tenants.some((t) => t.id === tenantId)) {
      setTenantId(null);
      sessionStorage.removeItem('vp-tenant-override');
    }
  }, [isAdmin, tenants, tenantId]);

  // Tenant-scoped data. For an admin without a selected tenant this yields
  // empty lists (backend default-deny) - the pages show a pick-a-tenant hint.
  const tenantReady = !isAdmin || tenantId != null;
  // UEMS AP-01 IP-5: die Ortsstruktur HEUTE für die Startansicht-Weiche und den
  // Pfad der Kopfzeile. `null` = nicht geladen, älteres Backend oder Fehler.
  const [orteQuelle, setOrteQuelle] = useState<OrteQuelle | null>(null);
  const reload = useCallback(
    async (selectSiteId?: string, opts?: { background?: boolean }) => {
      const nummer = ++ladeNummer.current;
      if (!tenantReady) {
        try { const me = await api.selbstauskunft(); if (nummer === ladeNummer.current) setSelbstauskunft(me); } catch { if (nummer === ladeNummer.current) setSelbstauskunft(null); }
        if (nummer !== ladeNummer.current) return;
        setOrteQuelle(null);
        setSites([]);
        setDevices([]);
        setDevicesAt(null);
        setBetriebsart(null);
        setSelectedSite(null);
        return;
      }
      try {
        const me = await api.selbstauskunft();
        if (nummer !== ladeNummer.current) return;
        setSelbstauskunft(me);
        if (ohneStandort(me)) {
          setSites([]);
          setDevices([]);
          setOrteQuelle(null);
          setSelectedSite(null);
          setError(null);
          return;
        }
        // The tenant-context read is fail-soft: an older backend (or a
        // transient blip) leaves the frame on its last known value - never a
        // broken portal, and never a mid-session shell flip from one failed
        // background poll. A never-succeeding read keeps the initial null =
        // the v1 site-count fallback.
        // IP-5: die Standorte reisen im SELBEN Schnappschuss wie die Anlagen —
        // die Weiche sieht beide zugleich und ersetzt die Adresse genau einmal.
        // Fail-soft wie der Kontext; eine Hintergrund-Auffrischung behält den
        // letzten Stand.
        const [s, d, ctx, orte] = await Promise.all([
          api.listSites().then((antwort) => antwort.eintraege),
          api.listDevices().then((antwort) => antwort.eintraege),
          api.tenantContext().catch(() => null),
          opts?.background ? Promise.resolve(undefined) : orteLaden(),
        ]);
        if (nummer !== ladeNummer.current) return;
        setSites(s);
        if (orte !== undefined) setOrteQuelle(orte ? {
          ...orte,
          liste: { ...orte.liste, standorte: orte.liste.standorte.filter((ort) => me.standorte.some((x) => x.id === ort.id)) },
        } : null);
        setDevices(d);
        setDevicesAt(Date.now());
        if (ctx) setBetriebsart(ctx.betriebsart);
        setSelectedSite((cur) =>
          selectSiteId ?? (cur && s.some((x) => x.id === cur) ? cur : s[0]?.id ?? null),
        );
        setError(null);
      } catch (e) {
        // A background poll (Geräte-Seite alle 30 s) must not raise the app-wide
        // red banner on a momentary blip - it keeps the last good data and
        // fails silently; only a user-triggered/initial load surfaces the error.
        if (nummer === ladeNummer.current && !opts?.background) {
          setError(e instanceof ApiError ? `API-Fehler: ${e.message}` : 'Unbekannter Fehler');
        }
      } finally {
        if (nummer === ladeNummer.current) setLoaded(true);
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
    ++ladeNummer.current;
    setSelbstauskunft(null);
    setLoaded(false);
    setSites([]);
    setDevices([]);
    setOrteQuelle(null);
    setTenantOverride(isAdmin ? tenantId : null);
    setKundenbereich(tenantId);
  }, [isAdmin, tenantId]);

  useEffect(() => {
    void reload();
  }, [reload, tenantId]);

  useEffect(() => { const neu = () => void reload(); window.addEventListener('vp-unterstuetzung-geaendert', neu); return () => window.removeEventListener('vp-unterstuetzung-geaendert', neu); }, [reload]);

  useEffect(() => {
    let laedt = false;
    const entzogen = (event: Event) => {
      if (laedt) return;
      laedt = true;
      setZugriffBeendet((event as CustomEvent<string>).detail);
      setLoaded(false);
      setSelbstauskunft(null);
      setSites([]);
      setDevices([]);
      setOrteQuelle(null);
      setSelectedSite(null);
      setAddAnlageOpen(false);
      replaceCurrentNavigation('#/uebersicht');
      setRoute(pageRoute('uebersicht'));
      void reload().finally(() => { laedt = false; });
    };
    window.addEventListener('vp-zugriff-beendet', entzogen);
    return () => window.removeEventListener('vp-zugriff-beendet', entzogen);
  }, [reload]);

  // Admin-Umbau Stufe 1 (Captain-Entscheid F1): ein Admin-Boot OHNE Ziel
  // landet auf der PLATTFORM-ÜBERSICHT statt auf der Kunden-Übersicht, die
  // ohne gewählten Mandanten praktisch leer ist. Sie ist als „täglicher
  // erster Blick" gebaut (Q1) - der Admin soll auf ihr aufwachen.
  //
  // ⚠ Nur der LEERE Boot-Hash, und genau EINMAL: der Nav-Punkt „Übersicht"
  // bleibt für Admins bedienbar, ein Deep-Link (auch `#/uebersicht`) wird nie
  // umgeleitet. `replace()` hält den Verlauf sauber (Zurück verlässt die App,
  // statt hierher zurückzuspringen) - dieselbe Mechanik wie die
  // Endkunden-/Betreiber-Weiterleitungen darunter. Sie läuft VOR dem Laden,
  // also greift die Portfolio-Weiterleitung danach nicht mehr (ein Admin, der
  // einen Betreiber-Mandanten gewählt hat, erreicht das Portfolio weiterhin
  // über die Seitenleiste).
  const bootHash = useRef(isBootHash(window.location.hash));
  useEffect(() => {
    if (!bootHash.current) return;
    bootHash.current = false;
    if (!redirectAdminToPlattform({ isAdmin, bootHash: true })) return;
    window.location.replace(hashForRoute(pageRoute('plattform-uebersicht')));
    setRoute(pageRoute('plattform-uebersicht'));
  }, [isAdmin]);

  // UEMS AP-01 IP-5 (E1): die Ebene, auf der der Kunde landet, EINMAL aus
  // Anlagen und Standorten abgeleitet — Weiche, Seitenleiste und Pfad lesen sie.
  const orte = useMemo(
    () => {
      const basis = orteQuelle ? orteAus(orteQuelle.liste, orteQuelle.unternehmen) : null;
      if (!selbst) return null;
      if (selbst.standorte.length === 0) return basis;
      return {
        standorte: selbst.standorte.map((s) => ({ id: s.id, name: s.name,
          anlagen: basis?.standorte.find((o) => o.id === s.id)?.anlagen ?? [] })),
        standorteGesamt: selbst.teilansicht?.gesamt ?? null,
        unternehmen: basis?.unternehmen ?? selbst.kundenbereich?.name ?? null,
      };
    },
    [orteQuelle, selbst],
  );
  const ebene = useMemo(
    () => startEbene({ isAdmin, betriebsart, siteIds: sites.map((site) => site.id), orte, eingeschraenkt: selbst != null && !selbst.unternehmensweit }),
    [isAdmin, betriebsart, sites, orte, selbst],
  );

  // UEMS AP-01 IP-6, Geld-Regel: auf der Unternehmens- und der Standort-Ebene
  // zeigt der Reiter „Erlöse" nur Anlagen, die steuern oder Erzeuger/Speicher
  // haben — ein reiner Messkunde bekommt ihn nicht. Solange die Fakten unbekannt
  // sind (lädt, Fehler, keine Ebene), gilt die heutige Regel `hatGeldWelt`.
  const [geldIds, setGeldIds] = useState<Set<string> | null>(null);
  // UEMS AP-01 IP-7: dieselbe Welle liest die Lesemodelle der Ebenen-Leiste mit
  // (`ebenenNav.ebenenBereiche`); jedes einzeln `null`, wenn es fehlt.
  const [ebenenFakten, setEbenenFakten] = useState<Pick<EbenenLesemodell, 'funktionen' | 'kennzahlen'> | null>(null);
  const aufEbene = ebene.art === 'unternehmen' || ebene.art === 'standort';
  const anlagenSchluessel = sites.map((site) => site.id).join(',');
  useEffect(() => {
    if (!aufEbene) {
      setGeldIds(null);
      setEbenenFakten(null);
      return;
    }
    let active = true;
    Promise.all([
      api.overview(),
      api.funktionen().catch(() => null),
      api.kennzahlen().then((k) => k.kennzahlen, () => null),
    ]).then(
      ([o, f, k]) => {
        if (!active) return;
        setGeldIds(geldAnlagen(o.sites, f));
        setEbenenFakten({ funktionen: f, kennzahlen: k });
      },
      () => {
        if (!active) return;
        setGeldIds(null);
        setEbenenFakten(null);
      },
    );
    return () => {
      active = false;
    };
  }, [aufEbene, anlagenSchluessel]);
  const geldSites = aufEbene && geldIds ? sites.filter((site) => geldIds.has(site.id)) : sites;

  // One stable post-hydration canonicalization. The old three independent
  // redirects could emit `uebersicht -> anlagen -> portfolio -> uebersicht`
  // for a one-site customer. The pure decision below sees one shell snapshot,
  // chooses the final target directly and performs at most one replacement.
  useEffect(() => {
    if (error != null || !selbst || ohneStandort(selbst)) return;
    const shell = { isAdmin, loaded, tenantReady, betriebsart, siteCount: sites.length, ebene };
    const target = canonicalShellRoute({ shell, route, siteIds: sites.map((site) => site.id) });
    if (!target) return;
    replaceCurrentNavigation(canonicalShellHash(target, window.location.hash));
    setRoute(target);
  }, [
    isAdmin,
    loaded,
    tenantReady,
    betriebsart,
    error,
    selbst,
    sites,
    ebene,
    route.page,
    route.siteId,
    route.sub,
    route.geraet,
    route.standortId,
  ]);

  // An Anlage opened by route is also the context of the site-scoped pages
  // (Marktpreise, Prognosequalität) - switching there stays on "their" site.
  useEffect(() => {
    if (route.page === 'anlagen' && route.siteId) setSelectedSite(route.siteId);
  }, [route]);

  const changeTenant = (id: string | null) => {
    ++ladeNummer.current;
    setSelbstauskunft(null);
    setLoaded(false);
    setSites([]); setDevices([]); setOrteQuelle(null);
    setTenantId(id);
    if (!isAdmin) { if (id) sessionStorage.setItem('vp-kundenbereich', id); else sessionStorage.removeItem('vp-kundenbereich'); }
    setSelectedSite(null);
    if (isAdmin) { if (id) sessionStorage.setItem('vp-tenant-override', id); else sessionStorage.removeItem('vp-tenant-override'); }
    if (!isAdmin) { replaceCurrentNavigation('#/uebersicht'); setRoute(pageRoute('uebersicht')); }
  };

  // Der Sprung in einen Mandanten-Kontext. `target` ist bewusst eine ganze
  // Route (nicht nur eine PageId), damit der Flotten-Puls direkt in DIE Anlage
  // springen kann statt nur auf die Übersicht des Mandanten.
  const jumpToTenant = (id: string, target: Route | PageId) => {
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
  // Marktpreise/Prognose sind seit der Navigations-Runde „zwei Ebenen" (E3)
  // REITER des Verlaufs, also gewöhnliche Unterseiten - ein eigener Zweig für
  // sie gibt es nicht mehr.
  const shellSite = page === 'anlagen' ? resolveAnlage(sites, route.siteId) : null;
  const { surface, aufmerksam } = useAnlageSurface(shellSite);

  // Die stille Auffrischung der Geräteliste - das Gegenstück zur Bezugszeit
  // oben. Vorher tickte hier nur eine Uhr über einem EINMAL geladenen
  // Schnappschuss: `lastSeenAt` blieb stehen, `now` lief weiter, also kippte
  // die Kopfzeile nach fünf Minuten offenem Portal zwangsläufig auf „Gerät
  // meldet sich nicht" und heilte erst mit F5 (Captain-Meldung 30.07.). Jetzt
  // wird die Wahrheit selbst nachgeholt: jede erfolgreiche Antwort setzt
  // Zustand UND Bezugszeit, ein Fehlschlag lässt beides unberührt (er kann den
  // Zustand also nicht kippen) und meldet NIE das rote Banner - das gehört
  // einem vom Kunden ausgelösten Laden. Der Tenant wird beim Absenden
  // festgehalten, damit eine spät eintreffende Antwort nach einem
  // Mandantenwechsel nicht die falschen Geräte einsetzt.
  const tenantRef = useRef(tenantId);
  tenantRef.current = tenantId;
  const refreshDevices = useCallback(() => {
    if (!tenantReady || !selbst || ohneStandort(selbst)) return;
    const forTenant = tenantRef.current;
    const nummer = ladeNummer.current;
    api.listDevices().then((antwort) => antwort.eintraege).then(
      (d) => {
        if (tenantRef.current !== forTenant || nummer !== ladeNummer.current) return;
        setDevices(d);
        setDevicesAt(Date.now());
      },
      () => {},
    );
  }, [tenantReady, selbst]);
  useFreshnessPoll(refreshDevices, LIVENESS_POLL_MS, tenantReady && selbst !== null && !ohneStandort(selbst));

  // Device liveness of the Anlage in scope, judged against the moment the
  // server answered - never against a clock that ran past a snapshot we could
  // not refresh (`liveness.ts` carries the full rule).
  const deviceHealth = useMemo(
    () => (shellSite ? deviceHealthForSite({ devices, fetchedAt: devicesAt }, shellSite.id) : null),
    [shellSite, devices, devicesAt],
  );

  // The facts only the Anlagen-Seite measures (plan / control / battery link),
  // reported upward so header and cockpit are ONE health truth — the badge used
  // to run on device liveness alone, so it could only ever say something about
  // a device while the cockpit's checklist knew about control and Speicher too.
  // They are kept per Anlage and dropped the moment the scope changes, so a
  // switch never carries the previous plant's findings.
  const [anlageFacts, setAnlageFacts] = useState<{
    siteId: string;
    facts: AnlageHealthFacts;
  } | null>(null);
  const onHealthFacts = useCallback((siteId: string, facts: AnlageHealthFacts) => {
    setAnlageFacts((prev) =>
      prev?.siteId === siteId && sameHealthFacts(prev.facts, facts) ? prev : { siteId, facts },
    );
  }, []);
  const scopedFacts = shellSite && anlageFacts?.siteId === shellSite.id ? anlageFacts.facts : null;

  // Die zwei Rahmen-Fragen EINMAL beantwortet (sonst rechnete jede Fläche sie
  // neu): gibt es eine Flotten-Ebene, und heißt sie „Portfolio"?
  const shellFrame = { isAdmin, loaded, tenantReady, betriebsart, siteCount: sites.length, ebene };
  const portfolioNav = showPortfolioNav(shellFrame);
  const overviewNav = showOverviewNav(shellFrame);
  const fleetLevel = portfolioNav || overviewNav;
  // UEMS AP-01 IP-5: der Pfad der Kopfzeile „Unternehmen › Standort › Anlage".
  // Jedes Glied navigiert und ist am Telefon eine Zeile des Umschalters.
  const pfad = kopfPfad({
    shell: shellFrame,
    route,
    anlageId: shellSite?.id ?? null,
    fleetLabel: fleetLabel(betriebsart),
  });
  const pfadEintrag = (glied: PfadGlied) => ({
    wert: pfadWert(glied),
    label: glied.label,
    onOpen: () => navigate(glied.route),
  });
  // Nur die NEUEN Glieder (Unternehmen, Standort) ersetzen die Flotten-Zeile
  // des Umschalters; ohne sie bleibt er Zeichen für Zeichen der von heute.
  const rueckwege = pfad.vor.some((glied) => glied.ebene !== 'flotte')
    ? pfad.vor.map(pfadZeile)
    : undefined;
  // Seitenleiste und Reiter „Übersicht" meinen die Flotten-Ebene — ist der
  // Standort die oberste Ebene, ist ER sie (kein Umweg über `#/portfolio`).
  const navigateSchale = (target: Route | PageId) => {
    if (ebene.art === 'standort' && target === 'portfolio') return navigate(flottenLandung(shellFrame));
    // AP-04 IP-5: dasselbe für „Messstellen" — oberster Standort = seine Messstellen.
    if (ebene.art === 'standort' && target === 'portfolio-messstellen') {
      return navigate(standortMessstellenRoute(ebene.standort.id));
    }
    return navigate(target);
  };
  const standortOffen =
    page === 'standort'
      ? orteQuelle?.liste.standorte.find((s) => s.id === route.standortId) ?? null
      : null;
  // IP-6: bei mehreren Standorten ist `#/portfolio` die Unternehmens-Übersicht.
  const unternehmensEbene: UebersichtEbene | null =
    ebene.art === 'unternehmen' && orteQuelle
      ? {
          art: 'unternehmen',
          name: orteQuelle.unternehmen?.name?.trim() || ebene.name || 'Ihr Unternehmen',
          standorte: orteQuelle.liste.standorte,
        }
      : null;

  const anlageNav = shellSite
    ? {
        siteId: shellSite.id,
        siteName: shellSite.name,
        sites: sites.map((s) => ({ id: s.id, name: s.name })),
        // Die angereicherten Zeilen des Vorzeige-Pickers: je Anlage
        // Gesundheits-Punkt + Nebenzeile. Sie entstehen HIER, weil hier beides
        // liegt (Anlagen UND die Geräteliste samt Bezugszeit) - die Schale
        // rechnet keine Gesundheit, sonst könnten Kopfzeile und Liste über
        // dieselbe Anlage Verschiedenes behaupten.
        siteOptions: anlagenOptionen({
          sites,
          devices: { devices, fetchedAt: devicesAt },
          mitFlotte: sites.length > 1,
          // Der Pfad der Kopfzeile und diese Zeile führen an denselben Ort,
          // also tragen sie DASSELBE Wort.
          flottenLabel: fleetLabel(betriebsart),
          rueckwege,
        }),
        onSelectSite: (id: string) => navigate(anlageRoute(id)),
        // ⚠ Das Abzeichen zählt seit Steuerung Stufe 8 die Dinge, die
        // AUFMERKSAMKEIT brauchen (§3.1) - nicht mehr die aktiven Anwendungen.
        // Der ORT ist derselbe geblieben, also ist das hier genau der
        // Argument-Wechsel, den `ebenenNav.ts` vorgesehen hatte.
        sidebar: anlageSidebar(surface, aufmerksam.anzahl, aufmerksamkeitTitel(aufmerksam)),
        // Hervorgehoben wird der BEREICH, in dem die offene Unterseite wohnt
        // (`activeAreaKey`) - ein Reiter darf die Leiste nie ins Nichts zeigen
        // lassen.
        activeKey: activeAreaKey(route.sub),
        onOpenSub: (sub: Parameters<typeof anlageRoute>[1]) =>
          navigate(anlageRoute(shellSite.id, sub ?? null)),
        onOpenPage: (target: PageId) => navigate(target),
        // Die FLOTTEN-Ebene ist seit E3 das Portfolio - die erste Picker-Zeile
        // und das führende Wort des Pfades führen dorthin, wo es eine gibt
        // (`showPortfolio`), sonst auf die Übersicht. Die frühere Listen-Seite
        // `#/anlagen` ist ersatzlos aufgegangen.
        onOpenFleet: fleetLevel ? () => navigate(flottenLandung(shellFrame)) : null,
        pfad: pfad.vor.map(pfadEintrag),
        // Composed from the devices list the shell holds (kept current by the
        // silent refresh above - a freshness verdict needs FRESH data, not a
        // clock ticking over a frozen one) plus whatever the Anlagen-Seite
        // already measured and reported up. A fact nobody supplied contributes
        // nothing (`healthBadge` drops the row), so the badge still never
        // claims health it did not measure.
        health:
          loaded && tenantReady
            ? healthBadge({ devices: deviceHealth, ...(scopedFacts ?? {}) })
            : null,
      }
    : null;

  // UEMS AP-01 IP-7 (E4 = A): auf einer Seite der Unternehmens- oder
  // Standort-Ebene die Leiste ihrer Bereiche MIT Seite, erst ab drei — sonst
  // keine, und die Reiter navigieren wie heute. In einer Anlage gilt ihre Leiste.
  const ebenenOrtHier = anlageNav ? null : ebenenOrt(route, ebene);
  const ebenenLesemodell: EbenenLesemodell = {
    standorte: orteQuelle?.liste.standorte ?? null,
    funktionen: ebenenFakten?.funktionen ?? null,
    kennzahlen: ebenenFakten?.kennzahlen ?? null,
    // AP-16 IP-6: „Bewertung“ nur mit `energieeinsatz.ansehen` — ohne Selbstauskunft kein Bereich.
    bewertung: selbst ? darfEnergieeinsaetzeSehen(selbst) : null,
    // AP-18 IP-8: „Ziele und Maßnahmen“ nur mit `verbesserung.ansehen`.
    verbesserung: selbst ? darfVerbesserungSehen(selbst) : null,
  };
  const ebenenKacheln = ebenenOrtHier ? ebenenLeiste(ebenenOrtHier, ebenenLesemodell) : [];
  const standortBereich = standortBereichFuer(route, ebenenLesemodell);
  const ebenenNav =
    ebenenOrtHier && ebenenKacheln.length > 0
      ? {
          titel: ebenenTitel(ebenenOrtHier, ebenenLesemodell, unternehmensEbene?.name ?? 'Ihr Unternehmen'),
          kacheln: ebenenKacheln,
          aktiv: ebenenAktiv(page, standortBereich),
          onOpen: (ziel: Route) => navigate(ziel),
        }
      : null;
  // UEMS AP-04 IP-5: die Bereiche der Ebene steuern die Reiter mit — „Messstellen"
  // nur, wo ein Standort misst; am Telefon trägt die Leiste (ab drei) die Bereiche,
  // die Reiter dann nur noch, was zum offenen Bereich gehört.
  const bereicheHier = ebenenOrtHier ? ebenenBereiche(ebenenOrtHier, ebenenLesemodell).map((b) => b.key) : [];
  const messstellenDa = ebenenFakten ? bereicheHier.includes('messstellen') : null;
  // AP-09 IP-9: Unternehmenswelt auch ohne vorhandene Bezugsgröße, sobald ein Standort misst.
  const bezugsgroessenDa = ebenenFakten ? ebenenBereiche({ art: 'unternehmen' }, ebenenLesemodell).some(b => b.key === 'bezugsgroessen') : null;
  // AP-11 IP-13: Kennzahlen zusätzlich erst mit einer Kennzahl.
  const kennzahlenDa = ebenenFakten ? bereicheHier.includes('kennzahlen') : null;
  // AP-12 IP-13: der Reiter „Berichte" nur, wo die Ebene den Bereich hat (ein Standort misst).
  const berichteDa = ebenenFakten ? bereicheHier.includes('berichte') : null;
  // AP-16 IP-6: der Reiter „Bewertung“ nach derselben Regel, dazu das Recht aus `/me`.
  const bewertungDa = ebenenFakten ? bereicheHier.includes('bewertung') : null;
  // AP-18 IP-8: der Reiter „Ziele und Maßnahmen“ nach derselben Regel mit `verbesserung.ansehen`.
  const verbesserungDa = ebenenFakten ? bereicheHier.includes('verbesserung') : null;
  const leisteHier = ebenenKacheln.map((k) => k.key);
  // Unter einem Unternehmen hat der Standort eigene Reiter (Übersicht · Gebäude · Anlagen · Messstellen);
  // ist er die oberste Ebene, trägt `PortfolioTabs` sie.
  const standortReiter =
    page === 'standort' && ebene.art !== 'standort' && ebenenOrtHier?.art === 'standort'
      ? ebenenReiter(ebenenOrtHier, ebenenLesemodell)
      : [];
  // AP-13 IP-2: als oberste Ebene bringt der Standort Gebäude · Anlagen in `PortfolioTabs` mit.
  const standortObenReiter =
    ebene.art === 'standort' && ebenenOrtHier?.art === 'standort'
      ? ebenenReiter(ebenenOrtHier, ebenenLesemodell)
          .filter((r) => r.key === 'boxen' || r.key === 'gebaeude' || r.key === 'anlagen')
      : [];
  // AP-13 IP-2 (Ü8): die Einstiege der Standort-Übersicht in „Kennzahlen/Berichte dieses Standorts“.
  const einstiegeHier = ebenenOrtHier?.art === 'standort' ? standortEinstiege(ebenenOrtHier, ebenenLesemodell) : [];
  const messstellenEbene =
    page === 'portfolio-messstellen' && ebene.art !== 'standort'
      ? { art: 'unternehmen' as const, name: unternehmensEbene?.name ?? 'Ihr Unternehmen' }
      : page === 'portfolio-messstellen' && ebene.art === 'standort'
        ? { art: 'standort' as const, id: ebene.standort.id, name: ebene.standort.name }
        : page === 'standort' && route.standortBereich === 'messstellen' && standortOffen
          ? { art: 'standort' as const, id: standortOffen.id, name: standortOffen.name }
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
    !isAdmin && loaded && !error && devices.length === 0 && !onboardingDismissed && darf('anlage.verwalten');

  // The always-visible shell action for the one case with no obvious entry
  // point: a customer with exactly one Anlage (no Übersicht, no Anlagen-Liste).
  const showAddAnlage = darf('anlage.verwalten') && showAddAnlageButton({
    isAdmin,
    loaded,
    tenantReady,
    onboarding: showOnboarding,
    siteCount: sites.length,
  });

  function finishOnboarding(ziel?: Route) {
    setOnboardingDismissed(true);
    void reload();
    // Modus „nur messen“ (`anlegeNurMessen.ts`): das Ende nennt „Standort › Messstellen“ als Ziel.
    if (ziel) navigate(ziel);
  }

  const leer = ohneStandort(selbst);
  const rechteStandort = route.standortId ?? orte?.standorte.find((s) => s.anlagen.includes(shellSite?.id ?? ''))?.id ?? null;
  // Avatar-Menü „Funktionen“ (AP-01 E5 = A): nur, wo die Landung eine Ebene mit der Karte ist. Die Anlage- und die
  // Bestands-Landung haben keine Karte - dort bleibt das Menü, wie es war.
  const funktionenZiel: Route | null =
    ebene.art === 'unternehmen' ? pageRoute('portfolio') : ebene.art === 'standort' ? standortRoute(ebene.standort.id) : null;
  const messenWirt = { oeffnen: setMessenZiel, runde: messenRunde, karteGezeigtAm };
  return (
    <RechteStandort.Provider value={rechteStandort}>
    <MessenEinstiegKontext.Provider value={messenWirt}>
    <AppShell
      page={page}
      onNavigate={navigateSchale}
      isAdmin={isAdmin}
      // U0: the "Übersicht" nav item follows the tenant's Betriebsart frame
      // (betreiber = always the fleet level; endkunde = only from the second
      // Anlage on, where it renders the calm card overview), not the raw site
      // count. Unknown frame falls back to the v1 heuristic.
      showOverview={!leer && overviewNav}
      // U5: a betreiber frame swaps "Übersicht" for the "Portfolio" landing.
      showPortfolio={!leer && portfolioNav}
      fleetLabel={fleetLabel(betriebsart)}
      showAddAnlage={showAddAnlage}
      onAddAnlage={() => setAddAnlageOpen(true)}
      onFunktionen={funktionenZiel ? () => {
        navigate(funktionenZiel);
        setKarteGezeigtAm(Date.now());
      } : undefined}
      counts={{
        sites: tenantReady ? sites.length : null,
        devices: tenantReady ? devices.length : null,
      }}
      tenants={tenants}
      tenantOverride={tenantId}
      onTenantChange={changeTenant}
      anlage={leer ? null : anlageNav}
      ebenen={leer ? null : ebenenNav}
      ohneStandort={leer}
      teilansicht={teilansichtKopf(selbst)}
      ortsPfad={!anlageNav && pfad.hier ? { vor: pfad.vor.map(pfadEintrag), hier: pfad.hier } : null}
      helpArticle={page === 'hilfe' ? null : loadFailed ? 'probleme' : showOnboarding ? null : helpForRoute(route)}
    >
      {zugriffBeendet && <div className="vp-alert" role="alert">
        <strong>Zugriff beendet</strong><p>{zugriffBeendet}</p>
        <Button variant="outline" onClick={() => setZugriffBeendet(null)}>Verstanden</Button>
      </div>}
      {updateAvailable && (
        // Der Server liefert einen neueren Stand als den, den dieser Tab
        // ausführt (useDeployWatch). Sichtbar = dezenter Hinweis, nie ein
        // Reload unter dem Kunden; verdeckte Tabs hat der Hook schon selbst
        // still neu geladen. position: fixed - der DOM-Platz ist egal.
        <div className="vp-update-toast" role="status">
          <span>Eine neue Version des Portals ist verfügbar.</span>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="refresh-cw" size={16} />}
            onClick={() => window.location.reload()}
          >
            Jetzt aktualisieren
          </Button>
        </div>
      )}
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

      {page === 'hilfe' ? (
        <LazyBoundary><HelpPage articleId={route.helpArticle}
          returnHref={helpReturnHash.current || hashForRoute(
            isAdmin && !tenantId ? pageRoute('plattform-uebersicht')
              : sites.length === 1 ? anlageRoute(sites[0].id)
                : flottenLandung(shellFrame),
          )} /></LazyBoundary>
      ) : needsTenantPick ? (
        <PickTenantNotice tenants={tenants} onPick={changeTenant} />
      ) : loadFailed ? (
        <LoadErrorNotice onRetry={() => void reload()} />
      ) : tenantReady && !selbst && !PLATFORM_PAGES.some((p) => p.id === page) ? (
        <Card padding="lg" radius="lg"><p>Wird geladen …</p></Card>
      ) : leer ? (
        <Card padding="lg" radius="lg"><h1>Kein Standort zugewiesen</h1><p>{selbst?.text}</p>
          {selbst?.kuenftig.map((z) => <p key={`${z.standort}-${z.ab}`}>{z.text}</p>)}
        </Card>
      ) : showOnboarding ? (
        <LazyBoundary fallback={null}>
          <OnboardingWizard sites={sites} onDone={(ziel) => finishOnboarding(ziel)} onSkip={() => finishOnboarding()} />
        </LazyBoundary>
      ) : (
        <>
          {(page === 'uebersicht' || page === 'anlagen') &&
            !isAdmin &&
            loaded &&
            !error &&
            devices.length === 0 && darf('anlage.verwalten') && (
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
          {/* Jede lazy geladene Seite hinter EINER Suspense-Grenze: die
              Anlagen-Seite bleibt statisch (sie ist das Ziel fast jedes
              Besuchs), alles andere kommt beim ersten Aufruf nach. Der
              Platzhalter ist ein Skelett, nie eine erfundene Zahl. */}
          <LazyBoundary>
          {/* Die Reiter der FLOTTEN-Ebene (E3/S4) - sie ersetzen die
              Seitenleisten-Gruppe „Alle Anlagen". */}
          <PortfolioTabs
            // IP-5: ist der Standort die oberste Ebene, IST seine Übersicht der
            // Reiter „Übersicht"; unter einem Unternehmen trägt sie keine Reiter.
            page={
              page === 'standort' && ebene.art === 'standort'
                ? route.standortBereich === 'messstellen'
                  ? 'portfolio-messstellen'
                  : 'portfolio'
                : page
            }
            showErloese={hatGeldWelt(geldSites)}
            showMessstellen={messstellenDa === true}
            showBezugsgroessen={bezugsgroessenDa === true}
            showKennzahlen={kennzahlenDa === true}
            showBerichte={berichteDa === true}
            showBewertung={bewertungDa === true}
            showVerbesserung={verbesserungDa === true}
            leiste={leisteHier}
            fleetLabel={fleetLabel(betriebsart)}
            onNavigate={navigateSchale}
            standortBereiche={standortObenReiter}
            standortAktiv={ebenenAktiv(page, standortBereich)}
            onOpenBereich={navigate}
          />
          {standortReiter.length > 0 && ebenenOrtHier && (
            <EbenenTabs
              reiter={standortReiter}
              aktiv={ebenenAktiv(page, standortBereich)}
              leiste={leisteHier}
              label={`Reiter des Standorts ${standortOffen?.name ?? ''}`.trim()}
              onOpen={navigate}
            />
          )}
          {page === 'portfolio' && (
            <PortfolioPage
              sites={sites}
              onNavigate={navigate}
              onReload={(selectSiteId?: string) => void reload(selectSiteId)}
              isAdmin={isAdmin}
              betriebsart={betriebsart}
              ebene={unternehmensEbene}
            />
          )}
          {/* PR G: die zwei Historie-Welten des Portfolios. Sie leben auf der
              Portfolio-EBENE, tragen also dieselben Anlagen wie die Landung. */}
          {/* UEMS AP-02 IP-6: „Unternehmen › Standorte“ als Reiter der Übersicht. */}
          {page === 'portfolio-standorte' && <StandortePage />}
          {/* AP-09 IP-9: Unternehmenswelt; Direktadressen beachten dieselbe Messkunden-Grenze. */}
          {page === 'portfolio-bezugsgroessen' && (
            bezugsgroessenDa === true ? <BezugsgroessenPage /> : (
              <p>{bezugsgroessenDa === null ? 'Wird geladen …' : 'Bezugsgrößen stehen zur Verfügung, sobald ein Standort misst.'}</p>
            )
          )}
          {/* UEMS AP-11 IP-13: „Unternehmen › Kennzahlen“ und die Kennzahl-Seite. */}
          {page === 'portfolio-kennzahlen' && (
            <KennzahlenPage
              kennzahlId={route.kennzahlId ?? null}
              onOeffnen={(id) => navigate(kennzahlRoute(id))}
              onListe={() => navigate(pageRoute('portfolio-kennzahlen'))}
            />
          )}
          {/* UEMS AP-12 IP-13: „Unternehmen › Berichte" und die Berichtsseite. */}
          {page === 'portfolio-berichte' && (
            <BerichtePage
              kennung={route.berichtKennung ?? null}
              onOeffnen={(kennung) => navigate(berichtRoute(kennung))}
              onListe={() => navigate(pageRoute('portfolio-berichte'))}
              onBewertung={() => navigate(pageRoute('portfolio-bewertung'))}
            />
          )}
          {/* UEMS AP-16 IP-6: „Unternehmen › Bewertung“ (Umfang, Energieeinsätze) und die Seite eines Einsatzes. */}
          {page === 'portfolio-bewertung' && (
            <BewertungPage
              einsatzId={route.energieeinsatzId ?? null}
              onOeffnen={(id) => navigate(energieeinsatzRoute(id))}
              onListe={() => navigate(pageRoute('portfolio-bewertung'))}
            />
          )}
          {/* UEMS AP-18 IP-8: „Unternehmen › Ziele und Maßnahmen“ (Energieziele, Maßnahmen, Abweichungen) und die
              Seite eines Energieziels. */}
          {page === 'portfolio-verbesserung' && (
            <VerbesserungBereich
              reiter={route.verbesserungReiter ?? 'energieziele'}
              energiezielId={route.energiezielId ?? null}
              massnahmeId={route.massnahmeId ?? null}
              onReiter={(r) => navigate(verbesserungRoute(r))}
              onOeffnen={(id) => navigate(energiezielRoute(id))}
              onListe={() => navigate(verbesserungRoute())}
              onKennzahl={(id) => navigate(kennzahlRoute(id))}
              onMassnahme={(id) => navigate(massnahmeRoute(id))}
            />
          )}
          {/* UEMS AP-01 IP-5: die Standort-Übersicht `#/standort/{id}`. */}
          {/* UEMS AP-04 IP-5: „Unternehmen › Messstellen" und „Standort › Messstellen". */}
          {messstellenEbene && (
            <MessstellenPage
              key={messstellenEbene.art === 'standort' ? messstellenEbene.id : 'unternehmen'}
              ebene={messstellenEbene}
              bereichDa={messstellenDa}
              // AP-13 IP-9: Kostenstellen und Prozesse gehören dem Unternehmen — ihre Reiter nur in dessen Welt Messstellen
              // (auch, wenn der eine Standort oben steht), nie am Standort unter dem Unternehmen, nie in einer Teilansicht.
              organisation={page === 'portfolio-messstellen' && !(ebene.art === 'standort' && ebene.teilansicht)}
              zone={
                messstellenEbene.art === 'standort'
                  ? orteQuelle?.liste.standorte.find((s) => s.id === messstellenEbene.id)?.zeitzone
                  : undefined
              }
              onUebersicht={() =>
                navigate(messstellenEbene.art === 'standort' ? standortRoute(messstellenEbene.id) : pageRoute('portfolio'))
              }
              // AP-01 E5 = A: der Leerzustand führt in den Assistenten (am Standort mit Vorwahl).
              onMessenEinrichten={() =>
                setMessenZiel({ standortId: messstellenEbene.art === 'standort' ? messstellenEbene.id : null })
              }
              // AP-04 IP-8: die Messstellen-Seite im Bereich, aus dem sie geöffnet wird.
              messstelleId={route.messstelleId ?? null}
              onOeffnen={(id) =>
                navigate(page === 'standort' && route.standortId ? messstelleRoute(id, route.standortId) : messstelleRoute(id))
              }
              // AP-13 IP-3: der Abschnitt „Werte“ mit Periode (und Version) in der Adresse. Ein Einstieg aus dem
              // Register ist ein Seitenwechsel; eine neue Wahl auf der Seite ersetzt nur die Adresse.
              werte={parseMessstelleWerte(window.location.hash)}
              onWerte={(id, periode) => {
                const s = sprungziel({ art: 'messstelle', id, standortId: page === 'standort' ? route.standortId : null, periode });
                if (s) springe(s);
              }}
              onWerteZeitraum={(periode) => {
                // AP-13 IP-5: der Vergleich überlebt einen Zeitraum-Wechsel; die Version tut es nicht (neue Periode, neue Zahl).
                const jetzt = parseMessstelleWerte(window.location.hash);
                const s = route.messstelleId
                  ? sprungziel({
                      art: 'messstelle',
                      id: route.messstelleId,
                      standortId: page === 'standort' ? route.standortId : null,
                      periode,
                      vergleich: jetzt.vergleich,
                    })
                  : null;
                if (s) replaceCurrentNavigation(s.hash);
              }}
              // AP-13 IP-5: die Wahl des Umschalters als `v=`; Periode und Version der Adresse bleiben stehen.
              onWerteVergleich={(v) => {
                const jetzt = parseMessstelleWerte(window.location.hash);
                const s = route.messstelleId
                  ? sprungziel({
                      art: 'messstelle',
                      id: route.messstelleId,
                      standortId: page === 'standort' ? route.standortId : null,
                      periode: jetzt.periode,
                      version: jetzt.version,
                      vergleich: v,
                    })
                  : null;
                if (s) replaceCurrentNavigation(s.hash);
              }}
              onListe={() =>
                navigate(
                  page === 'standort' && route.standortId
                    ? standortMessstellenRoute(route.standortId)
                    : pageRoute('portfolio-messstellen'),
                )
              }
            />
          )}
          {page === 'standort' && standortOffen && !standortBereich && (
            <StandortUebersichtPage
              standort={standortOffen}
              sites={sites}
              onNavigate={navigate}
              onReload={(selectSiteId?: string) => void reload(selectSiteId)}
              isAdmin={isAdmin}
              betriebsart={betriebsart}
              einstiege={einstiegeHier}
            />
          )}
          {/* UEMS AP-13 IP-2: „Standort › Gebäude“ (Ortsbaum + Stand am) und „Standort › Anlagen“ (die Tabelle). */}
          {page === 'standort' && standortOffen && standortBereich === 'boxen' && (
            <StandortBoxenPage
              key={standortOffen.id}
              standort={standortOffen}
              sites={sites}
              devices={devices}
            />
          )}
          {page === 'standort' && standortOffen && standortBereich === 'gebaeude' && (
            <StandortGebaeudePage
              key={standortOffen.id}
              standort={standortOffen}
              onGeaendert={() => void reload()}
              onNavigate={navigate}
              springe={springe}
            />
          )}
          {page === 'standort' && standortOffen && standortBereich === 'netzanschluesse' && (
            <StandortNetzanschluessePage key={standortOffen.id} standort={standortOffen} onGeaendert={() => void reload()} />
          )}
          {page === 'standort' && standortOffen && standortBereich === 'anlagen' && (
            <StandortAnlagenPage
              standort={standortOffen}
              sites={sites}
              onNavigate={navigate}
              onReload={(selectSiteId?: string) => void reload(selectSiteId)}
              isAdmin={isAdmin}
              betriebsart={betriebsart}
            />
          )}
          {/* UEMS AP-13 IP-2 (Ü8): „Kennzahlen dieses Standorts“ und „Berichte dieses Standorts“ — Seite und Rückweg bleiben im Standort. */}
          {page === 'standort' && standortOffen && standortBereich === 'kennzahlen' && (
            <KennzahlenPage
              key={standortOffen.id}
              standort={{ id: standortOffen.id, name: standortOffen.name }}
              zone={standortOffen.zeitzone}
              kennzahlId={route.kennzahlId ?? null}
              onOeffnen={(id) => navigate(kennzahlRoute(id, standortOffen.id))}
              onListe={() => navigate(standortBereichRoute(standortOffen.id, 'kennzahlen'))}
            />
          )}
          {page === 'standort' && standortOffen && standortBereich === 'berichte' && (
            <BerichtePage
              key={standortOffen.id}
              standort={{ id: standortOffen.id, name: standortOffen.name }}
              kennung={route.berichtKennung ?? null}
              onOeffnen={(kennung) => navigate(berichtRoute(kennung, standortOffen.id))}
              onListe={() => navigate(standortBereichRoute(standortOffen.id, 'berichte'))}
            />
          )}
          {page === 'kunden-benutzer' && <BenutzerPage />}
          {page === 'portfolio-messwerte' && <PortfolioMesswerte sites={sites} />}
          {page === 'portfolio-erloese' && <PortfolioErloese sites={geldSites} />}
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
              devicesFetchedAt={devicesAt}
              route={route}
              onNavigate={navigate}
              onReload={(selectSiteId?: string) => void reload(selectSiteId)}
              isAdmin={isAdmin}
              onHealthFacts={onHealthFacts}
              surface={surface}
              // AP-13 IP-11 (E2 = A, O18): der EINE Weg „Messstellen dieser Anlage“ — nur, wenn der
              // Standort dieser Anlage misst. Sonst fragt das Cockpit nichts und zeigt nichts Neues.
              misstHier={route.siteId ? misstAnlage(ebenenLesemodell, route.siteId) : false}
              standortId={orte?.standorte.find((s) => s.anlagen.includes(shellSite?.id ?? ''))?.id ?? null}
            />
          )}
          {page === 'plattform-uebersicht' && isAdmin && (
            <PlattformUebersichtPage onJumpToTenant={jumpToTenant} onNavigate={navigate} />
          )}
          {page === 'mandanten' && isAdmin && (
            <MandantenPage
              tenants={tenants}
              onReloadTenants={reloadTenants}
              onJumpToTenant={jumpToTenant}
            />
          )}
          {isGeraeteBereich(page) && isAdmin && (
            <GeraeteBereich page={page} onNavigate={navigate} onJumpToTenant={jumpToTenant} />
          )}
          {page === 'optimizer' && isAdmin && <OptimizerPage tenants={tenants} />}
          {page === 'steuerungs-freigabe' && isAdmin && <SteuerungsFreigabePage />}
          {page === 'vorlagen' && isAdmin && <VorlagenPage />}
          {page === 'komponenten-flotte' && isAdmin && <KomponentenFlottePage />}
          {page === 'flows' && isAdmin && <FlowsPage tenants={tenants} />}
          </LazyBoundary>
        </>
      )}

      {/* The shell's "＋ Anlage hinzufügen" action opens the SAME one-flow
          drawer as everywhere else; on finish we reload and land the customer
          on their new Anlage. Always mounted so `open` alone drives it. */}
      <AnlageAnlegenDrawer
        open={addAnlageOpen}
        onClose={() => setAddAnlageOpen(false)}
        existingSites={sites}
        onChanged={(createdSiteId, ziel) => {
          void reload(createdSiteId);
          // Modus „nur messen“: auf die Messstellen statt auf die neue Anlage.
          navigate(ziel ?? anlageRoute(createdSiteId));
        }}
      />

      {messenZiel && (
        <LazyBoundary fallback={null}>
          <MessenAssistent
            standortId={messenZiel.standortId ?? null}
            schritt={messenZiel.schritt ?? null}
            onClose={() => {
              setMessenZiel(null);
              setMessenRunde((r) => r + 1);
              void reload();
            }}
          />
        </LazyBoundary>
      )}
    </AppShell>
    </MessenEinstiegKontext.Provider>
    </RechteStandort.Provider>
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
        <h3>Mandanten wählen</h3>
        <p>
          Diese Seite zeigt Kundendaten. Wählen Sie oben im Mandanten-Umschalter einen
          Mandanten (oder hier direkt), um dessen Ansicht zu sehen.
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
