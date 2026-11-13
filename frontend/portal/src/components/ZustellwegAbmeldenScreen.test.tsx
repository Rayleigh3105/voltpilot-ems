import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ZustellwegAbmeldenScreen } from './ZustellwegAbmeldenScreen';

/**
 * „Abmelden" unter jeder Mail (Kunden-Alarmierung P2, KA-1 A): öffentlich, ohne Anmeldung - und erst auf den
 * Knopf. Ein Link-Prüfer, der die Seite nur lädt, darf niemanden abmelden.
 */
describe('ZustellwegAbmeldenScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('meldet beim Laden nicht ab, erst auf den Knopf - per POST mit dem Schlüssel, ohne Anmeldung', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 204 } as Response));
    vi.stubGlobal('fetch', fetchMock);
    render(<ZustellwegAbmeldenScreen token="abc123" />);

    expect(screen.getByText('Keine E-Mails mehr zu Meldungen?')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await waitFor(() => expect(screen.getByText('Abgemeldet')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/zustellwege/abmelden');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'abc123' });
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('sagt ehrlich, wenn der Link keinen Weg mehr kennt (410)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 410 } as Response)));
    render(<ZustellwegAbmeldenScreen token="weg" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));

    await waitFor(() => expect(screen.getByText('Link nicht mehr gültig')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Zu den Einstellungen' })).toBeInTheDocument();
  });

  it('bietet bei einem Serverfehler „Erneut versuchen"', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 } as Response)));
    render(<ZustellwegAbmeldenScreen token="abc" />);
    fireEvent.click(screen.getByRole('button', { name: 'Abmelden' }));

    await waitFor(() => expect(screen.getByText('Das hat gerade nicht geklappt')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });
});
