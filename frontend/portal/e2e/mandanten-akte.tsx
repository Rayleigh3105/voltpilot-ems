/**
 * Die Kundenakte (Raum „Benutzer") mit fiktiven Daten, reich befüllt: mehrere
 * Personen, zwei Anlagen mit Boxen, ein aktiver Vertrag - der Mobil-Durchgang
 * (`vp-adminview-mobile-rework`) braucht den WORST CASE, nicht den Leerlauf,
 * um echtes Scroll-Verhalten am Telefon zu sehen. Öffnet direkt die Akte
 * (per Hash), `?vertrag=beendet` zeigt den beendeten Vertrag.
 */
import ReactDOM from 'react-dom/client';
import { AppShell } from '../src/shell/AppShell';
import { MandantenPage } from '../src/pages/admin/MandantenPage';
import { mandantHash } from '../src/nav';
import { adminApi, type AdminUser, type Tenant } from '../src/admin/adminApi';
import { benutzerApi } from '../src/benutzer';
import { fleetApi, type AdminFleetSite } from '../src/admin/fleetApi';
import { api, type Site } from '../src/api';
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
const TENANT_ID = 't1';
const beendet = new URLSearchParams(window.location.search).get('vertrag') === 'beendet';
// vp-kunde-sofort-loeschen-mit-daten: `?loeschbar=sofort` spielt den datenfreien Kunden; jeder Kunde
// ist ohnehin sofort löschbar, der Parameter wählt nur, was der Dialog an Daten zeigt.
const sofort = new URLSearchParams(window.location.search).get('loeschbar') === 'sofort';

Object.assign(keycloak, {
  tokenParsed: { name: 'Alex Beispiel', email: 'alex@example.test', realm_access: { roles: ['platform-admin'] } },
});

const tenant: Tenant = {
  id: TENANT_ID, name: 'Kunststoffwerk Ahrenberg GmbH', segment: 'gewerbe', plan: 'pro',
  betriebsart: 'betreiber', betriebsartEffective: 'betreiber', createdAt: iso(-400 * 86_400_000),
};

function person(i: number, over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: `u${i}`, username: `person${i}`, email: `person${i}@ahrenberg.example.test`,
    firstName: ['Jana', 'Tom', 'Mira', 'Felix'][i % 4], lastName: ['Ahrens', 'Berger', 'Clasen', 'Diekmann'][i % 4],
    enabled: i !== 3, tenantId: TENANT_ID, ...over,
  };
}
const konten: AdminUser[] = [person(0), person(1), person(2), person(3, { enabled: false })];

function site(id: string, name: string): Site {
  return {
    id, name, biddingZone: 'DE-LU', latitude: null, longitude: null, plantKind: 'pv_storage',
    anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false, maxFeedInKw: null,
  } as Site;
}
const sites: Site[] = [site('s1', 'Werk Nord'), site('s2', 'Halle Süd')];

// Punkt 7 (vp-kundenakte-fremde-personen): eine GEMELDETE Box (nicht lösbar, der Dialog erklärt)
// und eine NIE gemeldete (lösbar). `geraeteLoesen` nimmt die Box aus der Flotte - der Reload
// der Akte zeigt sie dann nicht mehr.
let werkNordBoxen = [
  { deviceId: 'b1', externalRef: 'VP-AA11', name: 'Box Halle A', fuehrtAnlage: true,
    lastSeenAt: iso(-8_000), herzschlagAm: iso(-8_000), messwertAm: iso(-12_000), edge: null, update: null },
  { deviceId: 'b2', externalRef: 'VP-BB22', name: 'Box Halle B', fuehrtAnlage: false,
    lastSeenAt: null, herzschlagAm: null, messwertAm: null, edge: null, update: null },
];

const fleetSites: AdminFleetSite[] = [
  {
    siteId: 's1', siteName: 'Werk Nord', tenantId: TENANT_ID, tenantName: tenant.name,
    plantKind: 'pv_storage', netzladenErlaubt: true, tarifArt: 'börse',
    deviceCount: 2, onlineCount: 2, waitingCount: 0, worstStatus: 'online', lastSeenAt: iso(-8_000),
    lastPlanGeneratedAt: iso(-600_000), hasStorage: true, batteryWithoutDevice: false,
    sources: null, edge: null, update: null, control: null, curtailment: null,
    kwp: { configuredKwp: 420, observedPeakKw: 402, buckets: 1200, verdict: 'ok', reason: 'Plausibel.' },
    forecast: [], pflege: [], boxes: [],
  },
  {
    siteId: 's2', siteName: 'Halle Süd', tenantId: TENANT_ID, tenantName: tenant.name,
    plantKind: 'eigenverbrauch', netzladenErlaubt: false, tarifArt: 'fest',
    deviceCount: 0, onlineCount: 0, waitingCount: 0, worstStatus: 'stale', lastSeenAt: null,
    lastPlanGeneratedAt: null, hasStorage: false, batteryWithoutDevice: false,
    sources: null, edge: null, update: null, control: null, curtailment: null,
    kwp: { configuredKwp: null, observedPeakKw: null, buckets: 0, verdict: 'unbekannt', reason: '' },
    forecast: [], pflege: [], boxes: [],
  },
];

