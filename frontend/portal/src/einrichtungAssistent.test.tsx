import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Der Einrichtungs-Assistent im Portal (Anlage-Flow a1).
 *
 * B1: 30 s nach „Ihre Anlage ist verbunden“ stand „Noch keine Anlage“ - die Geräte-Abfrage fand die
 * eben verbundene Box, `showOnboarding` kippte und hängte den Assistenten aus (`belege/erstedaten-*`).
 * F6: „Später einrichten“ lebte nur im Speicher; nach jedem Neuladen kam der Assistent zurück.
 */
const { kunde, liste, geraete } = vi.hoisted(() => ({
  kunde: vi.fn(),
  liste: vi.fn(),
  geraete: vi.fn(),
}));

vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  isPlatformAdmin: () => false,
  currentRoles: () => [],
  currentUser: () => ({ name: 'Erika Kaiser', email: 'erika@beispiel.test', tenantId: 'kb-erika', roles: [] }),
  freshToken: async () => 'token',
}));

const ANLAGE = {
  id: 'anlage-1',
  name: 'Zuhause',
  biddingZone: 'DE-LU',
  latitude: 49.1,
  longitude: 10.7,
  plantKind: 'eigenverbrauch',
};

vi.mock('./api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('./api')>();
  const antworten: Record<string, (...a: unknown[]) => Promise<unknown>> = {
    selbstauskunft: () => kunde(),
    listSites: () => liste(),
    listDevices: () => geraete(),
    tenantContext: async () => ({ id: 'kb-erika', name: 'Erika Kaiser', segment: 'B2C', betriebsart: 'endkunde' }),
    standorte: async () => ({ stichtag: '2026-10-23', standorte: [] }),
    funktionen: async () => ({ standorte: [] }),
    // Die Anlage trägt schon Registerdaten (F6): es geht bei der Box weiter.
    siteAssets: async () => [{ id: 'pv', type: 'pv', registry: 'mastr', pvCapacityKwp: 6.05 }],
  };
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name: string) => antworten[name] ?? (() => Promise.reject(new Error(`nicht gemockt: ${name}`))),
  });
  return { ...echt, api };
});

import App from './App';

const KUNDE_ME = {
  kennung: 'erika',
  name: 'Erika Kaiser',
  konto: 'benutzer',
  zustand: 'aktiv',
  kundenbereich: 'kb-erika',
  zugang: null,
  rollen: ['kundenadministrator'],
  unternehmensweit: true,
  standorte: [],
  unternehmen_rechte: ['anlage.verwalten', 'geraet.einrichten', 'standort.verwalten'],
  kuenftig: [],
  text: null,
  teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] },
  kundenadministratoren: [],
  kundenbereiche: [],
};

const BOX = {
  id: 'box-1',
  siteId: 'anlage-1',
  externalRef: 'edge-k7m2xq3',
  kind: 'edge',
  name: null,
  status: 'claimed',
  lastSeenAt: null,
  createdAt: '2026-10-23T08:00:00Z',
};

describe('Einrichtungs-Assistent (B1, F6)', () => {
  beforeEach(() => {
    localStorage.clear();
    kunde.mockReset().mockResolvedValue(KUNDE_ME);
    liste.mockReset().mockResolvedValue({ eintraege: [ANLAGE], teilansicht: null });
    geraete.mockReset().mockResolvedValue({ eintraege: [], teilansicht: null });
  });
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  it('B1: die Geräte-Abfrage findet die verbundene Box - der Assistent bleibt stehen', async () => {
    render(<App initialAuth />);
    expect(await screen.findByRole('heading', { name: 'Willkommen bei VoltPilot' }, { timeout: 5000 })).toBeInTheDocument();
    // F6: Registerdaten sind da - weiter bei der Box, nicht wieder beim Register.
    expect(await screen.findByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'PV & Speicher aus dem Register' })).toBeNull();

    // Die Box ist verbunden; die nächste Geräte-Abfrage (alle 30 s, hier über die Rückkehr zum Tab) findet sie.
    geraete.mockResolvedValue({ eintraege: [BOX], teilansicht: null });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(geraete.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ihre VoltPilot-Box' })).toBeInTheDocument();
    expect(screen.queryByText('Noch keine Anlage')).toBeNull();
  });

  it('F6: „Später einrichten" gilt auch nach dem Neuladen - das Banner führt zurück', async () => {
    const { unmount } = render(<App initialAuth />);
    fireEvent.click(await screen.findByRole('button', { name: 'Später einrichten - direkt zum Portal' }, { timeout: 5000 }));
    unmount();

    render(<App initialAuth />);
    expect(await screen.findByRole('button', { name: 'Einrichtung fortsetzen' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Einrichtung fortsetzen' }));
    expect(await screen.findByRole('heading', { name: 'Willkommen bei VoltPilot' })).toBeInTheDocument();
    expect(localStorage.getItem('vp.einrichtung.spaeter.kb-erika')).toBeNull();
  });
});
