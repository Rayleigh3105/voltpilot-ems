import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

/**
 * Start der installierten App ohne Anlage in der Adresse (Welle 3, `startAnlage.ts`): die Schale merkt sich, wo ein
 * leerer Start landet, und der nächste leere Start fragt die Seitendaten dieser Anlage gleichzeitig mit `/me` an.
 * Navigation und Weiterleitung bleiben bei der Startweiche.
 */
const { selbstauskunft, listSites, listDevices, tenantContext, standorte, unternehmen, topology, overview, usageProfile } = vi.hoisted(() => ({
  selbstauskunft: vi.fn(),
  listSites: vi.fn(),
  listDevices: vi.fn(() => Promise.resolve({ eintraege: [], teilansicht: null })),
  tenantContext: vi.fn(() => Promise.resolve(null)),
  standorte: vi.fn(() => Promise.resolve({ stichtag: '2026-11-15', standorte: [] })),
  unternehmen: vi.fn(() => Promise.resolve(null)),
  topology: vi.fn(() => new Promise(() => {})),
  overview: vi.fn(() => new Promise(() => {})),
  usageProfile: vi.fn(() => new Promise(() => {})),
}));

vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  isPlatformAdmin: () => false,
  currentRoles: () => ['operator'],
  currentUser: () => ({ name: 'Erika Muster', email: 'erika@beispiel.test', tenantId: 'kb-1', roles: ['operator'] }),
  freshToken: async () => 'token',
}));

vi.mock('./api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('./api')>();
  const eigene: Record<string, unknown> = { selbstauskunft, listSites, listDevices, tenantContext, standorte, unternehmen, topology, overview, usageProfile };
  // Jeder andere Lesezugriff bleibt unterwegs: die Frage hier ist nur, WAS beim Start hinausgeht und wohin die Weiche führt.
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (typeof name === 'string' && name in eigene ? eigene[name] : () => new Promise(() => {})),
  });
  return { ...echt, api, vorabAbrufen: echt.vorabAbrufen };
});

import App from './App';
import { keycloak } from './auth';

const SCHLUESSEL = 'vp.startAnlage';

const ME = {
  kennung: 'p-1',
  name: 'Erika Muster',
  konto: 'kunde',
  zustand: 'aktiv',
  kundenbereich: 'kb-1',
  zugang: null,
  rollen: [],
  unternehmensweit: true,
  standorte: [],
  unternehmen_rechte: [],
  kuenftig: [],
  text: null,
  teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] },
  kundenadministratoren: [],
  kundenbereiche: [],
};

const anlage = (id: string) => ({
  id,
  name: `Anlage ${id}`,
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: true,
  maxFeedInKw: null,
});

