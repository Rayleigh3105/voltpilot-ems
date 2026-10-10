import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Plattform-Administrator › Mandanten › Mandant öffnen › „In Mandanten-Ansicht springen", OHNE wirksame Unterstützung.
// Gefälscht ist nur der Server (`fetch`); `api.ts` wählt die Köpfe selbst. Die Antworten sind die der API bei
// geschlossenem Mandanten-Umschalter (AP-03 IP-15, gemessen am Stand 99944c896): `/api/v1/me` antwortet mit dem
// eigenen Konto allein (kundenbereich null, standorte leer), jede andere Kundenroute mit 404.
vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  isPlatformAdmin: () => true,
  currentRoles: () => ['platform-admin'],
  currentUser: () => ({ name: 'Lena Voss', email: 'support-voss@voltpilot.local', tenantId: undefined, roles: ['platform-admin'] }),
  freshToken: async () => 'token',
}));

import App from './App';

const MANDANT = { id: '10000000-0000-0000-0000-000000000001', name: 'Nordwind Energie', segment: 'CI', plan: 'mvp',
  betriebsart: null, betriebsartEffective: 'betreiber', createdAt: '2026-01-01T00:00:00Z' };

const PLATTFORM_ME = {
  kennung: '101c18e6-d32f-4a45-a048-976e3fe51106', name: 'Lena Voss', konto: 'plattform', zustand: 'aktiv',
  kundenbereich: null, zugang: null, rollen: [], unternehmensweit: false, standorte: [], unternehmen_rechte: [],
  kuenftig: [], text: null, teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] },
  kundenadministratoren: [], kundenbereiche: [],
};

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
  if (pfad === '/api/v1/me') return Promise.resolve(antwort(200, PLATTFORM_ME));
  if (pfad === '/api/v1/admin/tenants') return Promise.resolve(antwort(200, [MANDANT]));
  if (pfad.startsWith('/api/v1/admin/')) return Promise.resolve(antwort(200, []));
  // Kundenroute: ohne wirksame Unterstützung 404 (ZugriffFilter), ohne Kopf leer wie bisher.
  return Promise.resolve(kundenbereich ? antwort(404) : antwort(200, []));
}

describe('Plattform springt ohne wirksame Unterstützung in die Mandanten-Ansicht', () => {
  beforeEach(() => {
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

  it('nennt den Grund und den Weg statt „Kein Standort zugewiesen“', async () => {
    window.location.hash = '#/mandanten';
    render(<App initialAuth />);
    // Die Mandanten-Seite und ihr API-Modul werden nachgeladen - die erste Zeile braucht länger als die Vorgabe.
    fireEvent.click(await screen.findByRole('button', { name: `Details zu ${MANDANT.name}` }, { timeout: 15000 }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /In Mandanten-Ansicht springen/ }));

    // Der Sprung fragt /me mit dem Kundenbereich des Mandanten.
    await vi.waitFor(() => expect(rufe.some((r) => r.pfad === '/api/v1/me' && r.kundenbereich === MANDANT.id)).toBe(true));
    expect(await screen.findByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' }, { timeout: 15000 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Kein Standort zugewiesen' })).toBeNull();
    expect(screen.getByText(/„Unterstützung anfragen“ oder\s+„Notfall-Zugriff“/)).toBeTruthy();

    // Der Weg zurück verlässt den Mandanten wieder: kein Kopf mehr, die Mandanten-Seite steht.
    fireEvent.click(screen.getByRole('button', { name: 'Zu den Mandanten' }));
    expect(await screen.findByRole('button', { name: `Details zu ${MANDANT.name}` }, { timeout: 15000 })).toBeTruthy();
    expect(sessionStorage.getItem('vp-tenant-override')).toBeNull();
  }, 40000);

  it('die Mandanten-Wahl verspricht die Ansicht nicht mehr ohne Bedingung', async () => {
    window.location.hash = '#/uebersicht';
    render(<App initialAuth />);
    expect(await screen.findByRole('heading', { name: 'Mandanten wählen' }, { timeout: 15000 })).toBeTruthy();
    expect(screen.getByText(/öffnet sich nur, wenn Sie dort eine\s+bestätigte Unterstützung oder einen Notfall-Zugriff haben/)).toBeTruthy();
  }, 40000);
});
