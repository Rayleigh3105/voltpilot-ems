import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Plattform-Administrator › Mandanten › Mandant öffnen › „In Mandanten-Ansicht springen", OHNE Unterstützung.
// Gefälscht ist nur der Server (`fetch`); `api.ts` wählt die Köpfe selbst (auf Kundenrouten `X-Kundenbereich`).
// Seit dem 26.10.2026 ist der Mandanten-Umschalter wieder offen (Entscheidung des Betreibers): die API nimmt den
// Kundenbereich einer Plattform dann auch ohne Unterstützung an - `/api/v1/me` mit `zugang` „umschalter“, ganzer
// Kundenbereich (`unternehmensweit`), und die Kundenrouten antworten. Ist er aus (Not-Aus), antwortet sie wie von
// IP-15 bis dahin: `/api/v1/me` mit dem eigenen Konto allein, jede andere Kundenroute mit 404.
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  isPlatformAdmin: () => true,
  currentRoles: () => ['platform-admin'],
  currentUser: () => ({ name: 'Lena Voss', email: 'support-voss@voltpilot.local', tenantId: undefined, roles: ['platform-admin'] }),
  freshToken: async () => 'token',
}));

import App from './App';

const mandant = (id: string, name: string) => ({ id, name, segment: 'CI', plan: 'mvp',
  betriebsart: null, betriebsartEffective: 'betreiber', createdAt: '2026-01-01T00:00:00Z' });
const MIT_STANDORT = mandant('10000000-0000-0000-0000-000000000001', 'Nordwind Energie');
const OHNE_STANDORT = mandant('10000000-0000-0000-0000-000000000009', 'Musterwerk Süd GmbH');

const anlage = (id: string, name: string) => ({ id, name, biddingZone: 'DE-LU', latitude: 53.55, longitude: 9.99,
  plantKind: 'eigenverbrauch', anzulegenderWertCtKwh: null, tarifArt: 'ohne', tarifParamCtKwh: null, netzladenErlaubt: false });
const ANLAGEN: Record<string, unknown[]> = {
  [MIT_STANDORT.id]: [anlage('20000000-0000-0000-0000-000000000001', 'Nordwind Hamburg')],
  [OHNE_STANDORT.id]: [anlage('20000000-0000-0000-0000-000000000002', 'Halle Ost'),
    anlage('20000000-0000-0000-0000-000000000003', 'Halle West')],
};

const KONTO = {
  kennung: '101c18e6-d32f-4a45-a048-976e3fe51106', name: 'Lena Voss', konto: 'plattform', zustand: 'aktiv',
  rollen: [], unternehmen_rechte: [], kuenftig: [], text: null, teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: [], kundenbereiche: [],
};
/** Die Plattform ohne angenommenen Kundenbereich: ohne Kopf, oder am geschlossenen Umschalter. */
const NUR_KONTO = { ...KONTO, kundenbereich: null, zugang: null, unternehmensweit: false, standorte: [] };
/** Am offenen Umschalter: der ganze Kundenbereich (`ZugriffKontextLader`, Zugang `umschalter`). */
function amUmschalter(m: { id: string; name: string }) {
  return {
    ...KONTO, kundenbereich: { id: m.id, name: m.name, beendet: null }, zugang: 'umschalter', rollen: ['unterstuetzer'],
    unternehmensweit: true,
    standorte: m.id === MIT_STANDORT.id
      ? [{ id: '30000000-0000-0000-0000-000000000001', kennzeichen: 'ST-1', name: 'Nordwind Hamburg',
        rollen: ['unterstuetzer'], umfang: 'einrichten_und_bedienen', ocpp_stufe: 'PLATFORM', rechte: [] }]
      : [],
  };
}

let umschalterOffen = true;
const rufe: { pfad: string; kundenbereich: string | null; mandant: string | null }[] = [];

function antwort(status: number, koerper?: unknown): Response {
  return new Response(koerper === undefined ? null : JSON.stringify(koerper),
    { status, headers: { 'Content-Type': 'application/json' } });
}

function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const pfad = new URL(String(input)).pathname;
  const kopf = new Headers(init?.headers);
  const kundenbereich = kopf.get('X-Kundenbereich');
  rufe.push({ pfad, kundenbereich, mandant: kopf.get('X-Tenant-Id') });
  const gewaehlt = [MIT_STANDORT, OHNE_STANDORT].find((m) => m.id === kundenbereich);
  const angenommen = umschalterOffen && gewaehlt;
  if (pfad === '/api/v1/me') return Promise.resolve(antwort(200, angenommen ? amUmschalter(gewaehlt) : NUR_KONTO));
  if (pfad === '/api/v1/admin/tenants') return Promise.resolve(antwort(200, [MIT_STANDORT, OHNE_STANDORT]));
  if (pfad.startsWith('/api/v1/admin/')) return Promise.resolve(antwort(200, []));
  // Kundenroute: ohne Kopf leer wie bisher; mit Kopf am offenen Umschalter die Daten des Mandanten, sonst 404.
  if (!kundenbereich) return Promise.resolve(antwort(200, []));
  if (!angenommen) return Promise.resolve(antwort(404));
  // Anlagen und Geräte reisen als Liste mit Teilansicht (`SichtbareListe`); der ganze Kundenbereich ist sichtbar.
  const liste = (eintraege: unknown[]) => ({ eintraege, teilansicht: { sichtbar: 1, gesamt: 1 } });
  if (pfad === '/api/v1/sites') return Promise.resolve(antwort(200, liste(ANLAGEN[gewaehlt.id])));
  if (pfad === '/api/v1/devices') return Promise.resolve(antwort(200, liste([])));
  // Alles Weitere der Anlage (Wetter, Funktionen, Verlauf …) hat die Attrappe nicht: 404, wie eine fehlende Quelle.
  return Promise.resolve(antwort(404));
}

