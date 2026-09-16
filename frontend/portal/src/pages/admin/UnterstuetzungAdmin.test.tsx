import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { UnterstuetzungAdmin } from './UnterstuetzungAdmin';
import { isPlatformAdmin } from '../../auth';
import { request } from '../../api';
import { fleetApi } from '../../admin/fleetApi';
import { notfallFixture } from '../../test/unterstuetzungFixtures';
vi.mock('../../auth', () => ({ isPlatformAdmin: vi.fn(() => true) }));
vi.mock('../../api', async original => ({ ...await original<typeof import('../../api')>(), request: vi.fn() }));
vi.mock('../../admin/fleetApi', () => ({ fleetApi: { fleet: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(isPlatformAdmin).mockReturnValue(true);
  vi.mocked(fleetApi.fleet).mockResolvedValue({ sites: [], releases: [], unterstuetzungStandorte: [
    { id: 'st1', tenantId: 'kunde', name: 'Werk Ahrenberg' }, { id: 'fremd', tenantId: 'anderer-kunde', name: 'Fremder Standort' },
  ] });
});
it('Notfall: Standort und Grund Pflicht; 24 Stunden kommen vom Server, keine erfundene E-Mail', async () => {
  vi.mocked(request).mockResolvedValue(notfallFixture());
  render(<UnterstuetzungAdmin tenantId="kunde" name="Kunststoffwerk Ahrenberg GmbH" />);
  fireEvent.click(screen.getByRole('button', { name: 'Notfall-Zugriff', exact: true }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Notfall-Zugriff gewähren' }));
  expect(within(dialog).getByRole('alert')).toHaveTextContent('Wählen Sie mindestens einen Standort.');
  await waitFor(() => expect(fleetApi.fleet).toHaveBeenCalled());
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Standorte' }));
  expect(screen.queryByRole('option', { name: 'Fremder Standort' })).toBeNull();
  fireEvent.click(await screen.findByRole('option', { name: 'Werk Ahrenberg' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Notfall-Zugriff gewähren' }));
  expect(within(dialog).getByLabelText('Grund (Pflicht)')).toHaveFocus(); expect(request).not.toHaveBeenCalled();
  expect(dialog).toHaveTextContent('genau 24 Stunden'); expect(dialog).toHaveTextContent('nur bei eingerichtetem E-Mail-Versand');
  fireEvent.change(within(dialog).getByLabelText('Grund (Pflicht)'), { target: { value: 'Fehler F42' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Notfall-Zugriff gewähren' }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  const [url, init] = vi.mocked(request).mock.calls[0];
  expect(url).toBe('/api/v1/admin/tenants/kunde/unterstuetzung/notfall');
  expect(JSON.parse(init!.body as string)).toEqual({ standorte: ['st1'], umfang: 'einrichten_und_bedienen', grund: 'Fehler F42' });
});
it('Kundenkonten erhalten keine Plattformaktionen', () => {
  vi.mocked(isPlatformAdmin).mockReturnValue(false); render(<UnterstuetzungAdmin tenantId="kunde" name="Ahrenberg" />);
  expect(screen.queryByRole('button')).toBeNull(); expect(fleetApi.fleet).not.toHaveBeenCalled();
});
