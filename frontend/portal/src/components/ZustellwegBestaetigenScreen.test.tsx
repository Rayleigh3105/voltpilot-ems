import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ZustellwegBestaetigenScreen } from './ZustellwegBestaetigenScreen';

/**
 * Die Seite hinter dem Link aus der Bestätigungs-Mail (§6.6) - sie ruft den
 * öffentlichen Endpunkt direkt über `fetch` auf (kein Auth-Mock nötig, wie
 * `apiZustellwegBestaetigen.test.ts`) und zeigt alle drei Ausgänge: bestätigt,
 * abgelaufen/ungültig/schon verwendet (ununterscheidbar, §6.6), Serverfehler.
 */
describe('ZustellwegBestaetigenScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bestätigt den Zustellweg und zeigt den Erfolg mit einem Weiter-Weg', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response)));
    render(<ZustellwegBestaetigenScreen token="abc123" />);

    expect(screen.getByText(/Wir bestätigen Ihre E-Mail-Adresse/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('E-Mail-Adresse bestätigt')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Weiter zum Meldungs-Center/ })).toBeInTheDocument();
  });

  it('zeigt einen ehrlichen, allgemeinen Fehler für einen ungültigen/abgelaufenen/schon verwendeten Token', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 410 } as Response)));
    render(<ZustellwegBestaetigenScreen token="irrelevant" />);

    await waitFor(() => expect(screen.getByText('Link nicht mehr gültig')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent(/ungültig, abgelaufen oder schon verwendet/);
    expect(screen.getByRole('button', { name: /Weiter zu VoltPilot/ })).toBeInTheDocument();
  });

  it('zeigt einen Wiederholen-Weg bei einem unerwarteten Serverfehler', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    render(<ZustellwegBestaetigenScreen token="abc" />);

    await waitFor(() => expect(screen.getByText('Das hat gerade nicht geklappt')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Erneut versuchen/ })).toBeInTheDocument();
  });
});