async function springe(m: { name: string }) {
  window.location.hash = '#/mandanten';
  render(<App initialAuth />);
  // Die Mandanten-Seite und ihr API-Modul werden nachgeladen - die erste Zeile braucht länger als die Vorgabe.
  fireEvent.click(await screen.findByRole('button', { name: `Details zu ${m.name}` }, { timeout: 15000 }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /In Mandanten-Ansicht springen/ }));
}

describe('Plattform springt ohne Unterstützung in die Mandanten-Ansicht', () => {
  beforeEach(() => {
    umschalterOffen = true;
    rufe.length = 0;
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(server));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
    window.location.hash = '';
  });

  it('landet in der Ansicht des Mandanten: seine Anlage, kein „Kein Zugriff“, kein „Kein Standort zugewiesen“', async () => {
    await springe(MIT_STANDORT);
    await vi.waitFor(() => expect(rufe.some((r) => r.pfad === '/api/v1/me' && r.kundenbereich === MIT_STANDORT.id)).toBe(true));
    // Die Ansicht des Kunden: seine Anlagen werden mit dem Kundenbereich gelesen und stehen da.
    expect(await screen.findByRole('heading', { name: 'Nordwind Hamburg' }, { timeout: 15000 })).toBeTruthy();
    expect(rufe.some((r) => r.pfad === '/api/v1/sites' && r.kundenbereich === MIT_STANDORT.id)).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Kein Standort zugewiesen' })).toBeNull();
    expect(sessionStorage.getItem('vp-tenant-override')).toBe(MIT_STANDORT.id);
  }, 40000);

  it('auch ein Mandant ohne Standort öffnet sich: zwei Anlagen, also sein Portfolio wie beim Kunden selbst', async () => {
    await springe(OHNE_STANDORT);
    await vi.waitFor(() => expect(rufe.some((r) => r.pfad === '/api/v1/sites' && r.kundenbereich === OHNE_STANDORT.id)).toBe(true));
    // Ohne Standort ist /me unternehmensweit leer - das Portal liest die Anlagen trotzdem und landet, wie für den
    // Kunden mit mehreren Anlagen, im Portfolio. (Dessen Zahlen hat die Attrappe nicht; es geht um den Weg hinein.)
    expect(await screen.findByRole('heading', { name: 'Portfolio' }, { timeout: 15000 })).toBeTruthy();
    expect(window.location.hash).toBe('#/portfolio');
    expect(screen.queryByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Kein Standort zugewiesen' })).toBeNull();
    expect(screen.queryByText('Mandanten wählen')).toBeNull();
  }, 40000);

  it('Not-Aus (Umschalter aus): die Karte nennt Grund und Weg statt „Kein Standort zugewiesen“', async () => {
    umschalterOffen = false;
    await springe(MIT_STANDORT);
    await vi.waitFor(() => expect(rufe.some((r) => r.pfad === '/api/v1/me' && r.kundenbereich === MIT_STANDORT.id)).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' }, { timeout: 15000 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Kein Standort zugewiesen' })).toBeNull();
    expect(screen.getByText(/in dieser Umgebung abgeschaltet/)).toBeTruthy();
    expect(screen.getByText(/„Unterstützung anfragen“ oder „Notfall-Zugriff“/)).toBeTruthy();

    // Der Weg zurück verlässt den Mandanten wieder: kein Kopf mehr, die Mandanten-Seite steht.
    fireEvent.click(screen.getByRole('button', { name: 'Zu den Mandanten' }));
    expect(await screen.findByRole('button', { name: `Details zu ${MIT_STANDORT.name}` }, { timeout: 15000 })).toBeTruthy();
    expect(sessionStorage.getItem('vp-tenant-override')).toBeNull();
  }, 40000);

  it('die Mandanten-Wahl verspricht die Ansicht wieder ohne Bedingung', async () => {
    window.location.hash = '#/uebersicht';
    render(<App initialAuth />);
    expect(await screen.findByRole('heading', { name: 'Mandanten wählen' }, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/Mandanten \(oder hier direkt\), um dessen Ansicht zu sehen/)).toBeTruthy();
    expect(screen.queryByText(/Unterstützung oder einen Notfall-Zugriff/)).toBeNull();
  }, 40000);
});
