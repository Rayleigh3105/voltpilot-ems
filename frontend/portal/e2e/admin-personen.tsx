/**
 * Kundenakte „Personen" mit den Wüstholz-Daten (Konzept vp-plattform-admin-box-benutzer-konzept,
 * Teil 2, Spec-Punkt 4): im Unterschied zu `mandanten-akte.tsx` sind die Admin-API-Stummel hier
 * ZUSTANDSBEHAFTET, damit die Spec Person hinzufügen (jede Rolle, mit/ohne Standorte, doppelte
 * E-Mail, doppelter Anmeldename), Bearbeiten, Umbenennen und Startpasswort wirklich durchspielen
 * kann - nicht nur das Formular öffnen.
 */
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { MandantenPage } from '../src/pages/admin/MandantenPage';
import { mandantHash } from '../src/nav';
import { adminApi, type AdminUser, type Tenant } from '../src/admin/adminApi';
import { benutzerApi, type BenutzerAnlage, type BenutzerEintrag } from '../src/benutzer';
import { fleetApi, type AdminFleetSite } from '../src/admin/fleetApi';
import { api, ApiError, type Site } from '../src/api';
import { keycloak } from '../src/auth';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

const now = Date.now();
const iso = (deltaMs: number) => new Date(now + deltaMs).toISOString();
const TENANT_ID = 't-wuestholz';

Object.assign(keycloak, {
  tokenParsed: { name: 'Moritz V.', email: 'moritz@voltpilot.test', realm_access: { roles: ['platform-admin'] } },
});

const tenant: Tenant = {
  id: TENANT_ID, name: 'Wüstholz Karl-Friedrich', segment: 'B2C', plan: 'basic',
  betriebsart: 'endkunde', betriebsartEffective: 'endkunde', createdAt: iso(-120 * 86_400_000),
};

function site(id: string, name: string): Site {
  return {
    id, name, biddingZone: 'DE-LU', latitude: null, longitude: null, plantKind: 'pv_storage',
    anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null,
  } as Site;
}
const sites: Site[] = [site('zuhause', 'Zuhause')];

let konten: AdminUser[] = [
  { id: 'kf', username: 'wuestholz', email: 'k.wuestholz@example.de', firstName: 'Karl-Friedrich',
    lastName: 'Wüstholz', enabled: true, tenantId: TENANT_ID },
];
let eintraege: BenutzerEintrag[] = [
  { sub: 'kf', anzeigename: 'Karl-Friedrich Wüstholz', email: 'k.wuestholz@example.de', zustand: 'aktiv',
    zuweisungen: [{ id: 'z-kf', rolle: 'kundenadministrator', standort_id: null, standort_name: null,
      gueltig_ab: iso(-120 * 86_400_000), gueltig_bis: null }] },
];
// Punkt 4 (Befund vp-kundenakte-fremde-personen): `?verwaist=1` legt eine Person OHNE Konto dazu
// (Spiegel da, Keycloak-Konto weg - eine halb gescheiterte Entfernung). Ihr einziger Weg ist
// „Löschen"; der Server räumt dann den Eintrag ab (deleteUser-Stummel unten filtert `eintraege`).
if (new URLSearchParams(window.location.search).get('verwaist') === '1') {
  eintraege = [...eintraege, { sub: 'verwaist-1', anzeigename: 'Verwaiste Person',
    email: 'verwaist@example.de', zustand: 'aktiv', zuweisungen: [] }];
}

let naechsteId = 1;
function neueSub(): string { return 'sub-' + naechsteId++; }
function startpasswort(): string { return 'E2E-Startpasswort-' + naechsteId; }

function konflikt(status: number, code: string, message: string): ApiError {
  return new ApiError(status, message, { code, message });
}

