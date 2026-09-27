import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Ein Plattform-Konto (VoltPilot-Betrieb) hat laut /me keinen Standort: konto „plattform“, standorte [],
// nicht unternehmensweit. Die Plattform-Seiten brauchen keinen - sie dürfen nicht hinter
// „Kein Standort zugewiesen“ verschwinden (gefunden in der lokalen Demo-Umgebung, 27.09.2026).
const { selbstauskunft } = vi.hoisted(() => ({
  selbstauskunft: vi.fn(),
}));

vi.mock('./auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth')>()),
  isPlatformAdmin: () => true,
  currentRoles: () => ['platform-admin'],
  currentUser: () => ({ name: 'Lena Voss', email: 'support-voss@voltpilot.local', tenantId: undefined, roles: ['platform-admin'] }),
  freshToken: async () => 'token',
}));

vi.mock('./api', async (importOriginal) => {
  const echt = await importOriginal<typeof import('./api')>();
  // Jeder andere Lesezugriff antwortet leer; die Frage hier ist nur, welcher Zweig die Seite trägt.
  const api = new Proxy(echt.api as Record<string, unknown>, {
    get: (_ziel, name) => (name === 'selbstauskunft' ? selbstauskunft : () => Promise.resolve([])),
  });
  return { ...echt, api };
});

import App from './App';

const PLATTFORM_ME = {
  kennung: '101c18e6-d32f-4a45-a048-976e3fe51106',
  name: 'Lena Voss',
  konto: 'plattform',
  zustand: 'aktiv',
  kundenbereich: null,
  zugang: null,
  rollen: [],
  unternehmensweit: false,
  standorte: [],
  unternehmen_rechte: [],
  kuenftig: [],
  text: null,
  teilansicht: null,
  unterstuetzungen: { eigene: [], gewaehrte: [] },
  kundenadministratoren: [],
  kundenbereiche: [],
};

describe('Plattform-Konto ohne Standort', () => {
  beforeEach(() => {
    selbstauskunft.mockReset().mockResolvedValue(PLATTFORM_ME);
  });
  afterEach(() => {
    cleanup();
    window.location.hash = '';
  });

  for (const [hash, titel] of [
    ['#/mandanten', 'Mandanten'],
    ['#/plattform-uebersicht', 'Plattform-Übersicht'],
  ] as const) {
    it(`${hash} zeigt die Plattform-Seite, nicht „Kein Standort zugewiesen“`, async () => {
      window.location.hash = hash;
      render(<App initialAuth />);
      await vi.waitFor(() => expect(selbstauskunft).toHaveBeenCalled());
      expect(await screen.findAllByText(titel)).not.toHaveLength(0);
      // /me ist da - der Zweig „Kein Standort zugewiesen“ hätte jetzt gegriffen.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole('heading', { name: 'Kein Standort zugewiesen' })).toBeNull();
    });
  }
});
