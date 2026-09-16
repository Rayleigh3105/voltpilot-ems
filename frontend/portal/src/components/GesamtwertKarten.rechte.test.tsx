import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, type Messstelle } from '../api';
import { ladeSiteGesamtwerte } from '../gesamtwertQuelle';
import { setSelbstauskunft } from '../rollen';
import { rechteSeed } from '../test/rollenFixtures';
import { GesamtwertKarten } from './GesamtwertKarten';

vi.mock('../gesamtwertQuelle', () => ({ ladeSiteGesamtwerte: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
function mount() {
  vi.mocked(ladeSiteGesamtwerte).mockResolvedValue([{ messstelle: {
    id: 'summe', kennzeichen: 'MS-0042', name: 'Produktion', art: 'berechnet', lebenszyklus: 'aktiv',
  } as Messstelle, formel: null }]);
  vi.spyOn(api, 'messstelleWert').mockResolvedValue({ wert: 213.5, einheit: 'kW', stand: '2026-10-20T08:15:00Z', unvollstaendig: false, fehlende: [] });
  return render(<GesamtwertKarten siteId="s1" version={0} onNeu={vi.fn()} />);
}
it('Leser sehen im Verlauf Werte und lesende Menüpunkte, keine Schreibhebel', async () => {
  setSelbstauskunft(rechteSeed('CB').me); mount();
  await screen.findByText('Produktion');
  expect(screen.queryByRole('button', { name: /Summenwert/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Aktionen/ }));
  for (const name of ['Umbenennen', 'Anhalten', 'Fortsetzen', 'Archivieren']) {
    expect(screen.queryByRole('menuitem', { name })).toBeNull();
  }
});
it('der Enter-Schreibweg eines geöffneten Namensfelds bleibt nach Rechteentzug gesperrt', async () => {
  const put = vi.spyOn(api, 'messstelleBearbeiten'); mount();
  await screen.findByText('Produktion');
  fireEvent.click(screen.getByRole('button', { name: /Aktionen/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Umbenennen' }));
  const name = screen.getByRole('textbox', { name: 'Name' });
  fireEvent.change(name, { target: { value: 'Neue Produktion' } });
  act(() => setSelbstauskunft(rechteSeed('CB').me));
  expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
  fireEvent.keyDown(name, { key: 'Enter' });
  expect(put).not.toHaveBeenCalled();
});
it('ein geöffneter Archivdialog schließt nach Rechteentzug ohne Anfrage', async () => {
  const archiv = vi.spyOn(api, 'messstelleArchivieren'); mount();
  await screen.findByText('Produktion');
  fireEvent.click(screen.getByRole('button', { name: /Aktionen/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Archivieren' }));
  expect(screen.getByRole('dialog')).toBeVisible();
  act(() => setSelbstauskunft(rechteSeed('CB').me));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(archiv).not.toHaveBeenCalled();
});