Object.assign(adminApi, {
  listUsers: async () => konten,
  listSites: async () => sites,
  personensuche: async () => [],
  createPerson: async (_tenantId: string, anlage: BenutzerAnlage) => {
    if (konten.some((k) => k.username === anlage.username)) {
      throw konflikt(409, 'anmeldename_vergeben', 'Dieser Anmeldename ist bereits vergeben.');
    }
    if (konten.some((k) => k.email === anlage.email)) {
      throw konflikt(409, 'email_vergeben', 'Diese E-Mail-Adresse ist bereits vergeben.');
    }
    if (!/^[a-z0-9._-]{3,64}$/.test(anlage.username)) {
      throw konflikt(400, 'anmeldename_ungueltig', 'Anmeldename: a-z, 0-9, Punkt, Bindestrich, Unterstrich; 3 bis 64 Zeichen.');
    }
    const sub = neueSub();
    const name = [anlage.vorname, anlage.nachname].filter(Boolean).join(' ') || anlage.username;
    konten = [...konten, { id: sub, username: anlage.username, email: anlage.email,
      firstName: anlage.vorname ?? null, lastName: anlage.nachname ?? null, enabled: true, tenantId: TENANT_ID }];
    eintraege = [...eintraege, { sub, anzeigename: name, email: anlage.email, zustand: 'angelegt',
      zuweisungen: [{ id: 'z-' + sub, rolle: anlage.rolle, standort_id: anlage.standorte[0] ?? null,
        standort_name: anlage.standorte[0] ? 'Zuhause' : null, gueltig_ab: iso(0), gueltig_bis: null }] }];
    return { benutzer: { sub, anzeigename: name, email: anlage.email, zustand: 'angelegt' }, startpasswort: startpasswort() };
  },
  updateUser: async (_tenantId: string, userId: string, input: { username?: string | null; email?: string | null; firstName?: string | null; lastName?: string | null }) => {
    if (input.username && konten.some((k) => k.id !== userId && k.username === input.username)) {
      throw konflikt(409, 'anmeldename_vergeben', 'Dieser Anmeldename ist bereits vergeben.');
    }
    if (input.username && !/^[a-z0-9._-]{3,64}$/.test(input.username)) {
      throw konflikt(400, 'anmeldename_ungueltig', 'Anmeldename: a-z, 0-9, Punkt, Bindestrich, Unterstrich; 3 bis 64 Zeichen.');
    }
    konten = konten.map((k) => k.id === userId ? { ...k,
      username: input.username || k.username, email: input.email ?? k.email,
      firstName: input.firstName ?? k.firstName, lastName: input.lastName ?? k.lastName } : k);
    const k = konten.find((x) => x.id === userId)!;
    const name = [k.firstName, k.lastName].filter(Boolean).join(' ') || k.username;
    eintraege = eintraege.map((e) => e.sub === userId ? { ...e, anzeigename: name, email: k.email ?? e.email } : e);
    return k;
  },
  resetPassword: async (_tenantId: string, userId: string) => {
    const k = konten.find((x) => x.id === userId)!;
    return { benutzer: { sub: userId, anzeigename: k.username, email: k.email ?? '', zustand: 'aktiv' },
      startpasswort: startpasswort() };
  },
  disableUser: async (_tenantId: string, userId: string) => {
    konten = konten.map((k) => k.id === userId ? { ...k, enabled: false } : k);
    return konten.find((k) => k.id === userId)!;
  },
  enableUser: async (_tenantId: string, userId: string) => {
    konten = konten.map((k) => k.id === userId ? { ...k, enabled: true } : k);
    return konten.find((k) => k.id === userId)!;
  },
  deleteUser: async (_tenantId: string, userId: string) => {
    konten = konten.filter((k) => k.id !== userId);
    eintraege = eintraege.filter((e) => e.sub !== userId);
  },
  // vp-kunde-sofort-loeschen: dieser Kunde hat Daten - kein Sofort-Weg in dieser Bühne.
  kundeLoeschbarkeit: async () => ({
    tenantId: TENANT_ID, sofortLoeschbar: false, daten: ['herzschlag', 'messwerte'], beendetAm: null,
    loeschungFruehestens: null, fristAbgelaufen: false,
    folgen: { anlagen: 1, boxen: [], personen: konten.length },
  }),
  kundenLoeschbarkeit: async () => [],
});
Object.assign(benutzerApi, { liste: async () => eintraege });
Object.assign(fleetApi, {
  fleet: async (): Promise<{ sites: AdminFleetSite[]; releases: []; unterstuetzungBis: Record<string, string>; unterstuetzungStandorte: { id: string; tenantId: string; name: string }[] }> => ({
    sites: [{
      siteId: 'zuhause', siteName: 'Zuhause', tenantId: TENANT_ID, tenantName: tenant.name,
      plantKind: 'pv_storage', netzladenErlaubt: false, tarifArt: 'ohne',
      deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: iso(-8_000),
      lastPlanGeneratedAt: iso(-600_000), hasStorage: true, batteryWithoutDevice: false,
      sources: null, edge: null, update: null, control: null, curtailment: null,
      kwp: { configuredKwp: 8, observedPeakKw: 7.6, buckets: 400, verdict: 'ok', reason: 'Plausibel.' },
      forecast: [], pflege: [], boxes: [],
    }],
    releases: [], unterstuetzungBis: {},
    unterstuetzungStandorte: sites.map((s) => ({ id: s.id, tenantId: TENANT_ID, name: s.name })),
  }),
});
Object.assign(api, { selbstauskunft: async () => ({ kundenbereich: { beendet: null } }) });

window.location.hash = mandantHash(TENANT_ID);

function Fixture() {
  return (
    <AppShell page="mandanten" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 1, devices: 1 }} tenants={[tenant]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <MandantenPage tenants={[tenant]} onReloadTenants={() => undefined} onJumpToTenant={() => undefined} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
