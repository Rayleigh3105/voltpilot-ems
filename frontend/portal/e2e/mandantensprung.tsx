import ReactDOM from 'react-dom/client';
import App from '../src/App';
import { keycloak } from '../src/auth';
import '../designsystem/tokens/fonts.css';
import '../designsystem/tokens/colors.css';
import '../designsystem/tokens/typography.css';
import '../designsystem/tokens/spacing.css';
import '../designsystem/tokens/effects.css';
import '../designsystem/components/core/core.css';
import '../designsystem/components/shell/shell.css';
import '../src/index.css';

// Der ganze `App` als Plattform-Administrator OHNE wirksame Unterstützung. Ersetzt sind nur die OIDC-Sitzung (wie in
// `boot-flow.tsx`) und der Server: `fetch` antwortet wie die API bei geschlossenem Mandanten-Umschalter (AP-03 IP-15) -
// `/api/v1/me` mit dem eigenen Konto allein, jede andere Kundenroute mit `X-Kundenbereich` 404. Die Köpfe wählt
// `api.ts` selbst. Alle Mandanten, Personen und Anlagen hier sind erfunden.
const sitzung = keycloak as unknown as { token: string; tokenParsed: unknown; updateToken: () => Promise<boolean> };
sitzung.token = 'e2e-token';
sitzung.tokenParsed = { name: 'Lena Voss', email: 'support-voss@voltpilot.local', realm_access: { roles: ['platform-admin'] } };
sitzung.updateToken = async () => false;

const MIT_STANDORT = 'a1000000-0000-4000-8000-000000000001';
const OHNE_STANDORT = 'a2000000-0000-4000-8000-000000000002';
// `?mandant=mit|ohne` merkt einen Mandanten vor, wie ihn der Umschalter über ein Neuladen hinweg hält.
const vorgemerkt = new URLSearchParams(window.location.search).get('mandant');
if (vorgemerkt) sessionStorage.setItem('vp-tenant-override', vorgemerkt === 'ohne' ? OHNE_STANDORT : MIT_STANDORT);

const mandant = (id: string, name: string, segment: string) => ({
  id, name, segment, plan: 'mvp', betriebsart: null, betriebsartEffective: null, createdAt: '2026-03-12T08:00:00Z',
});
const MANDANTEN = [mandant(MIT_STANDORT, 'Solarhof Beispiel', 'B2C'), mandant(OHNE_STANDORT, 'Musterwerk Nord GmbH', 'CI')];
const anlage = (id: string, name: string) => ({
  id, name, biddingZone: 'DE-LU', latitude: 48.137, longitude: 11.575, plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false,
});
const ANLAGEN: Record<string, unknown[]> = {
  [MIT_STANDORT]: [anlage('b1000000-0000-4000-8000-000000000001', 'Solarhof Dach')],
  [OHNE_STANDORT]: [anlage('b2000000-0000-4000-8000-000000000001', 'Halle Nord'), anlage('b2000000-0000-4000-8000-000000000002', 'Halle Süd')],
};
const BENUTZER: Record<string, unknown[]> = {
  [MIT_STANDORT]: [{ id: 'c1', username: 'erika', email: 'erika@solarhof-beispiel.example', firstName: 'Erika', lastName: 'Beispiel', enabled: true }],
  [OHNE_STANDORT]: [{ id: 'c2', username: 'max', email: 'max@musterwerk-nord.example', firstName: 'Max', lastName: 'Muster', enabled: true }],
};
const ME = {
  kennung: '101c18e6-d32f-4a45-a048-976e3fe51106', name: 'Lena Voss', konto: 'plattform', zustand: 'aktiv',
  kundenbereich: null, zugang: null, rollen: [], unternehmensweit: false, standorte: [], unternehmen_rechte: [],
  kuenftig: [], text: null, teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] },
  kundenadministratoren: [], kundenbereiche: [],
};
// Nur der Mandant mit genau einer Anlage hat seinen Standort bekommen (Bestandsübernahme); der mit zweien nicht.
const FLOTTE = { sites: [], releases: [], unterstuetzungBis: {},
  unterstuetzungStandorte: [{ id: 'd1000000-0000-4000-8000-000000000001', tenantId: MIT_STANDORT, name: 'Solarhof Dach' }] };

const json = (status: number, koerper?: unknown) =>
  new Response(koerper === undefined ? null : JSON.stringify(koerper), { status, headers: { 'Content-Type': 'application/json' } });
const echt = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (!url.pathname.startsWith('/api/v1/')) return echt(input, init);
  const pfad = url.pathname;
  if (pfad === '/api/v1/me') return json(200, ME);
  if (pfad === '/api/v1/admin/tenants') return json(200, MANDANTEN);
  if (pfad === '/api/v1/admin/fleet') return json(200, FLOTTE);
  const teil = /^\/api\/v1\/admin\/tenants\/([^/]+)\/(users|sites)$/.exec(pfad);
  if (teil) return json(200, (teil[2] === 'users' ? BENUTZER : ANLAGEN)[teil[1]] ?? []);
  if (pfad.startsWith('/api/v1/admin/')) return json(200, []);
  return new Headers(init?.headers).get('X-Kundenbereich') ? json(404) : json(200, []);
};

ReactDOM.createRoot(document.getElementById('root')!).render(<App initialAuth />);
