import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Der Start lädt die Stammdaten GLEICHZEITIG mit `/me` (Performance-Runde vp-perf-portal-reaktiv): vorher stand vor
 * jedem ersten Bild eine ganze `/me`-Runde, bevor Anlagen, Geräte, Kontext und Orte überhaupt angefragt wurden.
 * Benutzt werden die Antworten erst nach `/me` - ein Konto ohne Standort sieht weiter „Kein Standort zugewiesen“,
 * auch wenn die vorab gestarteten Abrufe scheitern.
 */
const { selbstauskunft, listSites, listDevices, tenantContext, standorte } = vi.hoisted(() => ({
  selbstauskunft: vi.fn(),
  listSites: vi.fn(),
  listDevices: vi.fn(),
  tenantContext: vi.fn(),
  standorte: vi.fn(),
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
  const eigene: Record<string, unknown> = { selbstauskunft, listSites, listDevices, tenantContext, standorte };
  // Jeder andere Lesezugriff antwortet leer; die Frage hier ist nur die Reihenfolge des Starts.
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (typeof name === 'string' && name in eigene ? eigene[name] : () => Promise.resolve([])),
  });
  return { ...echt, api };
});

import App from './App';

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

describe('Start: Stammdaten gleichzeitig mit /me', () => {
  let meFrei: (wert: unknown) => void;

  beforeEach(() => {
    selbstauskunft.mockReset().mockImplementation(() => new Promise((r) => { meFrei = r; }));
    listSites.mockReset().mockResolvedValue({ eintraege: [], teilansicht: null });
    listDevices.mockReset().mockResolvedValue({ eintraege: [], teilansicht: null });
    tenantContext.mockReset().mockResolvedValue(null);
    standorte.mockReset().mockResolvedValue({ stichtag: '2026-11-13', standorte: [] });
  });
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  it('fragt Anlagen, Geräte, Kontext und Orte an, solange /me noch unterwegs ist', async () => {
    render(<App initialAuth />);
    await vi.waitFor(() => expect(selbstauskunft).toHaveBeenCalled());
    await vi.waitFor(() => expect(listSites).toHaveBeenCalled());
    expect(listDevices).toHaveBeenCalled();
    expect(tenantContext).toHaveBeenCalled();
    expect(standorte).toHaveBeenCalled();
    meFrei(ME);
  });

  it('ohne Standort verwirft er die vorab geholten Stammdaten still - auch deren Ablehnung', async () => {
    listSites.mockRejectedValue(new Error('403'));
    listDevices.mockRejectedValue(new Error('403'));
    render(<App initialAuth />);
    await vi.waitFor(() => expect(listSites).toHaveBeenCalled());
    meFrei({ ...ME, unternehmensweit: false, standorte: [], text: 'Bitte wenden Sie sich an Ihre Verwaltung.' });
    expect(await screen.findByRole('heading', { name: 'Kein Standort zugewiesen' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/API-Fehler|Unbekannter Fehler/)).toBeNull();
  });
});