Object.assign(adminApi, {
  listUsers: async () => konten,
  listSites: async () => sites,
  personensuche: async () => [],
  geraeteLoesenBefund: async (ref: string) => (ref === 'VP-BB22'
    ? { loesbar: true, gruende: [],
        fakten: { verbundenAm: iso(-3 * 86_400_000), herzschlagAm: null, messwertAm: null, meldungAm: null,
          anmeldung: { zuletztAngefragtAm: null, schluesselAbgeholtAm: null } } }
    : { loesbar: false, gruende: ['herzschlag', 'messwerte'],
        fakten: { verbundenAm: iso(-30 * 86_400_000), herzschlagAm: iso(-8_000), messwertAm: iso(-12_000),
          meldungAm: null, anmeldung: { zuletztAngefragtAm: null, schluesselAbgeholtAm: iso(-30 * 86_400_000) } } }),
  geraeteLoesen: async (ref: string) => {
    werkNordBoxen = werkNordBoxen.filter((b) => b.externalRef !== ref);
    return { externalRef: ref, anlass: 'falsche_kennung' };
  },
  // vp-admin-box-ausbauen: die gemeldete Box (VP-AA11) ist ausbaubar (kein verbund-/zustaendigkeit-
  // Grund) - der Dialog bietet hier „Box ausbauen" statt der reinen Erklärung. Die Kundenakte
  // reicht kein `onAusgebaut` durch, bleibt also beim einfachen Neuladen (Box bleibt in der Liste,
  // wie bei der echten Geräteakte).
  geraeteAusbauen: async (ref: string) => ({
    externalRef: ref, deviceId: 'b1', ausgebautAm: iso(0), anlass: 'falsche_kennung', bereitsAusgebaut: false,
  }),
  // vp-kunde-sofort-loeschen-mit-daten: die Datenauskunft der Akte; ohne `?loeschbar=sofort` hat der Kunde Daten.
  kundeLoeschbarkeit: async () => ({
    tenantId: TENANT_ID,
    daten: sofort ? [] : ['herzschlag', 'messwerte'],
    beendetAm: beendet ? '2026-10-01' : null,
    folgen: { anlagen: sites.length, boxen: ['VP-BB22'], personen: konten.length },
  }),
  deleteTenant: async (_tenantId: string, confirmName: string) => ({
    tenantId: TENANT_ID, tenantName: confirmName, deletedSites: sites.length, deletedDevices: 1,
    deletedTelemetryRows: 0, deletedUsers: konten.map((k) => k.username), failedUsers: [],
    anlass: sofort ? 'sofort_keine_daten' : 'sofort_mit_daten', freigegebeneBoxen: ['VP-BB22'],
  }),
});
Object.assign(benutzerApi, { liste: async () => [] });
Object.assign(fleetApi, {
  fleet: async () => ({
    sites: fleetSites.map((s) => (s.siteId === 's1'
      ? { ...s, boxes: werkNordBoxen, deviceCount: werkNordBoxen.length }
      : s)),
    releases: [], unterstuetzungBis: {},
    unterstuetzungStandorte: sites.map((s) => ({ id: s.id, tenantId: TENANT_ID, name: s.name })),
  }),
});
Object.assign(api, {
  selbstauskunft: async () => ({
    kundenbereich: beendet
      ? { beendet: { beendet_am: '2026-10-01' } }
      : { beendet: null },
  }),
});

window.location.hash = mandantHash(TENANT_ID);

function Fixture() {
  return (
    <AppShell page="mandanten" onNavigate={() => undefined} isAdmin showOverview={false}
      showAddAnlage={false} counts={{ sites: 2, devices: 2 }} tenants={[tenant]} tenantOverride={null}
      onTenantChange={() => undefined}>
      <MandantenPage tenants={[tenant]} onReloadTenants={() => undefined} onJumpToTenant={() => undefined} />
    </AppShell>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />);
