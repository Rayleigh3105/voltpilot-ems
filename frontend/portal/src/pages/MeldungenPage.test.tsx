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
