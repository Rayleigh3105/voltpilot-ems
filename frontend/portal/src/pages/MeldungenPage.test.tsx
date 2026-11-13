import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MeldungenPage } from './MeldungenPage';
import { meldungenApi } from '../meldungen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('MeldungenPage · Ladefehler', () => {
  it('zeigt einen Fehlerzustand mit „Erneut versuchen“ - nicht zugleich „Wird geladen …“', async () => {
    window.location.hash = '#/meldungen';
    const jetzt = vi.spyOn(meldungenApi, 'jetzt').mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce([]);
    render(<MeldungenPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Meldungen konnten nicht geladen werden.');
    expect(screen.queryByText('Wird geladen …')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Erneut versuchen/ }));
    await waitFor(() => expect(jetzt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('MeldungenPage · Text der Meldung (Kunden-Alarmierung P1)', () => {
  const box = (id: string, kennzeichen: string, ort: string) => ({
    id,
    kennzeichen,
    wertart: 'box.erreichbar',
    schwere: 'warnung' as const,
    anlageId: null,
    anlageName: ort,
    standortId: null,
    ausgeloestAm: '2026-11-13T11:33:00Z',
    zustand: 'aktiv' as const,
    wiederNormalAm: null,
    gesehenVon: null,
    gesehenAm: null,
    erledigtAm: null,
    bezugKennung: null,
    text: {
      wertart: 'box.erreichbar',
      herkunft: 'ab_werk',
      regelName: 'Box erreichbar',
      schwere: 'warnung',
      bezugArt: 'anlage',
      ort,
      bedingung: { art: 'zustand', ziel: ['nicht_erreichbar'], dauer_s: 900, erholen_s: 300 },
      wert: { zahl: null, einheit: null, zustand: 'nicht_erreichbar', satz: null },
      beginn: '2026-11-13T11:18:00Z',
      ende: null,
    },
  });

  it('zeigt Titel als Aussage und die Sätze - keinen Schlüssel, keinen Rohwert', async () => {
    window.location.hash = '#/meldungen';
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([box('a1', 'AL-2026-000002', 'Hof Lindenberg')]);
    render(<MeldungenPage />);
    expect(await screen.findByTestId('meldung-titel')).toHaveTextContent('Hof Lindenberg: Box meldet sich nicht');
    const text = screen.getByTestId('meldung-text');
    expect(text).toHaveTextContent('Meist ist das Internet oder der Strom an der Box unterbrochen.');
    expect(text.textContent).not.toMatch(/nicht_erreichbar|box\.erreichbar|\d{4}-\d{2}-\d{2}T/);
  });

  it('?meldung= hebt die gemeinte Meldung hervor und stellt sie nach vorn', async () => {
    window.location.hash = '#/meldungen?meldung=AL-2026-000009';
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([
      box('a1', 'AL-2026-000002', 'Hof Lindenberg'),
      box('a2', 'AL-2026-000009', 'Werk Lindach'),
    ]);
    render(<MeldungenPage />);
    const gemeint = await screen.findByTestId('meldung-gemeint');
    expect(gemeint).toHaveTextContent('Werk Lindach: Box meldet sich nicht');
    expect(screen.getAllByTestId('meldung-titel')[0]).toHaveTextContent('Werk Lindach');
  });

  it('?meldung= sucht eine nicht mehr offene Meldung im Verlauf', async () => {
    window.location.hash = '#/meldungen?meldung=a7';
    vi.spyOn(meldungenApi, 'jetzt').mockResolvedValue([]);
    const verlauf = vi.spyOn(meldungenApi, 'verlauf').mockResolvedValue([
      { ...box('a7', 'AL-2026-000007', 'Hof Lindenberg'), zustand: 'erledigt', wiederNormalAm: '2026-11-13T12:05:00Z',
        erledigtAm: '2026-11-13T12:05:00Z',
        text: { ...box('a7', '', 'Hof Lindenberg').text, ende: '2026-11-13T12:00:00Z' } },
    ]);
    render(<MeldungenPage />);
    await waitFor(() => expect(verlauf).toHaveBeenCalled());
    expect(await screen.findByTestId('meldung-entwarnung')).toHaveTextContent(
      'Die Unterbrechung dauerte 42 Minuten.',
    );
  });
});