describe('leerer Start: die Anlage des letzten leeren Starts vorab', { timeout: 20_000 }, () => {
  let meFrei: (wert: unknown) => void;

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    // Abrufe außerhalb von `api` (Flüsse, Verbraucher) bleiben unterwegs statt ins Netz zu gehen.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    (keycloak as { subject?: string }).subject = 'nutzer-1';
    selbstauskunft.mockReset().mockImplementation(() => new Promise((r) => { meFrei = r; }));
    listSites.mockReset().mockResolvedValue({ eintraege: [anlage('s-1')], teilansicht: null });
    topology.mockClear();
    overview.mockClear();
    usageProfile.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    (keycloak as { subject?: string }).subject = undefined;
    window.history.replaceState(null, '', '/');
  });

  it('ohne Gemerktes geht nichts vorab; ein Start, der auf der einzigen Anlage landet, merkt sie', async () => {
    render(<App initialAuth />);
    await vi.waitFor(() => expect(selbstauskunft).toHaveBeenCalled());
    expect(topology).not.toHaveBeenCalled();
    expect(usageProfile).not.toHaveBeenCalled();
    meFrei(ME);
    await vi.waitFor(() => expect(window.location.hash).toBe('#/anlage/s-1'), { timeout: 12_000 });
    expect(JSON.parse(localStorage.getItem(SCHLUESSEL)!)).toEqual({ nutzer: 'nutzer-1', bereich: null, anlage: 's-1' });
  });

  it('mit gemerkter Anlage gehen ihre Seitendaten hinaus, solange /me noch unterwegs ist', async () => {
    localStorage.setItem(SCHLUESSEL, JSON.stringify({ nutzer: 'nutzer-1', bereich: null, anlage: 's-1' }));
    render(<App initialAuth />);
    await vi.waitFor(() => expect(selbstauskunft).toHaveBeenCalled());
    expect(topology).toHaveBeenCalledWith('s-1');
    expect(usageProfile).toHaveBeenCalledWith('s-1');
    expect(overview).toHaveBeenCalled();
    // Nur vorab: die Adresse bleibt leer, bis die Weiche entscheidet.
    expect(window.location.hash).toBe('');
    meFrei(ME);
    await vi.waitFor(() => expect(window.location.hash).toBe('#/anlage/s-1'), { timeout: 12_000 });
  });

  it('ein anderer Nutzer bekommt keine Vorab-Abrufe für die Anlage des vorigen, und sie ist verworfen', async () => {
    localStorage.setItem(SCHLUESSEL, JSON.stringify({ nutzer: 'nutzer-0', bereich: null, anlage: 's-9' }));
    render(<App initialAuth />);
    await vi.waitFor(() => expect(selbstauskunft).toHaveBeenCalled());
    expect(topology).not.toHaveBeenCalled();
    expect(localStorage.getItem(SCHLUESSEL)).toBeNull();
    meFrei(ME);
  });

  it('eine nicht mehr erlaubte Anlage: Vorab geht hinaus, die Weiche führt trotzdem auf die erlaubte, und die merkt sie', async () => {
    localStorage.setItem(SCHLUESSEL, JSON.stringify({ nutzer: 'nutzer-1', bereich: null, anlage: 's-alt' }));
    render(<App initialAuth />);
    await vi.waitFor(() => expect(topology).toHaveBeenCalledWith('s-alt'));
    meFrei(ME);
    await vi.waitFor(() => expect(window.location.hash).toBe('#/anlage/s-1'), { timeout: 12_000 });
    expect(JSON.parse(localStorage.getItem(SCHLUESSEL)!).anlage).toBe('s-1');
  });

  it('ein leerer Start, der NICHT auf einer Anlage landet (mehrere Anlagen), vergisst die gemerkte', async () => {
    localStorage.setItem(SCHLUESSEL, JSON.stringify({ nutzer: 'nutzer-1', bereich: null, anlage: 's-1' }));
    listSites.mockResolvedValue({ eintraege: [anlage('s-1'), anlage('s-2')], teilansicht: null });
    render(<App initialAuth />);
    await vi.waitFor(() => expect(selbstauskunft).toHaveBeenCalled());
    meFrei(ME);
    await vi.waitFor(() => expect(localStorage.getItem(SCHLUESSEL)).toBeNull(), { timeout: 12_000 });
    expect(window.location.hash).not.toMatch(/^#\/anlage\//);
  });

  it('ein Start MIT Adresse ändert die gemerkte Anlage nicht und fragt nur nach seiner Adresse vorab', async () => {
    localStorage.setItem(SCHLUESSEL, JSON.stringify({ nutzer: 'nutzer-1', bereich: null, anlage: 's-1' }));
    listSites.mockResolvedValue({ eintraege: [anlage('s-1'), anlage('s-2')], teilansicht: null });
    window.history.replaceState(null, '', '/#/anlage/s-2');
    render(<App initialAuth />);
    await vi.waitFor(() => expect(topology).toHaveBeenCalledWith('s-2'));
    expect(topology).not.toHaveBeenCalledWith('s-1');
    meFrei(ME);
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse(localStorage.getItem(SCHLUESSEL)!).anlage).toBe('s-1');
  });
});
